import type { MediaCapabilities } from "./capabilities.ts"
import { maxBytesLabel, type Options } from "./options.ts"

/**
 * Per-dispatch Read description rewriter.
 *
 * The base text is captured from the native tool at registration, so every
 * other sentence survives upstream changes untouched. Here we only:
 * 1. rebuild the media claims (`Supports …` + `presented directly …`) so
 *    they reflect what the model can actually ingest, and
 * 2. append one audio/video sentence — only if the model ingests that
 *    modality. A model without audio/video support gets a description that
 *    never claims it can read audio or video.
 *
 * The function is always applied to the pristine base, never to a previous
 * output, so repeated dispatches stay idempotent.
 */

export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "flac", "ogg"] as const
export const VIDEO_EXTENSIONS = ["mp4", "webm", "m4v", "mov", "mkv"] as const

const CLAIMS_SENTENCE = "Supports text files, images, and PDFs."
const PRESENTED_SENTENCE = "Images and PDFs are presented directly to the model."

/** "A", "A and B", "A, B, and C". */
function list(items: readonly string[]): string {
  if (items.length === 0) return ""
  const first = items.at(0) ?? ""
  const last = items.at(-1) ?? ""
  if (items.length === 1) return first
  if (items.length === 2) return `${first} and ${last}`
  return `${items.slice(0, -1).join(", ")}, and ${last}`
}

function mediaSentence(caps: MediaCapabilities, options: Options): string {
  const audio = caps.audio === true && options.audio ? AUDIO_EXTENSIONS.join(", ") : undefined
  const video = caps.video === true && options.video ? VIDEO_EXTENSIONS.join(", ") : undefined
  if (!audio && !video) return ""

  const target = audio && video ? "MP4 for video, MP3 for audio" : video ? "MP4" : "MP3"
  const frames = video ? " instead of extracting frames" : ""
  const remux = video ? " MKV and WebM are remuxed to MP4 automatically when the transport cannot carry them." : ""
  const cap =
    `Files above ${maxBytesLabel(options.maxBytes)} MB are rejected with an error; ` +
    `use FFmpeg conservatively to compress the file to fit under the limit (${target}), ` +
    `then read the compressed file${frames}.`
  if (audio && video) {
    return `Audio and video files are also presented directly to the model (${audio}; ${video}).${remux} ${cap}`
  }
  if (audio) return `Audio files (${audio}) are also presented directly to the model. ${cap}`
  return `Video files (${video}) are also presented directly to the model.${remux} ${cap}`
}

/** First words of the system-prompt guidance; also the idempotence marker. */
export const MEDIA_GUIDANCE_MARK = "Media files can be read directly:"

/**
 * System-prompt line for media-capable models. The read-tool description
 * alone proved too easy to skip at planning time — agents jump straight to
 * frame extraction — so the same guidance also rides in the system prompt.
 * `undefined` when the model cannot ingest any media.
 */
export function mediaGuidanceFor(caps: MediaCapabilities, options: Options): string | undefined {
  const audio = caps.audio === true && options.audio
  const video = caps.video === true && options.video
  if (!audio && !video) return undefined
  const target = audio && video ? "MP4 for video, MP3 for audio" : video ? "MP4" : "MP3"
  return (
    `${MEDIA_GUIDANCE_MARK} the read tool delivers audio and video content to you. ` +
    `If a media file is larger than ${maxBytesLabel(options.maxBytes)} MB, compress it with FFmpeg ` +
    `(${target}) and read the compressed file instead of extracting frames.`
  )
}

function claimsSentence(caps: MediaCapabilities, options: Options): string | undefined {
  if (!options.matchAllClaims) return undefined
  const items = ["text files"]
  if (caps.image === true) items.push("images")
  if (caps.pdf === true) items.push("PDFs")
  const built = `Supports ${list(items)}.`
  return built === CLAIMS_SENTENCE ? undefined : built
}

function presentedSentence(caps: MediaCapabilities, options: Options): string | undefined {
  if (!options.matchAllClaims) return undefined
  if (caps.image && caps.pdf) return undefined // native sentence already correct
  if (caps.image) return "Images are presented directly to the model."
  if (caps.pdf) return "PDFs are presented directly to the model."
  return ""
}

export function describeReadTool(base: string, caps: MediaCapabilities, options: Options): string {
  let out = base

  const claims = claimsSentence(caps, options)
  if (claims !== undefined && out.includes(CLAIMS_SENTENCE)) out = out.replace(CLAIMS_SENTENCE, claims)

  const presented = presentedSentence(caps, options)
  if (presented !== undefined && out.includes(PRESENTED_SENTENCE)) out = out.replace(PRESENTED_SENTENCE, presented)
  out = out.replace(/\s{2,}/g, " ").trim()

  const media = mediaSentence(caps, options)
  if (!media) return out

  // Anchor preference: after the "presented directly" sentence (native claim
  // block stays contiguous), else after the claims sentence, else append.
  const anchors = [PRESENTED_SENTENCE, presented, claims ?? CLAIMS_SENTENCE].filter(
    (item): item is string => typeof item === "string",
  )
  for (const anchor of anchors) {
    const at = out.indexOf(anchor)
    if (at === -1) continue
    const afterDot = at + anchor.length
    const next = out.slice(afterDot, afterDot + 1) === " " ? afterDot + 1 : afterDot
    return `${out.slice(0, next)}${media} ${out.slice(next)}`.replace(/\s{2,}/g, " ").trim()
  }
  return `${out} ${media}`.replace(/\s{2,}/g, " ").trim()
}
