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
import { describeReadTool, mediaGuidanceFor, MEDIA_GUIDANCE_MARK } from "./describe.ts"
import { injectMediaIntoChatBody, isChatShapedPackage, MediaStash } from "./injection.ts"
import { resolveOptions } from "./options.ts"
import { TransportRefusals, sanitizeRefusedMedia } from "./transport-refusals.ts"
import { type MediaCapabilities, type MediaModality, type ModelInfoLike, type ModelRefLike } from "./capabilities.ts"

const MAX_TRACKED_SESSIONS = 512
const HOOK_KINDS = ["context", "generate", "compaction"] as const
const REFUSALS_STORAGE_KEY = "transport-refusals"
const MAX_INJECTED_PARTS = 8

export default Plugin.define({
  id: "oc-media",
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = resolveOptions(ctx.options)
      const directory = ctx.location.directory
      const worktree = path.resolve(ctx.location.project.directory)

      // ---- Learned transport refusals --------------------------------------
      // Persisted so a restart doesn't have to re-learn (and re-poison) on the
      // first attempt again.
      const refusals = new TransportRefusals()
      const storedRefusals = yield* Effect.result(ctx.storage.get(REFUSALS_STORAGE_KEY))
      if (Result.isSuccess(storedRefusals) && Array.isArray(storedRefusals.success)) {
        refusals.restore(storedRefusals.success.filter((item): item is string => typeof item === "string"))
      }
      const persistRefusals = ctx.storage.set(REFUSALS_STORAGE_KEY, refusals.list() as string[]).pipe(
        Effect.ignore({ message: "[oc-media] failed to persist transport refusals" }),
      )

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
      // Media bytes captured for raw-body delivery, keyed by the note text
      // that stands in for them in the conversation (see injection.ts).
      const mediaStash = new MediaStash()
      const readExecutor = createEffectRead({
        options,
        directory,
        worktree,
        capabilities,
        sessionModel,
        transportRefused: (ref, modality) => refusals.isRefused(ref, modality),
        stash: mediaStash,
        injectDelivery: (ref, modality) =>
          Effect.gen(function* () {
            if (!options.inject) return false
            // A learned refusal means the typed layer provably cannot carry
            // this modality on this route; injection is then the only path.
            if (refusals.isRefused(ref, modality)) return true
            // Chat-shaped routes refuse audio/video media parts by design, so
            // deliver through the raw body from the first read instead of
            // poisoning one attempt to learn what the catalog already says.
            const pkg = yield* capabilities.packageForEffect(ref)
            return isChatShapedPackage(pkg)
          }),
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
      //
      // The hook also performs two transport-reality corrections that the
      // catalog cannot express:
      // 1. outgoing history sanitization — media the model's transport has
      //    provably refused is replaced by a compact note in the request so
      //    an already-poisoned session can continue (history itself is never
      //    touched; this affects the outgoing call only);
      // 2. description claims — a modality refused by the transport is only
      //    dropped when raw-body delivery is unavailable; with injection
      //    enabled the media still reaches the model, so the claim stands.
      for (const kind of HOOK_KINDS) {
        yield* ctx.session
          .hook(kind, (event) =>
            Effect.gen(function* () {
              const ref = event.model
              if (ref && typeof ref.providerID === "string" && typeof ref.id === "string") {
                trackSession(event.sessionID, ref)
              }
              sanitizeRefusedMedia(event.messages, ref, refusals)
              const caps = yield* capabilities.forEffect(ref)

              // Media guidance in the system prompt for capable models: the
              // tool description alone is easy to skip at planning time —
              // agents otherwise jump straight to frame extraction.
              const guidance = mediaGuidanceFor(caps, options)
              if (guidance !== undefined) appendSystemGuidance(event.system, guidance)

              const read = event.tools?.read
              if (!read || typeof read.description !== "string") return
              baseDescription ??= read.description
              // With raw-body delivery available, a learned refusal no longer
              // means "cannot deliver" — the media still reaches the model —
              // so the description keeps its claims. Without it, a refused
              // modality is not claimed, regardless of models.dev.
              const effective: MediaCapabilities = options.inject
                ? caps
                : {
                    ...caps,
                    audio: caps.audio === null ? null : caps.audio && !refusals.isRefused(ref, "audio"),
                    video: caps.video === null ? null : caps.video && !refusals.isRefused(ref, "video"),
                  }
              read.description = describeReadTool(baseDescription, effective, options)
            }),
          )
          .pipe(Effect.ignore({ message: "[oc-media] hook registration failed" }))
      }

      // ---- Raw-body media delivery -----------------------------------------
      // On chat-shaped routes the protocol adapter refuses audio/video media
      // parts before an HTTP request exists, so no hook can repair the typed
      // request. The read tool therefore returns a note (see executor.ts) and
      // this hook splices the stashed bytes into the raw JSON body as the
      // provider-native content parts gateways accept:
      //   audio → input_audio, video → video_url.
      // Only modalities the dispatching model actually declares are injected,
      // so a model switch can never smuggle media into an incapable route.
      yield* ctx.session
        .hook("http.request", (event) =>
          Effect.gen(function* () {
            const request = event.request
            if (request === null || typeof request !== "object") return
            if (request.method !== "POST" || typeof request.clone !== "function") return
            const contentType = request.headers.get("content-type") ?? ""
            if (!contentType.toLowerCase().includes("json")) return
            if (mediaStash.size() === 0) return

            const caps = yield* capabilities.forEffect(event.model)
            const allowed = new Set<MediaModality>()
            if (caps.audio === true) allowed.add("audio")
            if (caps.video === true) allowed.add("video")
            if (allowed.size === 0) return

            const bodyOutcome = yield* Effect.result(
              Effect.tryPromise(() => request.clone().json() as Promise<unknown>),
            )
            if (Result.isFailure(bodyOutcome)) return
            const body = bodyOutcome.success
            if (body === null || typeof body !== "object") return
            const injected = injectMediaIntoChatBody(
              body as { messages?: unknown },
              mediaStash,
              allowed,
              MAX_INJECTED_PARTS,
            )
            if (injected === 0) return

            const headers = new Headers(request.headers)
            headers.delete("content-length")
            event.request = new Request(request, { method: request.method, headers, body: JSON.stringify(body) })
          }),
        )
        .pipe(Effect.ignore({ message: "[oc-media] http.request hook registration failed" }))

      // ---- Failure learning --------------------------------------------------
      // When a provider request fails because its transport cannot carry an
      // attached modality ("... does not support media type video/mp4"),
      // remember it per model so future reads refuse upfront and the outgoing
      // history gets sanitized. Retrying the identical request cannot succeed,
      // so the retry is vetoed as well.
      yield* ctx.session
        .hook("retry", (event) =>
          Effect.gen(function* () {
            const message = errorMessageOf(event.error)
            const modality = message === undefined ? null : TransportRefusals.modalityFromErrorMessage(message)
            if (modality === null) return
            const ref = event.model
            if (!ref || typeof ref.providerID !== "string" || typeof ref.id !== "string") return
            refusals.record(ref, modality)
            yield* persistRefusals
            event.decision = { retry: false }
          }),
        )
        .pipe(Effect.ignore({ message: "[oc-media] retry hook registration failed" }))

      if (baseDescription === undefined) {
        yield* Effect.logWarning(
          "[oc-media] the native 'read' tool was not found in this OpenCode's tool registry yet; the wrapper will install on the next registry replay",
        ).pipe(Effect.ignore)
      }
    }),
})

/**
 * Append the media guidance to the dispatch's system prompt, once. The
 * system parts array is mutable per dispatch (`SessionContext.system`), so
 * this is the strongest surface a plugin has — models plan from the system
 * prompt, not from tool descriptions alone.
 */
function appendSystemGuidance(system: unknown, text: string): void {
  if (!Array.isArray(system)) return
  const already = system.some(
    (part) =>
      part !== null &&
      typeof part === "object" &&
      typeof (part as { text?: unknown }).text === "string" &&
      (part as { text: string }).text.includes(MEDIA_GUIDANCE_MARK),
  )
  if (already) return
  system.push({ type: "text", text })
}

/**
 * Replace, in the OUTGOING request only, any tool-result media whose modality
 * the destination model's transport has provenly refused. Implemented in
 * transport-refusals.ts so the sanitization contract stays unit-tested.
 */
function errorMessageOf(error: unknown): string | undefined {
  if (typeof error === "string") return error
  if (error === null || typeof error !== "object") return undefined
  const message = (error as { message?: unknown }).message
  return typeof message === "string" ? message : undefined
}
