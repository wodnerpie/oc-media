import { open, readFile, stat } from "node:fs/promises"
import { basename } from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Turn a media file on disk into the exact result shape the native Read tool
 * produces for images and PDFs (`read.ts::toModelContent`), so persistence,
 * `toolFileMedia` lowering, and capability-based stripping all behave
 * identically downstream.
 *
 * The returned content is `[acknowledgement text, file part]`; the model
 * receives the file part as inline media (data URL), while `output` keeps a
 * `file://` URI plus base64 for the client UI.
 */

export interface TextContentLike {
  readonly type: "text"
  readonly text: string
}

export interface FileContentLike {
  readonly type: "file"
  readonly uri: string
  readonly mime: string
  readonly name?: string
}

export interface MediaResult {
  readonly output: {
    readonly type: "file"
    readonly uri: string
    readonly name: string
    readonly content: string
    readonly encoding: "base64"
    readonly mime: string
  }
  readonly content: readonly [TextContentLike, FileContentLike]
  readonly metadata: { readonly truncated: false }
  /** Binary size of the file (not the base64 length). */
  readonly sizeBytes: number
}

export async function readMediaFile(absolute: string, displayPath: string, mime: string): Promise<MediaResult> {
  const bytes = await readFile(absolute)
  const base64 = Buffer.from(bytes).toString("base64")

  return {
    output: {
      type: "file",
      uri: pathToFileURL(absolute).href,
      name: basename(absolute),
      content: base64,
      encoding: "base64",
      mime,
    },
    content: [
      { type: "text", text: mime.startsWith("audio/") ? "Audio read successfully" : "Video read successfully" },
      { type: "file", uri: `data:${mime};base64,${base64}`, mime, name: displayPath },
    ],
    metadata: { truncated: false },
    sizeBytes: bytes.byteLength,
  }
}

/** Does this target resolve to a regular file, and how big is it? */
export async function statFile(
  absolute: string,
): Promise<{ exists: true; sizeBytes: number } | { exists: false; sizeBytes: null }> {
  try {
    const info = await stat(absolute)
    if (!info.isFile()) return { exists: false, sizeBytes: null }
    return { exists: true, sizeBytes: info.size }
  } catch {
    return { exists: false, sizeBytes: null }
  }
}

/**
 * A media extension is not proof of media content: `mime-types` maps `.ts`
 * to `video/mp2t`, yet a `.ts` file is usually TypeScript source. Only files
 * whose content actually looks like media are routed to the media path;
 * everything else stays with the native read (which reads text as text).
 *
 * "Looks like media" is the union of two rules:
 * - the native read's own binary rule — a NUL byte in the first bytes
 *   (`ReadTool`'s binary gate) — because every real media container is
 *   binary; and
 * - a known container/elementary-stream signature, which catches media
 *   that happens to be NUL-free in the probe window (e.g. a tagless MP3).
 */
export async function probeMediaContent(absolute: string, probeBytes = 1024): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(absolute, "r")
    const probe = Buffer.alloc(probeBytes)
    const { bytesRead } = await handle.read(probe, 0, probeBytes, 0)
    const bytes = probe.subarray(0, bytesRead)
    if (bytes.length === 0) return false
    if (bytes.includes(0)) return true
    return hasMediaSignature(bytes)
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

const FOURCC = ["ID3", "RIFF", "OggS", "fLaC", "FLV", "MThd", "caff", "FORM", "#!AMR", ".snd"] as const
const ISO_ATOMS = ["ftyp", "moov", "mdat", "free", "skip", "wide"] as const

/** Container and elementary-stream magic bytes (see `probeMediaContent`). */
export function hasMediaSignature(bytes: Buffer): boolean {
  const startsWith = (signature: string): boolean =>
    bytes.length >= signature.length && bytes.toString("latin1", 0, signature.length) === signature
  if (FOURCC.some(startsWith)) return true
  if (bytes.length >= 8 && (ISO_ATOMS as readonly string[]).includes(bytes.toString("latin1", 4, 8))) return true
  // Matroska / WebM EBML header.
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true
  // MPEG audio/video elementary streams and ADTS AAC: 0xFF followed by 0xE?.
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return true
  // MPEG transport stream: 0x47 sync bytes 188 bytes apart.
  if (bytes.length >= 189 && bytes[0] === 0x47 && bytes[188] === 0x47) return true
  // MPEG program stream.
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0xba) return true
  // ASF (WMA / WMV).
  if (bytes.length >= 4 && bytes[0] === 0x30 && bytes[1] === 0x26 && bytes[2] === 0xb2 && bytes[3] === 0x75) return true
  return false
}
