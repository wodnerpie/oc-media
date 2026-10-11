/**
 * oc-media — an OpenCode V2 plugin (Effect form, the same shape the internal
 * core tool plugins use so registrations bind through the canonical registry
 * machinery).
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
import { Effect, Result } from "effect"
import path from "node:path"
import { Plugin } from "@opencode/plugin/effect"
import { CapabilityCache } from "./capability-cache.ts"
import { createEffectRead } from "./executor.ts"
import { describeReadTool } from "./describe.ts"
import { resolveOptions } from "./options.ts"
import type { ModelInfoLike, ModelRefLike } from "./capabilities.ts"

const MAX_TRACKED_SESSIONS = 512
const HOOK_KINDS = ["context", "generate", "compaction"] as const

export default Plugin.define({
  id: "oc-media",
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = resolveOptions(ctx.options)
      const directory = ctx.location.directory
      const worktree = path.resolve(ctx.location.project.directory)

      // ---- Model tracking (session -> current model ref) -----------------
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

      // Fallback for sessions whose hooks have not run yet: session info,
      // then OpenCode's workspace default model as the least-wrong guess.
      const sessionModel = (sessionID: string): Effect.Effect<ModelRefLike | undefined, unknown> =>
        Effect.gen(function* () {
          const tracked = sessionModels.get(sessionID)
          if (tracked) return tracked
          const sessionOutcome = yield* Effect.result(ctx.session.get({ sessionID: sessionID as never }))
          if (Result.isSuccess(sessionOutcome)) {
            const model = sessionOutcome.success.model
            if (model) {
              sessionModels.set(sessionID, model)
              return model
            }
          }
          const defaultOutcome = yield* Effect.result(ctx.model.default().pipe(Effect.map((view) => view.data)))
          if (Result.isSuccess(defaultOutcome)) {
            const fallback = defaultOutcome.success
            if (fallback) return fallback as unknown as ModelRefLike
          }
          return undefined
        })

      const capabilities = new CapabilityCache(
        Effect.suspend(() =>
          ctx.model.list().pipe(Effect.map((listing) => listing.data as readonly ModelInfoLike[])),
        ),
      )
      const readExecutor = createEffectRead({
        options,
        directory,
        worktree,
        capabilities,
        sessionModel,
      })

      // ---- Tool wrapping ----------------------------------------------------
      // The tool registry rebuilds from scratch on every tool-list change
      // (MCP servers connecting, skills loading, …), replaying every
      // transform against a fresh candidate. The wrapper must therefore be
      // reinstalled on every replay — a "captured once" guard would silently
      // lose the wrapper after the first rebuild and let sessions fall back
      // to the native executor. Idempotence inside a single replay is kept
      // via a sentinel on our own wrapped executor.
      //
      // Note: the transform callback may defer until the activation batch
      // ends (i.e. until plugin setup returns), so nothing downstream may
      // gate on the callback having run — it always runs before the first
      // session dispatch.
      const wrappedMarker = Symbol("oc-media.wrapped")
      let baseDescription: string | undefined

      yield* ctx.tool
        .transform((editor) => {
          const current = editor.get("read")
          if (current === undefined) return
          const execute = current.execute as unknown as { [wrappedMarker]?: true }
          if (execute !== null && typeof execute === "object" && execute[wrappedMarker]) return
          baseDescription ??= current.description
          const native = current.execute
          editor.update("read", (tool) => {
            const wrapped = (input: unknown, context: unknown) =>
              readExecutor(input, context as { readonly sessionID: string }, native as never)
            ;(wrapped as unknown as { [wrappedMarker]: true })[wrappedMarker] = true
            tool.execute = wrapped as unknown as typeof tool.execute
          })
        })
        .pipe(Effect.ignore({ message: "[oc-media] tool transform failed" }))

      // ---- Per-dispatch description --------------------------------------
      // Registered unconditionally: the description rewrite is independent of
      // the executor swap, and its base text is captured lazily from the
      // first read definition the hook sees (always pristine, because this
      // hook is the only writer of that description).
      for (const kind of HOOK_KINDS) {
        yield* ctx.session
          .hook(kind, (event) =>
            Effect.gen(function* () {
              const ref = event.model
              if (ref && typeof ref.providerID === "string" && typeof ref.id === "string") {
                trackSession(event.sessionID, ref)
              }
              const read = event.tools?.read
              if (!read || typeof read.description !== "string") return
              baseDescription ??= read.description
              const caps = yield* capabilities.forEffect(ref)
              read.description = describeReadTool(baseDescription, caps, options)
            }),
          )
          .pipe(Effect.ignore({ message: "[oc-media] hook registration failed" }))
      }

      if (baseDescription === undefined) {
        yield* Effect.logWarning(
          "[oc-media] the native 'read' tool was not found in this OpenCode's tool registry yet; the wrapper will install on the next registry replay",
        ).pipe(Effect.ignore)
      }
    }),
})
