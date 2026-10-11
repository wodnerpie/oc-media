/**
 * Plugin options. Provided through the object form in `opencode.json(c)`:
 *
 * ```jsonc
 * {
 *   "plugins": [
 *     { "package": "oc-media", "options": { "maxBytes": 20971520 } }
 *   ]
 * }
 * ```
 *
 * Defaults match OpenCode's own media ingestion limit for images/PDFs
 * (`ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES`) and Gemini's inline request
 * budget, so a media read alone never produces an unusable request payload.
 */

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

export interface Options {
  /** Largest media file (binary bytes, not base64) the plugin will attach inline. */
  readonly maxBytes: number
  /**
   * When the current model has no capability data in the catalog, refuse to
   * attach media (`false`, the safe default) or attach anyway (`true`).
   */
  readonly allowUnknown: boolean
  /**
   * Rewrite the Read tool description so its image/PDF claims match the
   * model's actual capabilities, not just add audio/video claims.
   */
  readonly matchAllClaims: boolean
  /** Master switch: may the plugin handle audio reads at all? */
  readonly audio: boolean
  /** Master switch: may the plugin handle video reads at all? */
  readonly video: boolean
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback
}

function num(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : fallback
}

export function resolveOptions(raw: unknown): Options {
  const input = (raw ?? {}) as Record<string, unknown>
  return {
    maxBytes: num(input.maxBytes, DEFAULT_MAX_BYTES),
    allowUnknown: bool(input.allowUnknown, false),
    matchAllClaims: bool(input.matchAllClaims, true),
    audio: bool(input.audio, true),
    video: bool(input.video, true),
  }
}

/** Human label for a byte budget, e.g. `20` for 20 MiB or `1.5` for 1.5 MiB. */
export function maxBytesLabel(bytes: number): string {
  const mb = Math.round((bytes / (1024 * 1024)) * 10) / 10
  return `${mb}`
}
