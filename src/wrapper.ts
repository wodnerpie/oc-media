import path from "node:path"
import { lookup } from "mime-types"
import { modalityOfMime, type CapabilityLookup, type MediaModality, type ModelRefLike } from "./capabilities.js"
import { decide } from "./decide.js"
import { readMediaFile, statFile } from "./media-read.js"
import type { Options } from "./options.js"
import { containsDirectory, isNativeBinaryFileFailure, resolveWorkspacePath } from "./paths.js"

/**
 * The orchestration of the wrapped `read` executor, factored out of the
 * plugin glue so the full flow (decision, delegation, capability gate,
 * external permission dance, media attach) can be tested with a stubbed
 * native executor.
 */

export interface ReadWrapperDeps {
  readonly options: Options
  /** The location directory reads resolve against. */
  readonly directory: string
  /** Optional project worktree root, internal like OpenCode's FileAccess treats it. */
  readonly worktree?: string
  readonly capabilities: CapabilityLookup
  /** Resolve the session's current model; supplied by hooks, with a session-API fallback. */
  readonly sessionModel: (sessionID: string) => Promise<ModelRefLike | undefined>
}

export type WrappedContext = { readonly sessionID: string }

export type WrappedRead = (
  input: unknown,
  context: WrappedContext,
  native: (input: unknown, context: unknown) => Promise<unknown>,
) => Promise<unknown>

export function createWrappedRead(deps: ReadWrapperDeps): WrappedRead {
  const { options, capabilities, sessionModel } = deps
  const root = deps.worktree
  const isInternal = (absolute: string): boolean =>
    containsDirectory(deps.directory, absolute) ||
    (root !== undefined && root !== path.parse(root).root && containsDirectory(root, absolute))

  return async function wrappedRead(input, context, native) {
    const args = (input && typeof input === "object" ? input : {}) as { path?: unknown }
    const raw = typeof args.path === "string" && args.path.length > 0 ? args.path : undefined
    if (raw === undefined) return native(input, context)

    const absolute = resolveWorkspacePath(raw, deps.directory)
    const stat = await statFile(absolute)
    const mime = stat.exists ? mutedMime(lookup(path.extname(absolute))) : null
    if (!stat.exists || mime === null) return native(input, context)

    // Only audio/video extensions ever leave the native path; images, PDFs
    // and everything else remain exactly native read.
    const modality = mediaModality(mime)
    if (modality === null) return native(input, context)
    if (!options[modality]) return native(input, context)

    // Capability gate against the session's current model.
    const model = (await sessionModel(context.sessionID)) ?? undefined
    const caps = await capabilities.for(model)
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

    if (decision.action === "reject") throw decision.error
    if (decision.action === "delegate") return native(input, context)

    // Media outside the location/worktree must go through OpenCode's own
    // external-directory approval, which the native read performs. Call it
    // first: an approval ends in the native binary gate, where we take over;
    // a denial propagates its error unchanged.
    if (!isInternal(absolute)) {
      try {
        return await native(input, context)
      } catch (error) {
        if (!isNativeBinaryFileFailure(error)) throw error
      }
    }

    return await readMediaFile(absolute, raw, mime)
  }
}

function mediaModality(mime: string): MediaModality | null {
  const modality = modalityOfMime(mime)
  return modality === "audio" || modality === "video" ? modality : null
}

function mutedMime(from: boolean | string): string | null {
  return typeof from === "string" ? from : null
}
