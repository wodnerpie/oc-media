import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasMediaSignature, probeMediaContent } from "../src/media-read.ts"

const dir = await mkdtemp(join(tmpdir(), "oc-media-probe-"))
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("hasMediaSignature", () => {
  test("recognizes common containers and elementary streams", () => {
    expect(hasMediaSignature(Buffer.from("ID3\x03\x00\x00\x00", "latin1"))).toBe(true)
    expect(hasMediaSignature(Buffer.from("RIFF....WAVE", "latin1"))).toBe(true)
    expect(hasMediaSignature(Buffer.from("OggS....", "latin1"))).toBe(true)
    expect(hasMediaSignature(Buffer.from("fLaC....", "latin1"))).toBe(true)
    expect(hasMediaSignature(Buffer.from("FORM....AIFF", "latin1"))).toBe(true)
    expect(hasMediaSignature(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]))).toBe(true) // ftyp
    expect(hasMediaSignature(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00]))).toBe(true) // EBML
    expect(hasMediaSignature(Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x65]))).toBe(true) // MPEG audio
    expect(hasMediaSignature(Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x01]))).toBe(true) // ASF
  })

  test("recognizes an MPEG transport stream by its 188-byte sync", () => {
    expect(hasMediaSignature(Buffer.alloc(200, 0x47))).toBe(true)
    expect(hasMediaSignature(Buffer.alloc(200, 0x48))).toBe(false)
  })

  test("plain text is not media", () => {
    expect(hasMediaSignature(Buffer.from("export const answer = 42\n"))).toBe(false)
    expect(hasMediaSignature(Buffer.from("// comment"))).toBe(false)
    expect(hasMediaSignature(Buffer.alloc(0))).toBe(false)
  })
})

describe("probeMediaContent", () => {
  test("TypeScript source is not media", async () => {
    const file = join(dir, "code.ts")
    await writeFile(file, "export const x: number = 1\n")
    expect(await probeMediaContent(file)).toBe(false)
  })

  test("a real MPEG-TS file is media", async () => {
    const file = join(dir, "stream.ts")
    await writeFile(file, Buffer.from([0x47, 0x00, 0x11, 0x22, 0x47, 0x00, 0x33, 0x44]))
    expect(await probeMediaContent(file)).toBe(true)
  })

  test("a tagless MP3 without NUL bytes is still media", async () => {
    const file = join(dir, "tagless.mp3")
    await writeFile(file, Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x65, 0x66, 0x67]))
    expect(await probeMediaContent(file)).toBe(true)
  })

  test("empty and missing files are not media", async () => {
    const empty = join(dir, "empty.wav")
    await writeFile(empty, Buffer.alloc(0))
    expect(await probeMediaContent(empty)).toBe(false)
    expect(await probeMediaContent(join(dir, "missing.mp4"))).toBe(false)
  })
})
