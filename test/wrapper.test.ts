import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWrappedRead } from "../src/wrapper.ts"
import { CapabilityCache, type ModelInfoLike, type ModelRefLike } from "../src/capabilities.ts"
import { resolveOptions } from "../src/options.ts"

const dir = await mkdtemp(join(tmpdir(), "oc-media-wrapper-"))
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

const catalog = new CapabilityCache(async () => [CLAUDE, GEMINI])
const emptyCatalog = new CapabilityCache(async () => [])
const sessionIDs = new Map<string, ModelRefLike>([
  ["ses_gemini", GEMINI],
  ["ses_claude", CLAUDE],
  ["ses_custom", { providerID: "custom", id: "m" }],
])
const sessionModel = async (sessionID: string): Promise<ModelRefLike | undefined> => sessionIDs.get(sessionID)

const opts = resolveOptions(undefined)
const ctx = { sessionID: "ses_gemini", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal, progress: async () => {} }

function nativeStub(overrides: { error?: unknown } = {}) {
  const calls: { input: unknown }[] = []
  const native = async (input: unknown) => {
    calls.push({ input })
    if (overrides.error !== undefined) throw overrides.error
    return { content: [{ type: "text", text: "native result" }] }
  }
  return { calls, native }
}

describe("createWrappedRead", () => {
  test("non-media files delegate byte-for-byte", async () => {
    await writeFile(join(dir, "notes.txt"), "hello")
    const { calls, native } = nativeStub()
    const read = createWrappedRead({ options: opts, directory: dir, capabilities: catalog, sessionModel })
    const input = { path: "./notes.txt" }
    expect(await read(input, ctx, native)).toEqual({ content: [{ type: "text", text: "native result" }] })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.input).toBe(input)
  })

  test("capable internal audio attaches without touching native", async () => {
    await writeFile(join(dir, "song.mp3"), Buffer.from([0x49, 0x44, 0x33, 4]))
    const { calls, native } = nativeStub()
    const read = createWrappedRead({ options: opts, directory: dir, capabilities: catalog, sessionModel })
    const result = (await read({ path: "song.mp3" }, ctx, native)) as { content: unknown[] }
    expect(calls).toHaveLength(0)
    expect((result.content[1] as { type: string }).type).toBe("file")
    expect((result.content[1] as { uri: string }).uri.startsWith("data:audio/mpeg;base64,")).toBe(true)
  })

  test("incapable models get the capability error and no native call", async () => {
    await writeFile(join(dir, "rejected.mp3"), "zz")
    const { calls, native } = nativeStub()
    const read = createWrappedRead({ options: opts, directory: dir, capabilities: catalog, sessionModel })
    await expect(read({ path: "rejected.mp3" }, context("ses_claude"), native)).rejects.toThrow(
      /does not support audio input/,
    )
    expect(calls).toHaveLength(0)
  })

  test("oversize rejection short-circuits before any read", async () => {
    await writeFile(join(dir, "huge.mp3"), "1234567890")
    const { calls, native } = nativeStub()
    const read = createWrappedRead({
      options: resolveOptions({ maxBytes: 5 }),
      directory: dir,
      capabilities: catalog,
      sessionModel,
    })
    await expect(read({ path: "huge.mp3" }, ctx, native)).rejects.toThrow(
      /larger than the 0 MB inline media ingestion limit/,
    )
    expect(calls).toHaveLength(0)
  })

  test("missing media paths keep the native missing-file experience", async () => {
    const { calls, native } = nativeStub({ error: new Error('File not found: "dne.mp3"') })
    const read = createWrappedRead({ options: opts, directory: dir, capabilities: catalog, sessionModel })
    await expect(read({ path: "dne.mp3" }, ctx, native)).rejects.toThrow(/File not found/)
    expect(calls).toHaveLength(1)
  })

  test("external media: native runs first (permission approval), then we attach", async () => {
    const outside = join(tmpdir(), "oc-media-wrapper-outside")
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, "movie.mp4"), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]))
    try {
      const { calls, native } = nativeStub({
        error: new Error(`Cannot read binary file: C:${String.fromCharCode(92)}media${String.fromCharCode(92)}movie.mp4`),
      })
      const read = createWrappedRead({ options: opts, directory: dir, capabilities: catalog, sessionModel })
      const result = (await read({ path: join(outside, "movie.mp4") }, ctx, native)) as { content: unknown[] }
      expect(calls).toHaveLength(1)
      expect((result.content[1] as { uri: string }).uri.startsWith("data:video/mp4;base64,")).toBe(true)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("external denial during the dance propagates unchanged", async () => {
    const { calls, native } = nativeStub({ error: new Error("Permission request denied: external_directory") })
    const read = createWrappedRead({ options: opts, directory: dir, capabilities: catalog, sessionModel })
    await expect(read({ path: join(tmpdir(), "no-such-place.mp4") }, ctx, native)).rejects.toThrow(/Permission request denied/)
    expect(calls).toHaveLength(1)
  })

  test("unknown-capability models fail closed unless allowUnknown", async () => {
    await writeFile(join(dir, "unknown-audio.mp3"), "zz")
    const { native } = nativeStub()
    const conservative = createWrappedRead({
      options: opts,
      directory: dir,
      capabilities: emptyCatalog,
      sessionModel,
    })
    await expect(conservative({ path: "unknown-audio.mp3" }, context("ses_custom"), native)).rejects.toThrow(
      /capabilities of the current model .+ are unknown/,
    )

    const permissive = createWrappedRead({
      options: resolveOptions({ allowUnknown: true }),
      directory: dir,
      capabilities: emptyCatalog,
      sessionModel,
    })
    const result = (await permissive({ path: "unknown-audio.mp3" }, ctx, native)) as { content: unknown[] }
    expect(result.content).toHaveLength(2)
  })
})

function context(sessionID: string) {
  return { ...ctx, sessionID }
}
