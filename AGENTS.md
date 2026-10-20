# AGENTS.md

Orientation for agents working on `oc-media`.

## What this is

An OpenCode V2 plugin (**Effect form**, `@opencode/plugin/effect`). It wraps the **native `read`
tool** so it can attach audio/video files as media content, and rewrites the Read tool's
description per model dispatch. Capability data is never hardcoded: it is derived from the
model catalog OpenCode materializes from models.dev (`Model.Info.capabilities.input`,
modality membership via the same `startsWith` rule core's `unsupportedMedia` uses).

## Plugin form: Effect, not Promise — load-bearing

The plugin ships as an **Effect-form plugin** (`define` from `@opencode/plugin/effect`, the
shape of every internal core tool plugin: `Tool.execute` effect executor, `Effect.gen`
setup). This is load-bearing: a Promise-form variant registered transform/hooks that the
agent dispatch never honored (verified over many isolated boots); the Effect form's
registrations bind to the canonical registry and the full dispatch path works live.

Reference sources (read these when in doubt — branch `dev` of `anomalyco/opencode`):

- `packages/core/src/tool/plugin/read.ts`, `read-filesystem.ts` — native read, its MIME gate
  (`MEDIA_MIMES`: images/pdf only), `toModelContent` result shape, 20 MB media limit.
- `packages/plugin/src/promise/adapter.ts` — how `editor.update("read", cb)` hands the
  callback a tool whose `execute` is the native executor bridged to a Promise.
- `packages/core/src/session/model-request.ts` — `unsupportedParts`/`boundImages` dispatch-time
  media handling; `SessionContext` hook `tools` is mutable and overrides descriptions.
- `packages/core/src/file-access.ts` — external-directory approval boundary (the plugin's
  internal/external detection mirrors it).

## Layout

```
src/
  index.ts             glue: transform + hooks registration, session-model tracking
  executor.ts          the wrapped Effect read executor (delegate / reject / attach / inject)
  decide.ts            pure decision matrix: delegate / reject / attach
  describe.ts          description rewriter (anchored on the native base text)
  capabilities.ts      capability derivation (fail-closed)
  capability-cache.ts  Effect TTL cache over ctx.model.list() (+ transport package lookup)
  media-read.ts        file read → native image/PDF-shaped result (+ size for the stash)
  injection.ts         raw-body delivery: session-scoped MediaStash, note texts (+ random
                       attachment tokens), input_audio/video_url parts, chat-body splicing,
                       chat-shaped package detection
  transport-refusals.ts learned transport refusals + outgoing-history sanitization
  errors.ts            model-facing error messages
  options.ts           option parsing
  paths.ts             lexical path helpers (containment, ~ expansion, binary-gate detection)
test/                  bun tests at the module seams
```

## Invariants (do not break)

1. **Never reimplement native read.** Anything that isn't an audio/video extension delegates
   to the captured native executor — missing files, images, PDFs, dirs, EPDFs… — so upstream
   behavior (offsets, AGENTS.md discovery, error UX) is preserved.
2. **Rejects happen before any full read or prompt**: size, capability, unknown-capability gates
   all run before touching the file, except (a) a 1 KiB content probe (text vs media) that must
   precede media routing — `.ts` maps to `video/mp2t` in the mime database but is usually
   TypeScript source — and (b) the external-directory flow where delegation must run first to
   trigger OpenCode's permission prompt (the documented dance in `executor.ts`).
3. **Fail closed on unknown capability data** unless `allowUnknown`.
4. The description rewrite always starts from the pristine native base text, never from a
   previous output; incapable models must get a description with **zero** audio/video claims.
5. Zero-byte media files get their own error; oversize files name real size + limit.
6. **Raw-body injection never bypasses the capability gate.** Injection only fires for
   modalities the dispatching model declares (`capabilities.forEffect(event.model)`), and
   chat-shaped delivery is chosen by the catalog `package` field — never by a hardcoded
   model list. Injected parts are the de-facto OpenAI-compatible extensions
   (`input_audio`, `video_url`); notes in tool results are the only model-visible artifact,
   and they must stay the exact text the stash is keyed on (`injection.ts`).
7. **Stash entries are owned by the session that read them.** Notes embed a random 128-bit
   attachment token (`newAttachmentToken`), the stash binds `sessionId` into both the entry
   key and `find`, and the `http.request` hook passes the dispatching session — never
   reduce lookup to description/filename matching (that is the cross-session disclosure
   vector, see `test/injection.test.ts` "session isolation"). Lifetime: entries are dropped
   on `session.deleted` and re-homed only along a `session.forked` parent→child lineage;
   isolation itself must not depend on those events (ownership is verified at injection).

## Commands

```sh
bun test          # full suite
bun test test/executor.test.ts   # single file
bun run typecheck # tsc --noEmit (strict)
```

Seams (test here): `decide` matrix, `describeReadTool` text, capability derivation/cache,
`createEffectRead` flows with a stubbed native executor, `injectMediaIntoChatBody` +
`MediaStash`, path helpers. `src/index.ts` transform/hook wiring is thin glue validated
live against OpenCode, not mocked.
