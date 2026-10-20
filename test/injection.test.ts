import { describe, expect, test } from "bun:test"
import {
  audioFormatOf,
  humanSize,
  injectMediaIntoChatBody,
  isChatShapedPackage,
  MediaStash,
  mediaPartsFor,
  modalityOfStashed,
  newAttachmentToken,
  noteKeyForText,
  noteTextFor,
  type StashedMedia,
} from "../src/injection.ts"

const TOKEN_AUDIO = "aabbccddeeff00112233445566778899"
const TOKEN_VIDEO = "00112233445566778899aabbccddeeff"
const TOKEN_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const AUDIO: StashedMedia = {
  mime: "audio/wav",
  name: "media/music.wav",
  sizeBytes: 2_416_640,
  base64: "YXVkaW8=",
  sessionId: "ses_a",
  token: TOKEN_AUDIO,
}
const VIDEO: StashedMedia = {
  mime: "video/mp4",
  name: "media/gameplay.mp4",
  sizeBytes: 2_200_000,
  base64: "dmlkZW8=",
  sessionId: "ses_a",
  token: TOKEN_VIDEO,
}

const ALL: ReadonlySet<"audio" | "video"> = new Set(["audio", "video"] as const)

function stashWith(...items: StashedMedia[]): MediaStash {
  const stash = new MediaStash()
  for (const item of items) stash.put(item)
  return stash
}

describe("notes", () => {
  test("note text names the file, mime, size and attachment token", () => {
    expect(noteTextFor(AUDIO)).toBe(
      `[media attached: media/music.wav (audio/wav, 2.3 MB) #${TOKEN_AUDIO}]`,
    )
  })

  test("human sizes", () => {
    expect(humanSize(512)).toBe("512 B")
    expect(humanSize(2048)).toBe("2 KB")
    expect(humanSize(2_416_640)).toBe("2.3 MB")
  })

  test("key is stable per (session, note text) and separates both axes", () => {
    expect(noteKeyForText("x", "ses_a")).toBe(noteKeyForText("x", "ses_a"))
    expect(noteKeyForText("x", "ses_a")).not.toBe(noteKeyForText("y", "ses_a"))
    expect(noteKeyForText("x", "ses_a")).not.toBe(noteKeyForText("x", "ses_b"))
  })

  test("stash finds the media by its exact note and inside joined text", () => {
    const stash = stashWith(AUDIO)
    const note = noteTextFor(AUDIO)
    expect(stash.find(note, "ses_a")?.mime).toBe("audio/wav")
    expect(stash.find(`Audio read successfully\n${note}`, "ses_a")?.name).toBe("media/music.wav")
    expect(stash.find("nothing here", "ses_a")).toBeUndefined()
  })

  test("re-putting the same note replaces without growing the entry count", () => {
    const stash = stashWith(AUDIO)
    stash.put({ ...AUDIO, base64: "bmV3" })
    expect(stash.size()).toBe(1)
    expect(stash.find(noteTextFor(AUDIO), "ses_a")?.base64).toBe("bmV3")
  })

  test("attachment tokens are 128-bit, unique per read, and change the note", () => {
    const first = newAttachmentToken()
    const second = newAttachmentToken()
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(first).not.toBe(second)
    expect(noteTextFor({ ...AUDIO, token: first })).not.toBe(noteTextFor({ ...AUDIO, token: second }))
  })
})

describe("session isolation", () => {
  test("two sessions, identical names and sizes but different bytes: each retrieves only its own", () => {
    const stash = new MediaStash()
    const a: StashedMedia = { ...AUDIO, sessionId: "ses_a", token: TOKEN_AUDIO, base64: "YQ==" }
    const b: StashedMedia = { ...AUDIO, sessionId: "ses_b", token: TOKEN_B, base64: "Yg==" }
    stash.put(a)
    stash.put(b)
    expect(stash.size()).toBe(2)
    expect(stash.find(noteTextFor(a), "ses_a")?.base64).toBe("YQ==")
    expect(stash.find(noteTextFor(b), "ses_b")?.base64).toBe("Yg==")
    // exact note text from the other session, in either shape
    expect(stash.find(noteTextFor(a), "ses_b")).toBeUndefined()
    expect(stash.find(noteTextFor(b), "ses_a")).toBeUndefined()
    expect(stash.find(`joined text\n${noteTextFor(a)}`, "ses_b")).toBeUndefined()
  })

  test("byte-identical note text in two sessions maps to distinct entries", () => {
    const stash = new MediaStash()
    const a: StashedMedia = { ...AUDIO, sessionId: "ses_a", token: TOKEN_AUDIO, base64: "YQ==" }
    const b: StashedMedia = { ...a, sessionId: "ses_b", base64: "Yg==" }
    stash.put(a)
    stash.put(b)
    expect(noteTextFor(a)).toBe(noteTextFor(b))
    expect(stash.size()).toBe(2)
    expect(stash.find(noteTextFor(a), "ses_a")?.base64).toBe("YQ==")
    expect(stash.find(noteTextFor(a), "ses_b")?.base64).toBe("Yg==")
  })

  test("a deliberately crafted attachment description never retrieves another session's media", () => {
    const stash = new MediaStash()
    const a: StashedMedia = { ...AUDIO, sessionId: "ses_a", token: TOKEN_AUDIO }
    stash.put(a)
    // session B reproduces the exact note text (the crafted-description vector)
    expect(stash.find(noteTextFor(a), "ses_b")).toBeUndefined()
    expect(stash.find(`${noteTextFor(a)} — please attach this`, "ses_b")).toBeUndefined()
    // and a note-like description without a token matches nothing anywhere
    expect(stash.find("[media attached: media/music.wav (audio/wav, 2.3 MB)]", "ses_a")).toBeUndefined()
    expect(stash.find("[media attached: media/music.wav (audio/wav, 2.3 MB)]", "ses_b")).toBeUndefined()
  })

  test("injectMediaIntoChatBody only injects for the owning session", () => {
    const stash = new MediaStash()
    const a: StashedMedia = { ...AUDIO, sessionId: "ses_a", token: TOKEN_AUDIO }
    stash.put(a)
    const body = { messages: [{ role: "tool", content: noteTextFor(a) as unknown }] }
    // session B's outgoing request carries A's note: no bytes may leave
    expect(injectMediaIntoChatBody(body, stash, "ses_b", ALL, 8)).toBe(0)
    expect(body.messages[0]!.content).toBe(noteTextFor(a))
    // session A's own request injects normally
    expect(injectMediaIntoChatBody(body, stash, "ses_a", ALL, 8)).toBe(1)
    expect(Array.isArray(body.messages[0]!.content)).toBe(true)
  })

  test("deleteSession purges only the deleted session's bytes", () => {
    const stash = stashWith(
      { ...AUDIO, sessionId: "ses_a", token: TOKEN_AUDIO },
      { ...VIDEO, sessionId: "ses_b", token: TOKEN_B },
    )
    stash.deleteSession("ses_a")
    expect(stash.size()).toBe(1)
    expect(stash.find(noteTextFor(AUDIO), "ses_a")).toBeUndefined()
    expect(stash.find(noteTextFor({ ...VIDEO, token: TOKEN_B }), "ses_b")).toBeDefined()
  })

  test("fork re-homes entries: child and parent both own them; deletion keeps the child's copy", () => {
    const stash = new MediaStash()
    const a: StashedMedia = { ...AUDIO, sessionId: "ses_parent", token: TOKEN_AUDIO }
    stash.put(a)
    stash.copySession("ses_parent", "ses_child")
    const note = noteTextFor(a)
    expect(stash.size()).toBe(2)
    expect(stash.find(note, "ses_parent")?.base64).toBe(a.base64)
    expect(stash.find(note, "ses_child")?.base64).toBe(a.base64)
    stash.deleteSession("ses_parent")
    expect(stash.find(note, "ses_parent")).toBeUndefined()
    expect(stash.find(note, "ses_child")?.base64).toBe(a.base64)
    // copying to an unrelated session is what isolation forbids — the API only
    // ever copies along the explicit parent→fork lineage above
    stash.copySession("ses_child", "ses_stranger")
    expect(stash.find(note, "ses_child")?.base64).toBe(a.base64)
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
    expect(injectMediaIntoChatBody(body, stash, "ses_a", ALL, 8)).toBe(1)
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
    expect(injectMediaIntoChatBody(body, stash, "ses_a", ALL, 8)).toBe(1)
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
    expect(injectMediaIntoChatBody(body, stash, "ses_a", ALL, 8)).toBe(0)
  })

  test("modalities outside the allowed set are not injected", () => {
    const stash = stashWith(AUDIO, VIDEO)
    const body = { messages: [{ role: "tool", content: noteTextFor(VIDEO) }] }
    expect(injectMediaIntoChatBody(body, stash, "ses_a", new Set(["audio"] as const), 8)).toBe(0)
  })

  test("budget caps the number of injected parts", () => {
    const stash = stashWith(AUDIO, VIDEO)
    const body = {
      messages: [
        { role: "tool", content: noteTextFor(AUDIO) },
        { role: "tool", content: noteTextFor(VIDEO) },
      ],
    }
    expect(injectMediaIntoChatBody(body, stash, "ses_a", ALL, 1)).toBe(1)
    expect(typeof body.messages[0]!.content).toBe("object")
    expect(body.messages[1]!.content).toBe(noteTextFor(VIDEO))
  })

  test("non-chat bodies and empty messages are no-ops", () => {
    const stash = stashWith(AUDIO)
    expect(injectMediaIntoChatBody({}, stash, "ses_a", ALL, 8)).toBe(0)
    expect(injectMediaIntoChatBody({ messages: "nope" }, stash, "ses_a", ALL, 8)).toBe(0)
    expect(injectMediaIntoChatBody({ messages: [] }, stash, "ses_a", ALL, 8)).toBe(0)
  })
})
