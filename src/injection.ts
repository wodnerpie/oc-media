/**
 * Raw-body media delivery ("injection").
 *
 * OpenCode's typed message layer lowers tool results through a protocol
 * adapter, and for every OpenAI-Chat-shaped route that adapter refuses audio
 * and video media parts outright, before any HTTP request exists:
 *
 *   provider.invalid-request: OpenAI Chat does not support media type video/mp4
 *
 * No hook can repair a request that failed to lower, so injection takes a
 * different route. The read tool result carries a plain-text note instead of
 * a typed media part (which lowers cleanly everywhere), the media bytes are
 * stashed here, and the `http.request` session hook splices provider-native
 * content parts into the raw JSON body at the last moment:
 *
 *   audio → { type: "input_audio", input_audio: { data, format } }
 *   video → { type: "video_url",    video_url:    { url: "data:<mime>;base64,…" } }
 *
 * These are the de-facto content-type extensions OpenAI-compatible gateways
 * accept (OpenRouter documents both; the OpenCode Go gateway forwards both —
 * verified live against `opencode-go/mimo-v2.6-flash`).
 *
 * Isolation: stashed bytes belong to the session that read them. Notes carry
 * a random attachment token (unguessable), the stash keys and lookups bind the
 * session ID, and `http.request` injection passes the dispatching session —
 * so no other session's request can ever receive them.
 */
import { createHash, randomBytes } from "node:crypto"
import type { MediaModality } from "./capabilities.ts"

export interface StashedMedia {
  readonly mime: string
  /** The path as the model referenced it (what the note names). */
  readonly name: string
  readonly sizeBytes: number
  readonly base64: string
  /**
   * The OpenCode session whose `read` captured this media. Only this session's
   * outgoing requests may ever retrieve it (see `MediaStash.find`).
   */
  readonly sessionId: string
  /**
   * Cryptographically unpredictable attachment ID, embedded in the note text.
   * Matching is no longer filename/description-based: without the exact token
   * from the original tool result, no message text can name this entry — and
   * even the exact text is refused outside `sessionId` (session ownership is
   * checked independently of the token).
   */
  readonly token: string
}

export const NOTE_PREFIX = "[media attached: "

/** 128-bit attachment ID; unpredictable, regenerated on every media read. */
export function newAttachmentToken(): string {
  return randomBytes(16).toString("hex")
}

/** The tool-result note whose text keys a stashed media entry. */
export function noteTextFor(media: Pick<StashedMedia, "name" | "mime" | "sizeBytes" | "token">): string {
  return `${NOTE_PREFIX}${media.name} (${media.mime}, ${humanSize(media.sizeBytes)}) #${media.token}]`
}

/**
 * Map key for a note: bound to the owning session as well as the text, so two
 * sessions can never collide on — or look up — each other's entries even if
 * they somehow carry identical note text.
 */
export function noteKeyForText(text: string, sessionId: string): string {
  return createHash("sha256").update(`${sessionId}\n${text}`).digest("hex").slice(0, 32)
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb * 10) / 10} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${Math.round(mb * 10) / 10} MB`
  return `${Math.round((mb / 1024) * 10) / 10} GB`
}

const MAX_STASH_ENTRIES = 64
const MAX_STASH_BYTES = 64 * 1024 * 1024

/**
 * Bytes captured at read time, keyed by the (session-bound) hash of the note
 * text that stands in for them in the persisted conversation. Matching by note
 * text (exact first, then a contains scan for joined text parts) keeps the
 * conversation clean: no marker ever appears in message text.
 *
 * Session isolation (security): every entry records the session that read it,
 * the map key binds `sessionId` into the hash, and `find` verifies ownership —
 * a request from session B can never retrieve bytes stashed by session A, even
 * with the exact note text in hand. Tokens make note text unforgeable per read
 * in the first place: two reads of the same path produce different notes.
 */
export class MediaStash {
  private readonly entries = new Map<string, StashedMedia>()
  private order: string[] = []
  private totalBase64 = 0

  put(media: StashedMedia): string {
    const key = noteKeyForText(noteTextFor(media), media.sessionId)
    const existing = this.entries.get(key)
    if (existing) this.totalBase64 -= existing.base64.length
    else this.order.push(key)
    this.entries.set(key, media)
    this.totalBase64 += media.base64.length
    this.evict()
    return key
  }

  size(): number {
    return this.entries.size
  }

  /**
   * Exact-note lookup first, then a contains scan (joined/split text parts) —
   * both scoped to `sessionId`. A note from another session (copied, forged,
   * or pasted into an unrelated conversation) matches nothing.
   */
  find(text: string, sessionId: string): StashedMedia | undefined {
    if (!text.includes(NOTE_PREFIX)) return undefined
    const exact = this.entries.get(noteKeyForText(text, sessionId))
    // Belt and braces: the key already binds the session; re-verify ownership.
    if (exact && exact.sessionId === sessionId) return exact
    for (const media of this.entries.values()) {
      if (media.sessionId !== sessionId) continue
      if (text.includes(noteTextFor(media))) return media
    }
    return undefined
  }

  /** Drop every entry a session owns (its bytes are no longer reachable). */
  deleteSession(sessionId: string): void {
    for (const [key, media] of this.entries) {
      if (media.sessionId !== sessionId) continue
      this.totalBase64 -= media.base64.length
      this.entries.delete(key)
    }
    this.order = this.order.filter((key) => this.entries.has(key))
  }

  /**
   * Re-home `fromSessionId`'s entries into `toSessionId` (used when a session
   * is forked: the child's conversation legitimately contains the parent's
   * notes, so it must own retrievable copies — while the parent keeps its own).
   * Note text is unchanged (the token is preserved); only ownership moves.
   */
  copySession(fromSessionId: string, toSessionId: string): void {
    if (fromSessionId === toSessionId) return
    const clones: StashedMedia[] = []
    for (const media of this.entries.values()) {
      if (media.sessionId === fromSessionId) clones.push({ ...media, sessionId: toSessionId })
    }
    for (const clone of clones) this.put(clone)
  }

  private evict(): void {
    while (this.order.length > MAX_STASH_ENTRIES || (this.totalBase64 > MAX_STASH_BYTES && this.order.length > 1)) {
      const oldest = this.order.shift()
      if (oldest === undefined) return
      const media = this.entries.get(oldest)
      if (media) this.totalBase64 -= media.base64.length
      this.entries.delete(oldest)
    }
  }
}

const FORMAT_FROM_MIME: Record<string, string> = {
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/vnd.wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/webm": "webm",
}

export function audioFormatOf(mime: string): string {
  const value = mime.toLowerCase()
  return FORMAT_FROM_MIME[value] ?? value.replace(/^.*\//, "")
}

export function modalityOfStashed(media: StashedMedia): MediaModality | null {
  const mime = media.mime.toLowerCase()
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  return null
}

export function mediaPartsFor(media: StashedMedia): unknown[] {
  const modality = modalityOfStashed(media)
  if (modality === "audio") {
    return [{ type: "input_audio", input_audio: { data: media.base64, format: audioFormatOf(media.mime) } }]
  }
  if (modality === "video") {
    return [{ type: "video_url", video_url: { url: `data:${media.mime};base64,${media.base64}` } }]
  }
  return []
}

/**
 * Packages whose requests are lowered into OpenAI Chat Completions, where
 * audio/video media parts are refused by the protocol adapter. Verified
 * against the live catalog for OpenCode Go (`openai-compatible`) and the
 * OpenRouter/DeepInfra families. Anything else takes the typed path first;
 * a learned transport refusal then switches it to injection.
 */
const CHAT_SHAPED_PACKAGES = [
  "@opencode/ai/providers/openai-compatible",
  "@opencode/ai/providers/openrouter",
  "@opencode/ai/providers/deepinfra",
] as const

export function isChatShapedPackage(pkg: string | undefined): boolean {
  if (typeof pkg !== "string" || pkg.length === 0) return false
  return CHAT_SHAPED_PACKAGES.some((name) => pkg === name || pkg.startsWith(`${name}/`))
}

export interface ChatBodyLike {
  messages?: unknown
}

/**
 * Splice stashed media into an OpenAI-chat-shaped request body. Mutates the
 * body and returns how many media parts were injected. Only `user` and `tool`
 * messages are considered — notes ride in tool results. Text slots that carry
 * a stashed note get the note kept as a caption and the native media part
 * appended right after it.
 *
 * `sessionId` scopes the stash lookup: only media that this very session's
 * `read` captured is ever spliced in, no matter what note text the outgoing
 * body carries.
 */
export function injectMediaIntoChatBody(
  body: ChatBodyLike,
  stash: MediaStash,
  sessionId: string,
  allowed: ReadonlySet<MediaModality>,
  maxParts: number,
): number {
  const messages = body.messages
  if (!Array.isArray(messages) || maxParts <= 0 || allowed.size === 0) return 0
  let injected = 0
  for (const raw of messages) {
    if (injected >= maxParts) break
    if (raw === null || typeof raw !== "object") continue
    const message = raw as { role?: unknown; content?: unknown }
    if (message.role !== "user" && message.role !== "tool") continue
    const content = message.content
    if (typeof content === "string") {
      const parts = partsForText(content, stash, sessionId, allowed, maxParts - injected)
      if (parts.length === 0) continue
      message.content = [{ type: "text", text: content }, ...parts]
      injected += parts.length
      continue
    }
    if (!Array.isArray(content)) continue
    for (let index = 0; index < content.length && injected < maxParts; index++) {
      const part = content[index] as { type?: unknown; text?: unknown } | null
      if (part === null || typeof part !== "object" || part.type !== "text" || typeof part.text !== "string") continue
      const parts = partsForText(part.text, stash, sessionId, allowed, maxParts - injected)
      if (parts.length === 0) continue
      content.splice(index + 1, 0, ...parts)
      index += parts.length
      injected += parts.length
    }
  }
  return injected
}

function partsForText(
  text: string,
  stash: MediaStash,
  sessionId: string,
  allowed: ReadonlySet<MediaModality>,
  budget: number,
): unknown[] {
  if (budget <= 0) return []
  const media = stash.find(text, sessionId)
  if (!media) return []
  const modality = modalityOfStashed(media)
  if (modality === null || !allowed.has(modality)) return []
  return mediaPartsFor(media)
}
