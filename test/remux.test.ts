import { afterAll, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { ffmpegPath, remuxToMp4, shouldRemux } from "../src/remux.ts"

const run = promisify(execFile)
const ffmpeg = await ffmpegPath()
const testIf = (condition: boolean) => (condition ? test : test.skip)

const dir = await mkdtemp(join(tmpdir(), "oc-media-remux-test-"))
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const isMp4 = (bytes: Buffer): boolean => bytes.toString("latin1", 4, 8) === "ftyp"

describe("shouldRemux", () => {
  test("targets the containers the transport rejects", () => {
    expect(shouldRemux("video/x-matroska")).toBe(true)
    expect(shouldRemux("video/webm")).toBe(true)
    expect(shouldRemux("video/mp4")).toBe(false)
    expect(shouldRemux("audio/ogg")).toBe(false)
  })
})

describe("remuxToMp4", () => {
  testIf(ffmpeg !== null)("remuxes an H.264/AAC MKV by stream copy", async () => {
    const source = join(dir, "small.mkv")
    await run(ffmpeg as string, [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      source,
    ])
    const result = await remuxToMp4(source)
    expect(result.ok).toBe(true)
    if (result.ok) expect(isMp4(result.bytes)).toBe(true)
  })

  testIf(ffmpeg !== null)("rescues a Vorbis WebM by transcoding only the audio", async () => {
    const source = join(dir, "vorbis.webm")
    await run(ffmpeg as string, [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "200k", "-pix_fmt", "yuv420p",
      "-c:a", "libvorbis",
      source,
    ])
    const result = await remuxToMp4(source)
    expect(result.ok).toBe(true)
    if (result.ok) expect(isMp4(result.bytes)).toBe(true)
  })

  testIf(ffmpeg !== null)("fails with a reason on a non-media file", async () => {
    const source = join(dir, "fake.mkv")
    await writeFile(source, "this is not a matroska file")
    const result = await remuxToMp4(source)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0)
  })
})
