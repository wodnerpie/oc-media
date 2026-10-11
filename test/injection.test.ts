import { describe, expect, test } from "bun:test"
import {
  audioFormatOf,
  humanSize,
  injectMediaIntoChatBody,
  isChatShapedPackage,
  MediaStash,
  mediaPartsFor,
  modalityOfStashed,
  noteKeyForText,
  noteTextFor,
  type StashedMedia,
} from "../src/injection.ts"

const AUDIO: StashedMedia = {
  mime: "audio/wav",
  name: "media/music.wav",
  sizeBytes: 2_416_640,
  base64: "YXVkaW8=",
}
const VIDEO: StashedMedia = {
  mime: "video/mp4",
  name: "media/gameplay.mp4",
  sizeBytes: 2_200_000,
  base64: "dmlkZW8=",
}

const ALL: ReadonlySet<"audio" | "video"> = new Set(["audio", "video"] as const)

function stashWith(...items: StashedMedia[]): MediaStash {
  const stash = new MediaStash()
  for (const item of items) stash.put(item)
  return stash
}

describe("notes", () => {
  test("note text names the file, mime and size", () => {
    expect(noteTextFor(AUDIO)).toBe("[media attached: media/music.wav (audio/wav, 2.3 MB)]")
  })

  test("human sizes", () => {
    expect(humanSize(512)).toBe("512 B")
    expect(humanSize(2048)).toBe("2 KB")
    expect(humanSize(2_416_640)).toBe("2.3 MB")
  })

  test("key is stable per note text", () => {
    expect(noteKeyForText("x")).toBe(noteKeyForText("x"))
    expect(noteKeyForText("x")).not.toBe(noteKeyForText("y"))
  })

  test("stash finds the media by its exact note and inside joined text", () => {
    const stash = stashWith(AUDIO)
    const note = noteTextFor(AUDIO)
    expect(stash.find(note)?.mime).toBe("audio/wav")
    expect(stash.find(`Audio read successfully\n${note}`)?.name).toBe("media/music.wav")
    expect(stash.find("nothing here")).toBeUndefined()
  })

  test("re-putting the same note replaces without growing the entry count", () => {
    const stash = stashWith(AUDIO)
    stash.put({ ...AUDIO, base64: "bmV3" })
    expect(stash.size()).toBe(1)
    expect(stash.find(noteTextFor(AUDIO))?.base64).toBe("bmV3")
  })
})

describe("media parts", () => {
  test("audio becomes input_audio with a mapped format", () => {
    expect(mediaPartsFor(AUDIO)).toEqual([
      { type: "input_audio", input_audio: { data: "YXVkaW8=", format: "wav" } },
    ])
  })

  test("video becomes video_url with a data URL", () => {
    expect(mediaPartsFor(VIDEO)).toEqual([
      { type: "video_url", video_url: { url: "data:video/mp4;base64,dmlkZW8=" } },
    ])
  })

  test("audio format mapping", () => {
    expect(audioFormatOf("audio/x-wav")).toBe("wav")
    expect(audioFormatOf("audio/mpeg")).toBe("mp3")
    expect(audioFormatOf("audio/mp4")).toBe("m4a")
    expect(audioFormatOf("audio/weird")).toBe("weird")
  })

  test("modality classification", () => {
    expect(modalityOfStashed(AUDIO)).toBe("audio")
    expect(modalityOfStashed(VIDEO)).toBe("video")
    expect(modalityOfStashed({ ...AUDIO, mime: "image/png" })).toBeNull()
  })

  test("chat-shaped packages", () => {
    expect(isChatShapedPackage("@opencode/ai/providers/openai-compatible")).toBe(true)
    expect(isChatShapedPackage("@opencode/ai/providers/openrouter")).toBe(true)
    expect(isChatShapedPackage("@opencode/ai/providers/deepinfra")).toBe(true)
    expect(isChatShapedPackage("@opencode/ai/providers/google")).toBe(false)
    expect(isChatShapedPackage("@opencode/ai/providers/openai")).toBe(false)
    expect(isChatShapedPackage(undefined)).toBe(false)
  })
})

describe("injectMediaIntoChatBody", () => {
  test("string tool content becomes text + media part", () => {
    const stash = stashWith(AUDIO)
    const body = { messages: [{ role: "tool", content: noteTextFor(AUDIO) as unknown }] }
    expect(injectMediaIntoChatBody(body, stash, ALL, 8)).toBe(1)
    expect(body.messages[0]!.content).toEqual([
      { type: "text", text: noteTextFor(AUDIO) },
      { type: "input_audio", input_audio: { data: "YXVkaW8=", format: "wav" } },
    ])
  })

  test("array content gets the part spliced right after the note", () => {
    const stash = stashWith(VIDEO)
    const content: unknown[] = [
      { type: "text", text: "unrelated" },
      { type: "text", text: noteTextFor(VIDEO) },
      { type: "text", text: "after" },
    ]
    const body = { messages: [{ role: "user", content }] }
    expect(injectMediaIntoChatBody(body, stash, ALL, 8)).toBe(1)
    expect(content[1]).toEqual({ type: "text", text: noteTextFor(VIDEO) })
    expect(content[2]).toEqual({ type: "video_url", video_url: { url: "data:video/mp4;base64,dmlkZW8=" } })
    expect(content[3]).toEqual({ type: "text", text: "after" })
  })

  test("unknown notes and non-user/tool roles are untouched", () => {
    const stash = stashWith(AUDIO)
    const body = {
      messages: [
        { role: "assistant", content: noteTextFor(AUDIO) },
        { role: "system", content: noteTextFor(AUDIO) },
        { role: "tool", content: "[media attached: nothing.wav (audio/wav, 1 KB)]" },
      ],
    }
    expect(injectMediaIntoChatBody(body, stash, ALL, 8)).toBe(0)
  })

  test("modalities outside the allowed set are not injected", () => {
    const stash = stashWith(AUDIO, VIDEO)
    const body = { messages: [{ role: "tool", content: noteTextFor(VIDEO) }] }
    expect(injectMediaIntoChatBody(body, stash, new Set(["audio"] as const), 8)).toBe(0)
  })

  test("budget caps the number of injected parts", () => {
    const stash = stashWith(AUDIO, VIDEO)
    const body = {
      messages: [
        { role: "tool", content: noteTextFor(AUDIO) },
        { role: "tool", content: noteTextFor(VIDEO) },
      ],
    }
    expect(injectMediaIntoChatBody(body, stash, ALL, 1)).toBe(1)
    expect(typeof body.messages[0]!.content).toBe("object")
    expect(body.messages[1]!.content).toBe(noteTextFor(VIDEO))
  })

  test("non-chat bodies and empty messages are no-ops", () => {
    const stash = stashWith(AUDIO)
    expect(injectMediaIntoChatBody({}, stash, ALL, 8)).toBe(0)
    expect(injectMediaIntoChatBody({ messages: "nope" }, stash, ALL, 8)).toBe(0)
    expect(injectMediaIntoChatBody({ messages: [] }, stash, ALL, 8)).toBe(0)
  })
})
