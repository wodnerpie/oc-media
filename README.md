# oc-media

**[OpenCode](https://opencode.ai) plugin:** teaches the native `read` tool to ingest **audio**
and **video** files — exactly like it already ingests images and PDFs — and adapts the Read
tool's own description to each model's real capabilities, using the model catalog OpenCode
derives from [models.dev](https://models.dev).

No model lists are hardcoded. The plugin asks, per session, per model: *"can this model ingest
inline audio/video?"* — and behaves accordingly:

| The current model… | `read` on an audio/video file | Read tool description claims |
|---|---|---|
| **ingests that media** (e.g. Gemini) | attaches the bytes as real media content (`Audio/Video read successfully`) | says it can read audio/video files |
| **advertises it, but runs on an OpenAI-Chat-shaped route** (OpenCode Go, OpenRouter, DeepInfra…) | delivers the bytes through the **raw request body** (`input_audio` / `video_url` parts spliced in at the last moment) — the model really hears/sees them | says it can read audio/video files |
| **cannot ingest** (e.g. Claude, GPT) | fails with a precise tool error naming the file, the modality, and the model id | makes **no** audio/video claim at all |
| has **no capability data** | fails closed with an "capabilities unknown" error (+ `allowUnknown` escape hatch) | makes no audio/video claim |

## Install

```jsonc
// opencode.json(c)
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["oc-media@latest"]
}
```

Use the version tag — `oc-media@latest`, or pin one (e.g. `oc-media@0.1.0`) — so
OpenCode installs the package for you. A bare `"oc-media"` entry is not
auto-installed and is silently skipped when the package isn't already available.

Local copy instead?

```jsonc
{
  "plugins": ["E:/path/to/oc-media"]
}
```

## What it reaches for under the hood

- The plugin **wraps the native `read` tool** through the official `ctx.tool.transform` API.
  Text files, images, PDFs, missing-file UX ("Did you mean…?"), directories, external-directory
  permission prompts — **all remain byte-for-byte native** because the original executor is
  captured and delegated to. The plugin only intercepts files whose extension maps to
  `audio/*` or `video/*`.
- For ingestible media it returns the **same result shape the native tool returns for
  images/PDFs** (`{ text, file content with a data URL }`), so OpenCode's own protocol layer
  (`toolFileMedia`) lowers it into provider media parts, and OpenCode's own
  `unsupportedParts` stripping keeps history safe if the session switches models mid-flight.
- **Media extensions are never trusted blindly.** A 1 KiB content probe (the native binary
  rule plus known container signatures) runs before the media path — so `.ts` TypeScript
  source, which the mime database maps to `video/mp2t`, stays with the native text read
  instead of being rejected as video (or attached as a fake MPEG stream).
- **Raw-body delivery for chat-shaped routes.** OpenCode's OpenAI-Chat protocol adapter refuses
  audio/video media parts outright (`OpenAI Chat does not support media type audio/wave`) —
  before any HTTP request exists, so no hook can repair the typed request. On those routes
  (detected from the catalog's transport `package`, never a hardcoded model list) the read
  result instead carries a plain-text note while the bytes go into an in-memory stash; the
  `http.request` session hook splices provider-native content parts into the raw JSON body at
  the last moment — `input_audio` for audio, `video_url` for video. Injection only ever fires
  for modalities the dispatching model declares, and the notes are the only thing that ever
  appears in message text.
- The Read tool **description** is rewritten per dispatch via session hooks, so a capable
  model learns *when* to reach for `read` on media — and an incapable one never sees a claim
  it can't fulfill. Media-capable models also get one **system-prompt line** saying the read
  tool delivers audio/video directly and that oversize files should be compressed with
  FFmpeg (MP4/MP3) rather than sampled as frames — the tool description alone proved too
  easy to skip at planning time.
- Rejections happen **before** any file read or permission prompt, with model-facing errors:

  ```
  Cannot read "demo/song.mp3": the current model (anthropic/claude-sonnet-4-5) does not
  support audio input (mime type: audio/mpeg), so the file cannot be attached as inline
  audio media.
  ```

  (Capable models' descriptions and the size error both direct the agent to use FFmpeg
  conservatively to compress an oversize file to MP4/MP3 and read the compressed file,
  rather than falling back to extracted frames.)

## Options

```jsonc
{
  "plugins": [
    {
      "package": "oc-media@latest",
      "options": {
        "maxBytes": 20971520,     // largest media file attached inline (default 20 MiB —
                                  // OpenCode's own media limit / Gemini inline budget)
        "allowUnknown": false,    // attach media for models with no capability data?
        "matchAllClaims": true,   // also trim image/PDF claims for text-only models
        "audio": true,            // master switch per modality
        "video": true,
        "inject": true            // deliver media through the raw request body when the
                                  // typed layer can't carry it (OpenCode Go, OpenRouter…)
      }
    }
  ]
}
```

## Verified live (OpenCode 2.0.26)

- **Fail-closed on incapable models**: `read` on `demo.wav` in a session running claude-haiku
  produces the model-facing rejection naming the actual running model and the mime type.
  Verified via REST-driven session against an isolated `opencode serve`.
- **Attach on capable models**: `read` on `demo.mp4` in a session running a video-capable model
  completes with `[{text "Video read successfully"}, {file data:video/mp4;…}]` — real media bytes
  in the tool result, exactly like native image reads.
- **Raw-body delivery through OpenCode Go** (`opencode-go/mimo-v2.6-flash`, the route whose
  typed layer refuses audio/video outright): `read` on a WAV of spoken dialogue returned a
  correct transcription — *"It's speech… 'Hello friend, welcome to our dubbing game'"* — and
  `read` on a 2.1 MB MP4 returned a detailed description of the actual footage (correctly
  identifying the Sintel trailer's blizzard opening, monochrome palette, and the woman with
  the staff). Both were delivered as `input_audio` / `video_url` parts spliced into the raw
  request body at the `http.request` hook, after the typed layer had refused them.

Known limitations (inherent to inline attachment, no transcoding involved):

- Media larger than `maxBytes` is refused with an explicit error whose text directs the agent
  to compress it with FFmpeg (MP4 for video, MP3 for audio) and read the compressed file.
- **Containers matter more than codecs on OpenCode Go — and MKV/WebM are handled
  automatically.** Verified live against `opencode-go/mimo-v2.6-flash`: AV1, VP9, Opus,
  FLAC, M4A, MP3 and WAV are all genuinely *perceived* by the model (speech transcribed,
  scenes described correctly), but the video *container* must be MP4/WMV/MOV/AVI — MKV and
  WebM are rejected by the gateway with `invalid video format, only mp4/wmv/mov/avi are
  supported`. On such routes the plugin therefore **remuxes MKV/WebM to MP4 before
  delivery**: stream copy whenever the codecs fit (AV1, VP9, Opus all do), audio-only
  transcode to rescue Vorbis (common in WebM), full transcode as a last resort — and a
  clear actionable error if FFmpeg cannot do it. That is also why the FFmpeg guidance
  targets MP4 for compressed video.
- **Provider protocol ≠ catalog claim — the plugin self-heals and delivers anyway.**
  Capabilities come from models.dev and are modality-level; they say nothing about a given
  *transport*. Verified live across every transport available on the test machine: OpenCode Go
  (glm-5.3-flash video, space-bunny video, mimo-v2.6-flash audio) and OpenRouter
  (google/gemini-2.5-flash video) all carry models whose catalog advertises audio/video input,
  yet each **rejects the typed media part at OpenCode's own OpenAI-chat protocol lowering**
  with `provider.invalid-request: OpenAI Chat does not support media type audio/wave|video/mp4`.
  That is a limit of the typed layer, not of the model — so the plugin routes around it: for
  chat-shaped transports (detected from the catalog's transport `package`) and for any route
  with a learned refusal, the read result carries a note and the media is spliced into the raw
  request body at the `http.request` hook (`input_audio` / `video_url`), which the OpenCode Go
  gateway forwards — verified live. When a refusal is learned anyway (first attempt on an
  unknown route), the retry is vetoed, the un-deliverable typed media is stripped from
  subsequent *outgoing* requests so the session keeps working, and later reads deliver via
  injection. Set `"inject": false` to fall back to conservative upfront refusals instead.
  Routes whose protocol carries media natively (e.g. a native Google provider) keep the typed
  path. Point gap-fix feedback to [issues](https://github.com/wodnerpie/oc-media/issues).
- Very old OpenCode builds (pre-V2 plugin API) aren't supported; the plugin disables itself
  with a warning if it can't find the native `read` tool.

## Local development

```sh
bun install
bun test          # unit+integration suites (decision matrix, description, wrapper flows…)
bun run typecheck # tsc --noEmit
```

**Checking it live.** Point a test project at your checkout:

```jsonc
// <test-dir>/opencode.jsonc
{ "plugins": ["E:/path/to/oc-media"] }
```

Then `opencode run` in that directory. Two caveats learned the hard way:

- **Restart the background service after plugin-code edits** (`opencode service restart`).
  The service compiles local plugin sources once per location; edits to already-compiled
  modules don't take effect until the location is reloaded, and hot reloads can leave fresh
  sessions with the previously captured tool snapshot. Restart + new session is authoritative.
- The package's root `index.ts` barrel is required: OpenCode's loader resolves local directory
  plugins through root file candidates (`server`, then `index`) and ignores the `package.json`
  `exports` map for directory sources — a plugin directory without a root `index` fails to
  resolve silently.

Architecture notes live in [AGENTS.md](AGENTS.md).
