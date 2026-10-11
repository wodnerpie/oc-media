/**
 * oc-media — an OpenCode V2 plugin.
 *
 * Makes the native `read` tool able to ingest audio and video files, driven
 * live by each model's real input modalities (the catalog OpenCode derives
 * from models.dev), and rewrites the Read description per dispatch so it
 * only ever claims what the current model can ingest.
 *
 * What stays native: every non-media read — text files, images, PDFs, missing
 * files, directories, unknown binaries, external-directory permission flows —
 * is executed by the original tool via delegation.
 */
import { Plugin } from "@opencode/plugin"
import path from "node:path"
import { CapabilityCache } from "./capabilities.ts"
import { createWrappedRead } from "./wrapper.ts"
import { resolveOptions } from "./options.ts"
import { describeReadTool } from "./describe.ts"
import type { ModelInfoLike, ModelRefLike } from "./capabilities.ts"

type Registration = { readonly dispose: () => Promise<unknown> }

const MAX_TRACKED_SESSIONS = 512
const MAX_WAIT_MS = 10_000
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

    // Fallback for sessions whose hooks have not run yet (e.g. after reload).
    const sessionModel = async (sessionID: string): Promise<ModelRefLike | undefined> => {
      const tracked = sessionModels.get(sessionID)
      if (tracked) return tracked
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

    // ---- Tool wrapping -----------------------------------------------------
    // Tool transform callbacks replay lazily on registry rebuilds; the native
    // read may not be visible on the first pass right after a hot reload, so
    // capture it with bounded retries and only wire the description hooks once
    // the wrapper is actually in place. Registrations after a successful pass
    // are no-ops (the guard flag keeps them idempotent).
    const registrations: { dispose: () => Promise<unknown> | unknown }[] = []
    let baseDescription: string | undefined
    let captured = false

    const attemptTransform = async (): Promise<boolean> => {
      try {
        registrations.push(
          await ctx.tool.transform((editor) => {
            const current = editor.get("read")
            if (current === undefined) return
            if (captured) return
            baseDescription = current.description
            const native = current.execute
            editor.update("read", (tool) => {
              captured = true
              tool.execute = ((input: unknown, context: unknown) =>
                wrappedRead(input, context as { readonly sessionID: string }, native as never)) as unknown as typeof tool.execute
            })
          }),
        )
      } catch (error) {
        console.warn("[oc-media] tool transform failed; will retry", error)
      }
      return captured
    }

    let waited = 0
    while (!(await attemptTransform()) && waited < MAX_WAIT_MS) {
      const pause = Math.min(250 + waited, 1_000)
      awaited(pause)
      waited += pause
    }

    if (baseDescription === undefined) {
      console.warn(
        "[oc-media] the native 'read' tool was not found in this OpenCode's tool registry; plugin disabled itself",
      )
      return disposeAll(registrations)
    }
    const base = baseDescription

    // ---- Per-dispatch description ----------------------------------------
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

    return disposeAll(registrations)
  },
})

function awaited(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function disposeAll(registrations: ReadonlyArray<{ dispose: () => unknown }>): Promise<void> {
  for (const registration of registrations) {
    try {
      await registration.dispose()
    } catch (error) {
      console.warn("[oc-media] failed to dispose a registration", error)
    }
  }
}
