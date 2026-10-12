import type { MediaCapabilities, MediaModality, ModelRefLike } from "./capabilities.ts"
import type { Options } from "./options.ts"
import { emptyFileError, tooLargeError, unknownCapabilityError, unsupportedMediaError } from "./errors.ts"

/**
 * The behavioural contract of the wrapped `read` tool, as a pure decision so
 * tests can pin the matrix without a live OpenCode.
 *
 * Invariants:
 * - Everything OpenCode reads natively (text files, images, PDFs, missing
 *   files, whatever else falls outside audio/video extensions) stays
 *   byte-for-byte native: we delegate, we never reimplement reading.
 * - Audio/video attachment happens only for files the catalog says the
 *   model can ingest inline; unknown capability data fails closed unless
 *   the user opts in.
 * - Rejections happen before any file read or permission prompt.
 */

export interface DecisionInputs {
  /** Whether `stat` resolved the target to a regular file. */
  readonly exists: boolean
  /** Binary size when stat gave one, otherwise null. */
  readonly sizeBytes: number | null
  /** Mime type derived from the extension, or null when unknown. */
  readonly mime: string | null
  /** image/ audio/ video/ pdf modality of the mime, or null. */
  readonly modality: MediaModality | null
  /**
   * Is the current model able to ingest this modality per the catalog?
   * `true` / `false`; `null` when there is no capability data at all.
   */
  readonly capability: boolean | null
  readonly options: Options
  readonly path: string
  /** Only present for reject decisions so callers can attach the model ref. */
  readonly model?: ModelRefLike | undefined
}

export type Decision =
  | { readonly action: "delegate" }
  | { readonly action: "reject"; readonly error: Error }
  | { readonly action: "attach" }

export function decide(inputs: DecisionInputs): Decision {
  const { exists, sizeBytes, mime, modality, capability, options } = inputs

  // Native read owns everything that is not an audio/video extension.
  if (!exists || sizeBytes === null || !mime || !modality) return { action: "delegate" }

  // Opted-out modalities behave exactly as if the plugin were absent.
  if (!options[modality]) return { action: "delegate" }

  const path = inputs.path || "this file"
  const model = (inputs.model ?? { providerID: "unknown", id: "unknown" }) as ModelRefLike

  if (sizeBytes === 0) return { action: "reject", error: emptyFileError(path) }
  if (sizeBytes > options.maxBytes) {
    return { action: "reject", error: tooLargeError({ path, sizeBytes, maxBytes: options.maxBytes, modality }) }
  }

  if (capability === false) {
    return {
      action: "reject",
      error: unsupportedMediaError({ path, mime, modality, model }),
    }
  }

  if (capability === null && !options.allowUnknown) {
    return {
      action: "reject",
      error: unknownCapabilityError({ path, mime, modality, model }),
    }
  }

  return { action: "attach" }
}

/** Convenience for callers that already hold a capabilities view. */
export function capabilityFor(caps: MediaCapabilities, modality: MediaModality): boolean | null {
  return caps.known ? caps[modality] : null
}
