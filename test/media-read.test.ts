import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readMediaFile } from "../src/media-read.ts"

const dir = await mkdtemp(join(tmpdir(), "oc-media-test-"))

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("readMediaFile", () => {
  test("audio file: native-parable result shape with data URL content", async () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03]) // ID3 head
    const abs = join(dir, "clip.mp3")
    await writeFile(abs, bytes)

    const result = await readMediaFile(abs, "media/clip.mp3", "audio/mpeg")

    const [text, file] = result.content
    expect(result.content).toHaveLength(2)
    expect(text).toEqual({ type: "text", text: "Audio read successfully" })
    expect(file && typeof file === "object" && "uri" in file && file.uri.startsWith("data:audio/mpeg;base64,")).toBe(true)
    expect((file as { name?: string }).name).toBe("media/clip.mp3")
    expect(result.metadata).toEqual({ truncated: false })

    // Same bytes ride inside the output blob for the client UI.
    const outputBytes = Buffer.from((result.output as { content: string }).content, "base64")
    expect(Buffer.compare(Buffer.from(bytes), outputBytes)).toBe(0)
  })

  test("video file reads with a video acknowledgement", async () => {
    const bytes = new Uint8Array([...Buffer.from("\x1aE\xdf\xa3"), ...new Uint8Array(16)]) // EBML head
    const abs = join(dir, "clip.mkv")
    await writeFile(abs, bytes)

    const result = await readMediaFile(abs, "recordings/clip.mkv", "video/x-matroska")
    const [text] = result.content
    expect((text as { text: string }).text).toBe("Video read successfully")
    expect((result.output as { mime: string }).mime).toBe("video/x-matroska")
    expect((result.output as { name: string; encoding: string; type: string }).name).toBe("clip.mkv")
    expect((result.output as { uri: string }).uri.startsWith("file://")).toBe(true)
  })

  test("read errors surface as plain Errors", async () => {
    await expect(readMediaFile(join(dir, "gone.mp4"), "gone.mp4", "video/mp4")).rejects.toBeInstanceOf(Error)
  })
})
