import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

/**
 * Automatic container remuxing for transports that only carry MP4-family
 * video containers. Verified live: the OpenCode Go gateway rejects MKV and
 * WebM with
 *
 *   invalid video format, only mp4/wmv/mov/avi are supported
 *
 * while accepting every codec tried inside MP4 (AV1, VP9, Opus, …). Remuxing
 * therefore preserves the media bit-for-bit wherever the codecs can live in
 * MP4; a cascade of fallbacks keeps it robust when they cannot:
 *
 *   1. stream copy        — fast, lossless (AV1/VP9/H.264 + Opus/AAC/MP3…)
 *   2. audio transcode    — rescues Vorbis (common in WebM) by re-encoding
 *                           only the audio track, video still copied
 *   3. full transcode     — last resort (H.264/AAC) for exotic video codecs
 *
 * If all of it fails (or FFmpeg is unavailable) the caller fails the read
 * with an actionable error instead of sending a container the transport will
 * reject.
 */

const run = promisify(execFile)

const REMUX_TIMEOUT_MS = 180_000

let ffmpegProbe: Promise<string | null> | undefined

/** Resolve the FFmpeg executable once; `null` when it is not usable. */
export function ffmpegPath(): Promise<string | null> {
  ffmpegProbe ??= (async () => {
    try {
      await run("ffmpeg", ["-version"], { timeout: 10_000, windowsHide: true })
      return "ffmpeg"
    } catch {
      return null
    }
  })()
  return ffmpegProbe
}

/** Containers the plugin remuxes before delivery (transport-verified). */
export function shouldRemux(mime: string): boolean {
  return mime === "video/x-matroska" || mime === "video/webm"
}

export type RemuxResult = { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false; readonly reason: string }

export async function remuxToMp4(absolute: string): Promise<RemuxResult> {
  const ffmpeg = await ffmpegPath()
  if (ffmpeg === null) {
    return { ok: false, reason: "FFmpeg is not available on PATH" }
  }
  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), "oc-media-remux-"))
    const out = join(dir, "media.mp4")
    const attempts: ReadonlyArray<{ label: string; args: readonly string[] }> = [
      { label: "stream copy", args: ["-c", "copy"] },
      { label: "audio transcode", args: ["-c:v", "copy", "-c:a", "aac", "-b:a", "128k"] },
      {
        label: "full transcode",
        args: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k"],
      },
    ]
    let lastError = "remuxing produced no output"
    for (const attempt of attempts) {
      const args = [
        "-y",
        "-v",
        "error",
        "-i",
        absolute,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        ...attempt.args,
        "-movflags",
        "+faststart",
        out,
      ]
      try {
        await run(ffmpeg, args, { timeout: REMUX_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
        const info = await stat(out)
        if (info.size > 0) return { ok: true, bytes: await readFile(out) }
        lastError = `${attempt.label} produced an empty file`
      } catch (error) {
        lastError = `${attempt.label}: ${errorText(error)}`
      }
    }
    return { ok: false, reason: lastError }
  } catch (error) {
    return { ok: false, reason: errorText(error) }
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function errorText(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  const text =
    typeof stderr === "string" && stderr.trim().length > 0
      ? stderr.trim()
      : typeof (error as { message?: unknown } | null)?.message === "string"
        ? String((error as { message: string }).message)
        : "unknown error"
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
  const last = lines.at(-1) ?? "unknown error"
  return last.length > 300 ? `${last.slice(0, 297)}…` : last
}
