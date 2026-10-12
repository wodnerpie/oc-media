import { describe, expect, test } from "bun:test"
import { describeReadTool, mediaGuidanceFor, MEDIA_GUIDANCE_MARK } from "../src/describe.ts"
import { resolveOptions } from "../src/options.ts"
import type { MediaCapabilities } from "../src/capabilities.ts"

/** Mirrors the description shipped by the native Read tool (anomalyco/opencode `dev`). */
const BASE =
  "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files."

const caps = (overrides: Partial<MediaCapabilities> = {}): MediaCapabilities => ({
  audio: true,
  video: true,
  image: true,
  pdf: true,
  known: true,
  ...overrides,
})

const opts = resolveOptions(undefined)

describe("describeReadTool", () => {
  test("full-capability model keeps native text and gains one audio/video sentence", () => {
    const out = describeReadTool(BASE, caps(), opts)
    // Native text intact…
    expect(out).toContain("Supports text files, images, and PDFs. Images and PDFs are presented directly to the model.")
    expect(out).toContain("Each text line is prefixed by its 1-based line number")
    // …plus exactly one media sentence, after the "presented directly" sentence.
    expect(out).toContain(
      "Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. " +
        "Audio and video files are also presented directly to the model (mp3, wav, m4a, flac, ogg; mp4, webm, m4v, mov, mkv). " +
        "MKV and WebM are remuxed to MP4 automatically when the transport cannot carry them. " +
        "Files above 20 MB are rejected with an error; use FFmpeg conservatively (fast preset) to compress the file to fit under the limit (MP4 for video, MP3 for audio), then read the compressed file instead of extracting frames.",
    )
  })

  test("audio-only model claims audio but never video", () => {
    const out = describeReadTool(BASE, caps({ video: false }), opts)
    expect(out).toContain("Audio files (mp3, wav, m4a, flac, ogg) are also presented directly to the model.")
    expect(out).not.toContain("video")
    expect(out).not.toContain("Video files")
  })

  test("video-only model claims video but never audio", () => {
    const out = describeReadTool(BASE, caps({ audio: false }), opts)
    expect(out).toContain("Video files (mp4, webm, m4v, mov, mkv) are also presented directly to the model.")
    expect(out).not.toContain("audio")
    expect(out).not.toContain("Audio files")
  })

  test("non-media model: no audio or video claim anywhere", () => {
    const out = describeReadTool(BASE, caps({ audio: false, video: false }), opts)
    expect(out).not.toMatch(/audio|video/i)
    expect(out).toContain("Supports text files, images, and PDFs.")
  })

  test("unknown-capability model claims nothing new", () => {
    const out = describeReadTool(BASE, caps({ audio: null, video: null }), opts)
    expect(out).not.toMatch(/Audio files|Video files/)
  })

  test("matchAllClaims drops image/pdf claims the model cannot ingest", () => {
    const out = describeReadTool(BASE, caps({ audio: false, video: false, image: false }), opts)
    expect(out).toContain("Supports text files and PDFs. PDFs are presented directly to the model.")
    expect(out).not.toContain("images, and PDFs")
    expect(out).not.toContain("Images and PDFs are presented")
  })

  test("text-only model collapses to text claims", () => {
    const out = describeReadTool(BASE, caps({ audio: false, video: false, image: false, pdf: false }), opts)
    expect(out).toContain("Supports text files. Each text line is prefixed")
    expect(out).not.toContain("presented directly to the model")
    expect(out).not.toMatch(/images|PDFs/)
  })

  test("matchAllClaims=false leaves native image/pdf claims untouched", () => {
    const out = describeReadTool(BASE, caps({ audio: false, video: false, image: false, pdf: false }), {
      ...opts,
      matchAllClaims: false,
    })
    expect(out).toContain("Supports text files, images, and PDFs.")
    expect(out).toContain("Images and PDFs are presented directly to the model.")
  })

  test("upstream description change degrades gracefully to appending", () => {
    const changed = "Read a file or directory. Interesting things happen."
    const out = describeReadTool(changed, caps(), opts)
    expect(out.startsWith(changed)).toBe(true)
    expect(out).toContain("Audio and video files are also presented directly to the model")
  })

  test("custom maxBytes shows in the media sentence", () => {
    const out = describeReadTool(BASE, caps(), { ...opts, maxBytes: 1.5 * 1024 * 1024 })
    expect(out).toContain("Files above 1.5 MB are rejected with an error;")
  })
})

describe("mediaGuidanceFor", () => {
  test("capable models get the compress-first guidance", () => {
    const out = mediaGuidanceFor(caps(), opts)
    expect(out).toStartWith(MEDIA_GUIDANCE_MARK)
    expect(out).toContain("larger than 20 MB")
    expect(out).toContain("compress it with FFmpeg (MP4 for video, MP3 for audio, fast preset)")
    expect(out).toContain("instead of extracting frames")
  })

  test("audio-only and video-only targets are tailored", () => {
    expect(mediaGuidanceFor(caps({ video: false }), opts)).toContain("(MP3, fast preset)")
    expect(mediaGuidanceFor(caps({ audio: false }), opts)).toContain("(MP4, fast preset)")
  })

  test("models without media capabilities get no guidance", () => {
    expect(mediaGuidanceFor(caps({ audio: false, video: false }), opts)).toBeUndefined()
    expect(mediaGuidanceFor(caps({ audio: null, video: null }), opts)).toBeUndefined()
    expect(mediaGuidanceFor(caps(), resolveOptions({ audio: false, video: false }))).toBeUndefined()
  })
})
