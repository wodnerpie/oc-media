import { readFile, stat } from "node:fs/promises"
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
