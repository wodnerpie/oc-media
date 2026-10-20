import { Effect, Result } from "effect"
import path from "node:path"
import { lookup } from "mime-types"
import { modalityOfMime, type MediaCapabilities, type MediaModality, type ModelRefLike } from "./capabilities.ts"
import { decide } from "./decide.ts"
import { remuxFailedError, transportRefusedError } from "./errors.ts"
import { type MediaStash, newAttachmentToken, noteTextFor, type StashedMedia } from "./injection.ts"
import { mediaResultFromBytes, probeMediaContent, readMediaFile, statFile, type MediaResult } from "./media-read.ts"
import type { Options } from "./options.ts"
import { containsDirectory, isNativeBinaryFileFailure, resolveWorkspacePath } from "./paths.ts"
import { remuxToMp4, shouldRemux, type RemuxResult } from "./remux.ts"
/**
 * The wrapped `read` executor in Effect form — the shape every internal core
 * tool plugin uses, so registrations bind to the canonical registry through
 * the same fiber/batch machinery (this is what the live dispatch path needs).
 */

/** Effect-side tool executor: (input, context) => Effect<Result, Tool.Error>. */
export interface EffectToolExecutor {
  (input: unknown, context: { readonly sessionID: string } & unknown): Effect.Effect<unknown, unknown>
}

export interface EffectExecutorDeps {
  readonly options: Options
  /** The location directory reads resolve against. */
  readonly directory: string
  /** Optional project worktree root, internal like OpenCode's FileAccess treats it. */
  readonly worktree?: string
  readonly capabilities: {
    readonly forEffect: (ref: ModelRefLike | undefined) => Effect.Effect<MediaCapabilities, unknown>
  }
  /** Resolve the session's current model; supplied by hooks, with a session-API fallback. */
  readonly sessionModel: (sessionID: string) => Effect.Effect<ModelRefLike | undefined, unknown>
  /** Learned transport-level refusals (provider failures prove the route can't carry the media). */
  readonly transportRefused?: (ref: ModelRefLike | undefined, modality: "audio" | "video") => boolean
  /** Raw-body delivery stash; required for injection to engage. */
  readonly stash?: MediaStash
  /**
   * Should this model + modality be delivered by splicing provider-native
   * content parts into the raw request body instead of the typed message
   * layer (which refuses audio/video on chat-shaped routes)?
   */
  readonly injectDelivery?: (
    ref: ModelRefLike | undefined,
    modality: MediaModality,
  ) => Effect.Effect<boolean>
  /** Container remuxing (defaults to the real FFmpeg-backed implementation). */
  readonly remux?: (absolute: string) => Promise<RemuxResult>
}

export type EffectWrappedRead = (
  input: unknown,
  context: { readonly sessionID: string } & unknown,
  native: EffectToolExecutor,
) => Effect.Effect<unknown, unknown>

export function createEffectRead(deps: EffectExecutorDeps): EffectWrappedRead {
  const { options, capabilities, sessionModel } = deps
  const root = deps.worktree
  const isInternal = (absolute: string): boolean =>
    containsDirectory(deps.directory, absolute) ||
    (root !== undefined && root !== path.parse(root).root && containsDirectory(root, absolute))

  return function wrappedRead(input, context, native) {
    const self = { deps, native }
    void self
    return Effect.gen(function* () {
      const args = (input && typeof input === "object" ? input : {}) as { path?: unknown }
      const raw = typeof args.path === "string" && args.path.length > 0 ? args.path : undefined
      if (raw === undefined) return yield* native(input, context)

      const absolute = resolveWorkspacePath(raw, deps.directory)
      const stat = yield* Effect.promise(() => statFile(absolute))
      const mime = stat.exists ? mutedMime(lookup(path.extname(absolute))) : null
      if (!stat.exists || mime === null) return yield* native(input, context)

      // Only audio/video extensions ever leave the native path; images, PDFs
      // and everything else remain exactly native read.
      const modality = mediaModality(mime)
      if (modality === null) return yield* native(input, context)
      if (!options[modality]) return yield* native(input, context)

      // A media extension is not proof of media content: `mime-types` maps
      // `.ts` to `video/mp2t`, but a `.ts` file is usually TypeScript source.
      // A 1 KiB content probe (text vs media, the same NUL-byte rule the
      // native binary gate uses) decides — before any capability reject, so a
      // source file on a text-only model still reads natively. Full reads
      // still happen only after all gates.
      const mediaContent = yield* Effect.promise(() => probeMediaContent(absolute))
      if (!mediaContent) return yield* native(input, context)

      // Capability gate against the session's current model.
      const model = yield* sessionModel(context.sessionID)
      const caps = yield* capabilities.forEffect(model)
      const capability = caps.known ? caps[modality] : null

      const decision = decide({
        exists: true,
        sizeBytes: stat.sizeBytes,
        mime,
        modality,
        capability,
        options,
        path: raw,
        model,
      })

      if (decision.action === "reject") {
        // The tool runtime wraps the executor failure channel into
        // Tool.Error using the error's own message, so the model sees the
        // actionable text (unsupported media / unknown capabilities / size).
        return yield* Effect.fail(decision.error)
      }
      if (decision.action === "delegate") {
        return yield* native(input, context)
      }

      // Capability data said yes, but this route may be unable to carry the
      // media through the typed message layer (OpenAI-Chat-shaped routes
      // refuse audio/video media parts outright). When raw-body injection is
      // available, deliver through it instead of refusing; only without it
      // does a learned refusal mean "this file can never reach the model".
      const refused = deps.transportRefused?.(model, modality) === true
      const inject =
        deps.stash !== undefined && deps.injectDelivery !== undefined
          ? yield* deps.injectDelivery(model, modality)
          : false
      if (refused && !inject) {
        return yield* Effect.fail(transportRefusedError({ path: raw, mime, modality, model: model ?? { providerID: "unknown", id: "unknown" } }))
      }

      // Media outside the location/worktree must go through OpenCode's own
      // external-directory approval, which the native read performs. Call it
      // first: an approval ends in the native binary gate, where we take
      // over; a denial propagates its error unchanged.
      if (!isInternal(absolute)) {
        const outcome = yield* Effect.result(native(input, context))
        if (Result.isSuccess(outcome)) return outcome.success
        if (!isNativeBinaryFileFailure(outcome.failure)) return yield* Effect.fail(outcome.failure)
      }

      let media: MediaResult
      if (inject && shouldRemux(mime)) {
        // The transport serving this route rejects the container outright
        // (verified: OpenCode Go takes only mp4/wmv/mov/avi video); remux to
        // MP4 — codecs copied whenever they fit — and deliver that instead.
        const remux = deps.remux ?? remuxToMp4
        const remuxed = yield* Effect.promise(() => remux(absolute))
        if (!remuxed.ok) {
          return yield* Effect.fail(remuxFailedError({ path: raw, mime, reason: remuxed.reason }))
        }
        media = mediaResultFromBytes(remuxed.bytes, absolute, raw, "video/mp4")
      } else {
        media = yield* Effect.tryPromise(() => readMediaFile(absolute, raw, mime))
      }
      if (!inject) return media

      // Raw-body delivery: the tool result carries a plain-text note (which
      // lowers cleanly on every route) and the bytes go into the stash; the
      // `http.request` hook splices the provider-native media part into the
      // outgoing body where the note appears. The entry is owned by this
      // session and carries a fresh random attachment token, so the note text
      // is both unguessable and unretrievable from any other session.
      const stash = deps.stash as MediaStash
      const delivered = media.output.mime
      const entry: StashedMedia = {
        mime: delivered,
        name: raw,
        sizeBytes: media.sizeBytes,
        base64: media.output.content,
        sessionId: context.sessionID,
        token: newAttachmentToken(),
      }
      const key = stash.put(entry)
      return {
        output: media.output,
        content: [{ type: "text" as const, text: noteTextFor(entry) }],
        metadata: { truncated: false as const, "oc-media": { key, mime: delivered, name: raw, sizeBytes: media.sizeBytes } },
      }
    })
  }
}

function mediaModality(mime: string): MediaModality | null {
  const parsed = modalityOfMime(mime)
  return parsed === "audio" || parsed === "video" ? parsed : null
}

function mutedMime(from: boolean | string): string | null {
  return typeof from === "string" ? from : null
}
