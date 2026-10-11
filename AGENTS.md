# AGENTS.md

Orientation for agents working on `oc-media`.

## What this is

An OpenCode V2 plugin (Promise form, `@opencode/plugin`). It wraps the **native `read`
tool** so it can attach audio/video files as media content, and rewrites the Read tool's
description per model dispatch. Capability data is never hardcoded: it is derived from the
model catalog OpenCode materializes from models.dev (`Model.Info.capabilities.input`,
modality membership via the same `startsWith` rule core's `unsupportedMedia` uses).

## AGENTS.md header update — Effect form

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
  index.ts        glue only: transform + hooks registration, session-model tracking
  wrapper.ts      the wrapped executor decision flows (factory: createWrappedRead)
  decide.ts       pure decision matrix: delegate / reject / attach
  describe.ts     description rewriter (anchored on the native base text)
  capabilities.ts capability derivation + TTL cache (fail-closed)
  media-read.ts   file read → native image/PDF-shaped result
  errors.ts       model-facing error messages
  options.ts      option parsing
  paths.ts        lexical path helpers (containment, ~ expansion, binary-gate detection)
test/            bun tests at the module seams
```

## Invariants (do not break)

1. **Never reimplement native read.** Anything that isn't an audio/video extension delegates
   to the captured native executor — missing files, images, PDFs, dirs, EPDFs… — so upstream
   behavior (offsets, AGENTS.md discovery, error UX) is preserved.
2. **Rejects happen before any read or prompt**: size, capability, unknown-capability gates all
   run before touching the file, except the external-directory flow where delegation must run
   first to trigger OpenCode's permission prompt (that's the documented dance in `wrapper.ts`).
3. **Fail closed on unknown capability data** unless `allowUnknown`.
4. The description rewrite always starts from the pristine native base text, never from a
   previous output; incapable models must get a description with **zero** audio/video claims.
5. Zero-byte media files get their own error; oversize files name real size + limit.

## Commands

```sh
bun test          # full suite
bun test test/wrapper.test.ts   # single file
bun run typecheck # tsc --noEmit (strict)
```

Seams (test here): `decide` matrix, `describeReadTool` text, capability derivation/cache,
`createWrappedRead` flows with a stubbed native executor, path helpers. `src/index.ts`
transform/hook wiring is thin glue validated live against OpenCode, not mocked.
