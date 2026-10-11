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
| **cannot ingest** (e.g. Claude, GPT) | fails with a precise tool error naming the file, the modality, and the model id | makes **no** audio/video claim at all |
| has **no capability data** | fails closed with an "capabilities unknown" error (+ `allowUnknown` escape hatch) | makes no audio/video claim |

## Install

```jsonc
// opencode.json(c)
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "oc-media" }
  ]
}
```

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
- The Read tool **description** is rewritten per dispatch via session hooks, so a capable
  model learns *when* to reach for `read` on media — and an incapable one never sees a claim
  it can't fulfill.
- Rejections happen **before** any file read or permission prompt, with model-facing errors:

  ```
  Cannot read "demo/song.mp3": the current model (anthropic/claude-sonnet-4-5) does not
  support audio input (mime type: audio/mpeg), so the file cannot be attached as inline
  audio media. Use another way to inspect it … or tell the user to switch to a model that
  accepts inline audio media (for example a Gemini model).
  ```

## Options

```jsonc
{
  "plugins": [
    {
      "package": "oc-media",
      "options": {
        "maxBytes": 20971520,     // largest media file attached inline (default 20 MiB —
                                  // OpenCode's own media limit / Gemini inline budget)
        "allowUnknown": false,    // attach media for models with no capability data?
        "matchAllClaims": true,   // also trim image/PDF claims for text-only models
        "audio": true,            // master switch per modality
        "video": true
      }
    }
  ]
}
```

Known limitations (inherent to inline attachment, no transcoding involved):

- Media larger than `maxBytes` is refused with an explicit error (no Files-API upload).
- OpenAI's audio API only accepts mp3/wav; models.dev capability lists are modality-level,
  so a flac read may be attached and then rejected by the API. Point gap-fix feedback to
  [issues](https://github.com/wodnerpie/oc-media/issues).
- Very old OpenCode builds (pre-V2 plugin API) aren't supported; the plugin disables itself
  with a warning if it can't find the native `read` tool.

## Development

```sh
bun install
bun test          # unit+integration suites (decision matrix, description, wrapper flows…)
bun run typecheck # tsc --noEmit
```

Architecture notes live in [AGENTS.md](AGENTS.md).
