import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { containsDirectory, isNativeBinaryFileFailure, resolveWorkspacePath } from "../src/paths.ts"

const W32 = process.platform === "win32"
const win32Only: typeof test = W32 ? test : test.skip
const SEP = W32 ? String.fromCharCode(92) : "/"
const join = (...parts: string[]) =>
  parts.reduce((out, part) => (out === "" ? part : out.endsWith(SEP) ? out + part : out + SEP + part), "")
const ROOT = W32 ? `E:${String.fromCharCode(92)}` : "/"

describe("containsDirectory", () => {
  test("nested and equal paths are contained", () => {
    const parent = join(ROOT, "project", "src")
    expect(containsDirectory(parent, join(ROOT, "project", "src", "clip.mp4"))).toBe(true)
    expect(containsDirectory(parent, parent)).toBe(true)
  })

  test("outside and sibling paths are not contained", () => {
    const parent = join(ROOT, "project", "src")
    expect(containsDirectory(parent, join(ROOT, "elsewhere", "clip.mp4"))).toBe(false)
    expect(containsDirectory(parent, join(ROOT, "project", "testfile.txt"))).toBe(false)
  })

  test("prefix-lookalike directories are not contained", () => {
    const parent = join(ROOT, "project")
    expect(containsDirectory(parent, join(ROOT, "project2", "clip.mp4"))).toBe(false)
  })

  win32Only("different drive roots are never contained", () => {
    expect(containsDirectory(join("E:", "project"), join("C:", "elsewhere", "x.mp4"))).toBe(false)
  })
})

describe("resolveWorkspacePath", () => {
  const directory = join(ROOT, "project")
  const norm = (p: string) => p.split(String.fromCharCode(92)).join("/")

  test("relative paths resolve against the location directory", () => {
    expect(norm(resolveWorkspacePath("media/clip.mp4", directory))).toBe(norm(join(ROOT, "project", "media", "clip.mp4")))
    expect(norm(resolveWorkspacePath("./a/../b.txt", directory))).toBe(norm(join(ROOT, "project", "b.txt")))
  })

  test("absolute paths pass through", () => {
    const absolute = join(ROOT, "elsewhere", "song.mp3")
    expect(norm(resolveWorkspacePath(absolute, directory))).toBe(norm(absolute))
  })

  test("~ and ~/sub expand to the home directory", () => {
    expect(resolveWorkspacePath("~", directory)).toBe(homedir())
    expect(resolveWorkspacePath("~/music/track.mp3", directory)).toBe(join(homedir(), "music", "track.mp3"))
  })

  win32Only("windows-style separators normalize for ~ expansion", () => {
    expect(resolveWorkspacePath("~\\music\\track.mp3", directory)).toBe(join(homedir(), "music", "track.mp3"))
  })
})

describe("isNativeBinaryFileFailure", () => {
  test("recognises the native binary gate error text", () => {
    expect(isNativeBinaryFileFailure(new Error("Cannot read binary file: /x/clip.mp4"))).toBe(true)
  })

  test("matches effect-style tagged errors carrying the same message", () => {
    expect(isNativeBinaryFileFailure({ message: "Cannot read binary file: E:\\media\\a.mkv" })).toBe(true)
  })

  test("passes other failures through untouched", () => {
    expect(isNativeBinaryFileFailure(new Error("File not found: /x/clip.mp4"))).toBe(false)
    expect(isNativeBinaryFileFailure(null)).toBe(false)
    expect(isNativeBinaryFileFailure("plain string")).toBe(false)
  })
})
