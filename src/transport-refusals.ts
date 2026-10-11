import type { ModelRefLike, MediaModality } from "./capabilities.ts"

/**
 * Transport-level refusals learned at runtime.
 *
 * models.dev capabilities are modality-level and transport-blind: a model can
 * advertise video input while the transport OpenCode lowers the request into
 * (OpenAI-compatible chat) refuses `video/mp4` media parts outright with
 *
 *   provider.invalid-request: OpenAI Chat does not support media type video/mp4
 *
 * The plugin learns these refusals from provider failures, remembers them per
 * model + modality, and then:
 *  (a) delivers such reads through raw-body injection when it is enabled
 *      (the `http.request` hook splices provider-native content parts in), or
 *      refuses them upfront when injection is disabled;
 *  (b) strips the un-deliverable typed media from outgoing request history so
 *      an already-poisoned session recovers;
 *  (c) drops the corresponding claim from the Read description only when
 *      raw-body delivery is unavailable.
 */

export type RefusalKey = string

const REFUSAL_PATTERN = /does not support media type ([a-z]+\/[a-z0-9.+-]+)/i

export class TransportRefusals {
  private refused = new Set<RefusalKey>()

  private static key(ref: ModelRefLike, modality: MediaModality): RefusalKey {
    return `${String(ref.providerID)}/${String(ref.id)}/${modality}`
  }

  isRefused(ref: ModelRefLike | undefined, modality: MediaModality): boolean {
    if (!ref) return false
    return this.refused.has(TransportRefusals.key(ref, modality))
  }

  record(ref: ModelRefLike | undefined, modality: MediaModality): void {
    if (!ref) return
    this.refused.add(TransportRefusals.key(ref, modality))
  }

  list(): readonly RefusalKey[] {
    return [...this.refused]
  }

  restore(keys: readonly RefusalKey[]): void {
    for (const key of keys) this.refused.add(key)
  }

  /**
   * Extract the modality a provider failure says its transport cannot carry.
   * Only audio/video count: images and PDFs are transport-supported shapes
   * everywhere this plugin runs, and anything else is not its business.
   */
  static modalityFromErrorMessage(message: string): MediaModality | null {
    const match = REFUSAL_PATTERN.exec(message)
    if (!match) return null
    const mime = (match[1] ?? "").toLowerCase()
    if (mime.startsWith("audio/")) return "audio"
    if (mime.startsWith("video/")) return "video"
    return null
  }
}

/**
 * Replace, in an OUTGOING request's message list only, any tool-result media
 * whose modality the destination model's transport has provenly refused. The
 * persisted history is untouched (OpenCode hands hooks per-dispatch copies);
 * this is what lets a session that already carries an un-deliverable
 * attachment keep working instead of failing every subsequent request.
 */
export function sanitizeRefusedMedia(
  messages: ReadonlyArray<unknown>,
  ref: ModelRefLike | undefined,
  refusals: TransportRefusals,
): void {
  for (const message of messages) {
    const content = (message as { content?: unknown } | null)?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const record = part as { type?: unknown; result?: { type?: unknown; value?: unknown } } | null
      if (record?.type !== "tool-result") continue
      if (record.result?.type !== "content" || !Array.isArray(record.result.value)) continue
      record.result.value = record.result.value.map((item: unknown) => {
        const file = item as { type?: unknown; mime?: unknown; name?: unknown } | null
        if (file?.type !== "file" || typeof file.mime !== "string") return item
        const modality = mimeModality(file.mime)
        if (modality === null) return item
        if (!refusals.isRefused(ref, modality)) return item
        return {
          type: "text",
          text:
            `[${modality} attachment omitted: the transport serving ${String(ref?.providerID)}/${String(ref?.id)} ` +
            `cannot carry inline ${modality} media` +
            (typeof file.name === "string" ? ` (file: ${file.name})` : "") +
            `]`,
        }
      })
    }
  }
}

function mimeModality(mime: string): MediaModality | null {
  const value = mime.toLowerCase()
  if (value.startsWith("audio/")) return "audio"
  if (value.startsWith("video/")) return "video"
  return null
}
