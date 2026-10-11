/**
 * oc-media — an OpenCode V2 plugin.
 *
 * Makes the native `read` tool able to ingest audio and video files, driven
 * live by each model's real input modalities (the catalog OpenCode derives
 * from models.dev), and rewrites the Read description per dispatch so it
 * only ever claims what the current model can ingest.
 *
 * What stays native: every non-media read — text files, images, PDFs,
 * missing files, directories, unknown binaries, external-directory
 * permission flows — is executed by the original tool via delegation.
 */
import { Plugin } from "@opencode/plugin"
import path from "node:path"
import type { ModelInfoLike, ModelRefLike } from "./capabilities.js"
import { CapabilityCache } from "./capabilities.js"
import { createWrappedRead } from "./wrapper.js"
import { resolveOptions } from "./options.js"
import { describeReadTool } from "./describe.js"

type Registration = { readonly dispose: () => void | Promise<void> }

interface SessionEventLike {
  readonly sessionID: string
  readonly model: ModelRefLike
  readonly tools?: Record<string, { description: string }>
}

const MAX_TRACKED_SESSIONS = 512
const HOOK_KINDS = ["context", "generate", "compaction"] as const

export default Plugin.define({
  id: "oc-media",
  setup: async (ctx) => {
    const options = resolveOptions(ctx.options)
    const capabilities = new CapabilityCache(async () => {
      const listing = await ctx.model.list()
      return listing.data as readonly ModelInfoLike[]
    })

    const directory = ctx.location.directory
    const worktree = path.resolve(ctx.location.project.directory)

    // ---- Model tracking (session -> current model ref) -------------------
    // The session hooks run immediately before every model dispatch, so the
    // map is fresh for any tool call issued in the same agent loop.
    const sessionModels = new Map<string, ModelRefLike>()
    const trackSession = (sessionID: string, ref: ModelRefLike): void => {
      if (sessionModels.size >= MAX_TRACKED_SESSIONS) {
        const oldest = sessionModels.keys().next()
        if (!oldest.done) sessionModels.delete(oldest.value)
      }
      sessionModels.set(sessionID, ref)
    }

    // Fallback when no hook has run for a session yet (e.g. after a reload).
    const sessionModel = async (sessionID: string): Promise<ModelRefLike | undefined> => {
      if (sessionModels.has(sessionID)) return sessionModels.get(sessionID)
      try {
        const session = await ctx.session.get({ sessionID })
        const model = session.model
        if (model) sessionModels.set(sessionID, model)
        return model ?? undefined
      } catch {
        return undefined
      }
    }

    const wrappedRead = createWrappedRead({
      options,
      directory,
      worktree,
      capabilities,
      sessionModel,
    })

    let baseDescription: string | undefined
    const registrations: Registration[] = []

    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.update("read", (tool) => {
          baseDescription = tool.description
          const native = tool.execute
          tool.execute = ((input: unknown, context: unknown) =>
            wrappedRead(input, context as { readonly sessionID: string }, native as never)) as unknown as typeof tool.execute
        })
      }),
    )

    if (baseDescription === undefined) {
      console.warn(
        "[oc-media] the native 'read' tool was not found in this OpenCode's tool registry; plugin disabled itself",
      )
      return cleanupTo(registrations)
    }
    const base = baseDescription

    for (const kind of HOOK_KINDS) {
      registrations.push(
        await ctx.session.hook(kind, async (event) => {
          const ref = event.model
          if (ref && typeof ref.providerID === "string" && typeof ref.id === "string") {
            trackSession(event.sessionID, ref)
          }
          const read = event.tools?.read
          if (!read || typeof read.description !== "string") return
          const caps = await capabilities.for(ref)
          read.description = describeReadTool(base, caps, options)
        }),
      )
    }

    return cleanupTo(registrations)
  },
})

async function cleanupTo(registrations: ReadonlyArray<Registration>): Promise<void> {
  for (const registration of registrations) {
    try {
      await registration.dispose()
    } catch (error) {
      console.warn("[oc-media] failed to dispose a registration", error)
    }
  }
}
