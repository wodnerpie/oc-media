/**
 * Capability derivation shared by the execute gate and the description
 * rewriter.
 *
 * The single source of truth for "can this model ingest X?" is the model
 * catalog OpenCode materializes from models.dev, exposed by the plugin
 * context as `Model.Info.capabilities.input`. A mime maps to an input
 * modality exactly the way OpenCode core maps it
 * (`SessionModelRequest.mimeToModality`), and membership is checked with the
 * same `startsWith` rule core uses (`unsupportedMedia`), so this plugin's
 * opinion can never disagree with the dispatch-time stripping OpenCode
 * already performs.
 */
import type { Effect } from "effect"

export type Modality = "audio" | "video" | "image" | "pdf"

/** The three modalities this plugin can speak about. */
export type MediaModality = Extract<Modality, "audio" | "video">

export interface ModelRefLike {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

export interface ModelInfoLike {
  readonly providerID: string
  readonly id?: string
  readonly modelID?: string
  /** Transport package (e.g. `@opencode/ai/providers/openai-compatible`), when the catalog exposes it. */
  readonly package?: unknown
  readonly capabilities?: {
    readonly input?: readonly unknown[] | null
  } | null
}

export type MediaCapabilities = {
  readonly audio: boolean | null
  readonly video: boolean | null
  readonly image: boolean | null
  readonly pdf: boolean | null
  /**
   * `false` means the model ref was not found in the catalog at all (or its
   * input capability list was useless), so every modality reads as unknown
   * rather than unsupported.
   */
  readonly known: boolean
}

const IMAGE_MIME = /^image\//
const AUDIO_MIME = /^audio\//
const VIDEO_MIME = /^video\//
const PDF_MIME = "application/pdf"

/** OpenCode core's `mimeToModality`, ported verbatim. */
export function modalityOfMime(mime: string | null | undefined): Modality | null {
  if (!mime) return null
  const value = mime.toLowerCase()
  if (IMAGE_MIME.test(value)) return "image"
  if (AUDIO_MIME.test(value)) return "audio"
  if (VIDEO_MIME.test(value)) return "video"
  if (value === PDF_MIME) return "pdf"
  return null
}

/** Same membership rule OpenCode's `unsupportedMedia` applies at dispatch. */
function supportsInput(input: readonly unknown[], modality: Modality): boolean {
  return input.some((item) => item !== null && String(item).startsWith(modality))
}

/**
 * Derive the media capability view of one catalog model. `undefined` (model
 * absent) yields `known: false` with all modalities unknown; a present model
 * with no modality data yields `known: true` with everything unsupported —
 * matching how core dispatches (empty `input` strips all media).
 */
export function capabilitiesOf(model: ModelInfoLike | undefined | null): MediaCapabilities {
  if (!model) return { audio: null, video: null, image: null, pdf: null, known: false }
  const input = model.capabilities?.input
  if (!Array.isArray(input)) return { audio: null, video: null, image: null, pdf: null, known: false }
  return {
    audio: supportsInput(input, "audio"),
    video: supportsInput(input, "video"),
    image: supportsInput(input, "image"),
    pdf: supportsInput(input, "pdf"),
    known: true,
  }
}

/** Match a catalog model by providerID + id (falling back to modelID). */
export function findModel(models: readonly ModelInfoLike[], ref: ModelRefLike | undefined): ModelInfoLike | undefined {
  if (!ref) return undefined
  const provider = String(ref.providerID ?? "")
  const id = String(ref.id ?? "")
  if (!provider || !id) return undefined
  return models.find(
    (model) => String(model.providerID) === provider && (String(model.id ?? "") === id || String(model.modelID ?? "") === id),
  )
}

export interface CapabilityLookup {
  /** Resolve the media capabilities of a model ref. Cheap, cached. */
  forEffect(ref: ModelRefLike | undefined): Effect.Effect<MediaCapabilities>
}
