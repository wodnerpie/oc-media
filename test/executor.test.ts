import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEffectRead } from "../src/executor.ts"
import { CapabilityCache } from "../src/capability-cache.ts"
import type { CapabilityLookup } from "../src/capabilities.ts"
import type { MediaCapabilities, ModelInfoLike, ModelRefLike } from "../src/capabilities.ts"
import { MediaStash } from "../src/injection.ts"
import { resolveOptions } from "../src/options.ts"

const dir = await mkdtemp(join(tmpdir(), "oc-media-executor-"))
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const GEMINI = {
  providerID: "google",
  id: "gemini-2.5-pro",
  capabilities: { input: ["text", "image", "audio", "video", "pdf"] },
} satisfies ModelInfoLike
const CLAUDE = {
  providerID: "anthropic",
  id: "claude-sonnet-4-5",
  capabilities: { input: ["text", "image", "pdf"] },
} satisfies ModelInfoLike

const catalog = new CapabilityCache(Effect.succeed([CLAUDE, GEMINI]))
const emptyCatalog = new CapabilityCache(Effect.succeed([]))
const sessionIDs = new Map<string, ModelRefLike>([
  ["ses_gemini", GEMINI],
  ["ses_claude", CLAUDE],
  ["ses_custom", { providerID: "custom", id: "m" }],
])
const sessionModel = (sessionID: string): Effect.Effect<ModelRefLike | undefined> =>
  Effect.succeed(sessionIDs.get(sessionID))

const opts = resolveOptions(undefined)
const ctx = { sessionID: "ses_gemini", agent: "build", messageID: "msg_1", id: "call_1" }

function nativeStub(overrides: { error?: unknown } = {}) {
  const calls: { input: unknown }[] = []
  const native = (input: unknown) => {
    calls.push({ input })
    if (overrides.error !== undefined) return Effect.fail(overrides.error)
    return Effect.succeed({ content: [{ type: "text", text: "native result" }] })
  }
  return { calls, native }
}

const outcomeOf = <T>(effect: Effect.Effect<T, unknown>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
  Effect.runPromise(Effect.result(effect as Effect.Effect<T, unknown>)).then((outcome) => {
    if (Result.isSuccess(outcome)) return { ok: true as const, value: outcome.success }
    return { ok: false as const, error: outcome.failure }
  })

describe("createEffectRead", () => {
  test("non-media files delegate byte-for-byte", async () => {
    await writeFile(join(dir, "notes.txt"), "hello")
    const { calls, native } = nativeStub()
    const read = createEffectRead({ options: opts, directory: dir, capabilities: catalog, sessionModel })
    const input = { path: "./notes.txt" }
    const result = await outcomeOf(read(input, ctx, native))
    expect(result.ok, "delegate must succeed").toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.input).toBe(input)
  })

  test("capable internal audio attaches without touching native", async () => {
    await writeFile(join(dir, "song.mp3"), Buffer.from([0x49, 0x44, 0x33, 4]))
    const { calls, native } = nativeStub()
    const read = createEffectRead({ options: opts, directory: dir, capabilities: catalog, sessionModel })
    const result = await outcomeOf(read({ path: "song.mp3" }, ctx, native))
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(0)
    const content = (result as { ok: true; value: { content: unknown[] } }).value.content
    expect((content[1] as { type: string }).type).toBe("file")
    expect((content[1] as { uri: string }).uri.startsWith("data:audio/mpeg;base64,")).toBe(true)
  })

  test("incapable models get the capability error and no native call", async () => {
    await writeFile(join(dir, "rejected.mp3"), "zz")
    const { calls, native } = nativeStub()
    const read = createEffectRead({ options: opts, directory: dir, capabilities: catalog, sessionModel })
    const result = await outcomeOf(read({ path: "rejected.mp3" }, { ...ctx, sessionID: "ses_claude" }, native))
    expect(result.ok).toBe(false)
    expect(String((result as { ok: false; error: { message?: string } }).error.message)).toContain(
      "does not support audio input",
    )
    expect(calls).toHaveLength(0)
  })

  test("oversize rejection short-circuits before any read", async () => {
    await writeFile(join(dir, "huge.mp3"), "1234567890")
    const { calls, native } = nativeStub()
    const read = createEffectRead({
      options: resolveOptions({ maxBytes: 5 }),
      directory: dir,
      capabilities: catalog,
      sessionModel,
    })
    const result = await outcomeOf(read({ path: "huge.mp3" }, ctx, native))
    expect(result.ok).toBe(false)
    expect(String((result as { ok: false; error: { message?: string } }).error.message)).toContain("larger than the")
    expect(calls).toHaveLength(0)
  })

  test("missing media paths keep the native missing-file experience", async () => {
    const { calls, native } = nativeStub({ error: new Error('File not found: "dne.mp3"') })
    const read = createEffectRead({ options: opts, directory: dir, capabilities: catalog, sessionModel })
    const result = await outcomeOf(read({ path: "dne.mp3" }, ctx, native))
    expect(result.ok).toBe(false)
    expect(String((result as { ok: false; error: { message?: string } }).error.message)).toContain("File not found")
    expect(calls).toHaveLength(1)
  })

  test("external media: native runs first (permission approval), then we attach", async () => {
    const outside = join(tmpdir(), "oc-media-executor-outside")
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, "movie.mp4"), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]))
    try {
      const SEP = String.fromCharCode(92)
      const { calls, native } = nativeStub({
        error: new Error(`Cannot read binary file: C:${SEP}media${SEP}movie.mp4`),
      })
      const read = createEffectRead({ options: opts, directory: dir, capabilities: catalog, sessionModel })
      const result = await outcomeOf(read({ path: join(outside, "movie.mp4") }, ctx, native))
      expect(result.ok).toBe(true)
      expect(calls).toHaveLength(1)
      const content = (result as { ok: true; value: { content: unknown[] } }).value.content
      expect((content[1] as { uri: string }).uri.startsWith("data:video/mp4;base64,")).toBe(true)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("external denial during the dance propagates unchanged", async () => {
    const { calls, native } = nativeStub({ error: new Error("Permission request denied: external_directory") })
    const read = createEffectRead({ options: opts, directory: dir, capabilities: catalog, sessionModel })
    const result = await outcomeOf(read({ path: join(tmpdir(), "no-such-place.mp4") }, ctx, native))
    expect(result.ok).toBe(false)
    expect(String((result as { ok: false; error: { message?: string } }).error.message)).toContain("Permission request denied")
    expect(calls).toHaveLength(1)
  })

  test("unknown-capability models fail closed unless allowUnknown", async () => {
    const writeProbe = join(dir, "unknown-audio.mp3")
    await writeFile(writeProbe, "zz")
    const { native } = nativeStub()
    const conservative = createEffectRead({
      options: opts,
      directory: dir,
      capabilities: emptyCatalog,
      sessionModel,
    })
    const failed = await outcomeOf(conservative({ path: "unknown-audio.mp3" }, { ...ctx, sessionID: "ses_custom" }, native))
    expect(failed.ok).toBe(false)
    expect(String((failed as { ok: false; error: { message?: string } }).error.message)).toContain(
      "capabilities of the current model",
    )

    const permissive = createEffectRead({
      options: resolveOptions({ allowUnknown: true }),
      directory: dir,
      capabilities: emptyCatalog,
      sessionModel,
    })
    const result = await outcomeOf(permissive({ path: "unknown-audio.mp3" }, ctx, native))
    expect(result.ok).toBe(true)
    expect((result as { ok: true; value: { content: unknown[] } }).value.content).toHaveLength(2)
  })

  test("capability-passing media is refused upfront when the transport previously refused it", async () => {
    await writeFile(join(dir, "transport-blocked.mp4"), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]))
    const { calls, native } = nativeStub()
    const read = createEffectRead({
      options: opts,
      directory: dir,
      capabilities: catalog,
      sessionModel,
      transportRefused: (ref, modality) => ref?.id === "gemini-2.5-pro" && modality === "video",
    })
    const result = await outcomeOf(read({ path: "transport-blocked.mp4" }, ctx, native))
    expect(result.ok).toBe(false)
    expect(String((result as { ok: false; error: { message?: string } }).error.message)).toContain(
      "transport serving the current model",
    )
    expect(calls).toHaveLength(0)
  })

  test("inject delivery: a note is returned and the bytes go to the stash", async () => {
    await writeFile(join(dir, "injected.mp3"), Buffer.from([0x49, 0x44, 0x33, 4]))
    const { calls, native } = nativeStub()
    const stash = new MediaStash()
    const read = createEffectRead({
      options: opts,
      directory: dir,
      capabilities: catalog,
      sessionModel,
      stash,
      injectDelivery: () => Effect.succeed(true),
    })
    const result = await outcomeOf(read({ path: "injected.mp3" }, ctx, native))
    expect(result.ok).toBe(true)
    const value = (result as { ok: true; value: { content: unknown[]; metadata: Record<string, unknown> } }).value
    expect(value.content).toHaveLength(1)
    expect((value.content[0] as { type: string }).type).toBe("text")
    expect(String((value.content[0] as { text: string }).text)).toStartWith("[media attached: injected.mp3")
    expect(calls).toHaveLength(0)
    expect(stash.size()).toBe(1)
    expect(value.metadata["oc-media"]).toBeDefined()
  })

  test("inject delivery: a learned refusal still delivers instead of failing", async () => {
    await writeFile(join(dir, "refused-but-injected.mp4"), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]))
    const { native } = nativeStub()
    const stash = new MediaStash()
    const read = createEffectRead({
      options: opts,
      directory: dir,
      capabilities: catalog,
      sessionModel,
      transportRefused: () => true,
      stash,
      injectDelivery: () => Effect.succeed(true),
    })
    const result = await outcomeOf(read({ path: "refused-but-injected.mp4" }, ctx, native))
    expect(result.ok).toBe(true)
    expect(stash.size()).toBe(1)
  })

  test("inject disabled: a learned refusal keeps the upfront failure", async () => {
    await writeFile(join(dir, "no-inject.mp4"), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]))
    const { native } = nativeStub()
    const stash = new MediaStash()
    const read = createEffectRead({
      options: resolveOptions({ inject: false }),
      directory: dir,
      capabilities: catalog,
      sessionModel,
      transportRefused: () => true,
      stash,
      injectDelivery: () => Effect.succeed(false),
    })
    const result = await outcomeOf(read({ path: "no-inject.mp4" }, ctx, native))
    expect(result.ok).toBe(false)
    expect(String((result as { ok: false; error: { message?: string } }).error.message)).toContain(
      "transport serving the current model",
    )
  })
})
