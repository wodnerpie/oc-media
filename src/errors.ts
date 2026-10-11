import { maxBytesLabel, type Options } from "./options.ts"
import type { ModelRefLike } from "./capabilities.ts"

/**
 * Model-facing tool errors. These messages are surfaced to the agent as the
 * tool failure text, so each one must state: which file, which modality,
 * what the model should do instead, and (for unknown/oversize cases) what
 * the user can change.
 */

export interface UnsupportedErrorInput {
  readonly path: string
  readonly mime: string
  readonly modality: "audio" | "video"
  readonly model: ModelRefLike
}

export function unsupportedMediaError({ path, mime, modality, model }: UnsupportedErrorInput): Error {
  return new Error(
    `Cannot read "${path}": the current model (${model.providerID}/${model.id}) does not support ${modality} input ` +
      `(mime type: ${mime}), so the file cannot be attached as inline ${modality} media. ` +
      `Use another way to inspect it (a transcript, a description, or text metadata), ` +
      `or tell the user to switch to a model that accepts inline ${modality} media (for example a Gemini model).`,
  )
}

export interface UnknownCapabilityErrorInput {
  readonly path: string
  readonly mime: string
  readonly modality: "audio" | "video"
  readonly model: ModelRefLike
}

export function unknownCapabilityError({ path, mime, modality, model }: UnknownCapabilityErrorInput): Error {
  return new Error(
    `Cannot read "${path}": the capabilities of the current model (${model.providerID}/${model.id}) are unknown ` +
      `(not found in the model catalog), so media attachment is refused to avoid an invalid request. ` +
      `If this model ${modality === "audio" ? "accepts audio" : "accepts video"} input (mime type: ${mime}), ` +
      `the user can allow it by setting the oc-media plugin option "allowUnknown": true.`,
  )
}

export interface TooLargeErrorInput {
  readonly path: string
  readonly sizeBytes: number
  readonly maxBytes: number
}

export function tooLargeError({ path, sizeBytes, maxBytes }: TooLargeErrorInput): Error {
  return new Error(
    `Cannot read "${path}": the file is ${maxBytesLabel(sizeBytes)} MB, larger than the ${maxBytesLabel(maxBytes)} MB ` +
      `inline media ingestion limit. Trim, compress, or re-encode the file, or read a text representation of it instead.`,
  )
}

export function emptyFileError(path: string): Error {
  return new Error(`Cannot read "${path}": the file is empty (0 bytes), so there is no media content to attach.`)
}
