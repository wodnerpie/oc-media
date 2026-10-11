import { describe, expect, test } from "bun:test"
import { TransportRefusals, sanitizeRefusedMedia } from "../src/transport-refusals.ts"

const GLM = { providerID: "opencode-go", id: "glm-5.3-flash" }
const MIMO = { providerID: "opencode-go", id: "mimo-v2.6-flash" }

describe("TransportRefusals.modalityFromErrorMessage", () => {
  test("recognises the verified OpenAI-chat lowering refusals", () => {
    expect(TransportRefusals.modalityFromErrorMessage("OpenAI Chat does not support media type video/mp4")).toBe("video")
    expect(TransportRefusals.modalityFromErrorMessage("OpenAI Chat does not support media type audio/wave")).toBe("audio")
  })

  test("stays local to the plugin's concern", () => {
    expect(TransportRefusals.modalityFromErrorMessage("OpenAI Chat does not support media type image/gif")).toBeNull()
    expect(TransportRefusals.modalityFromErrorMessage("OpenAI Chat does not support media type application/pdf")).toBeNull()
    expect(TransportRefusals.modalityFromErrorMessage("rate limit exceeded")).toBeNull()
  })
})

describe("TransportRefusals store", () => {
  test("records and answers per model + modality", () => {
    const refusals = new TransportRefusals()
    expect(refusals.isRefused(GLM, "video")).toBe(false)
    refusals.record(GLM, "video")
    expect(refusals.isRefused(GLM, "video")).toBe(true)
    expect(refusals.isRefused(GLM, "audio")).toBe(false)
    expect(refusals.isRefused(MIMO, "video")).toBe(false)
  })

  test("survives a snapshot/restore round trip (storage persistence)", () => {
    const first = new TransportRefusals()
    first.record(GLM, "video")
    first.record(MIMO, "audio")
    const restored = new TransportRefusals()
    restored.restore(first.list())
    expect(restored.isRefused(GLM, "video")).toBe(true)
    expect(restored.isRefused(MIMO, "audio")).toBe(true)
    expect(restored.isRefused(GLM, "audio")).toBe(false)
  })

  test("tolerates undefined refs", () => {
    const refusals = new TransportRefusals()
    refusals.record(undefined, "video")
    expect(refusals.isRefused(undefined, "video")).toBe(false)
  })
})

describe("sanitizeRefusedMedia", () => {
  const mediaMessage = (mime: string) => [
    {
      content: [
        {
          type: "tool-result",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Video read successfully" },
              { type: "file", uri: "data:x;base64,AAA", mime, name: "clip.mp4" },
            ],
          },
        },
      ],
    },
  ]

  test("replaces refused media with an explanatory note in the outgoing copy", () => {
    const refusals = new TransportRefusals()
    refusals.record(GLM, "video")
    const messages = mediaMessage("video/mp4")
    sanitizeRefusedMedia(messages, GLM, refusals)
    const value = (messages[0] as never as { content: { result: { value: unknown[] } }[] }).content[0]!.result.value
    expect((value[0] as { type: string }).type).toBe("text")
    expect((value[1] as { type: string }).type).toBe("text")
    expect((value[1] as { text: string }).text).toContain("video attachment omitted")
    expect((value[1] as { text: string }).text).toContain("opencode-go/glm-5.3-flash")
    expect((value[1] as { text: string }).text).toContain("clip.mp4")
  })

  test("leaves media alone for other models or un-refused modalities", () => {
    const refusals = new TransportRefusals()
    refusals.record(GLM, "video")
    const forOther = mediaMessage("video/mp4")
    sanitizeRefusedMedia(forOther, MIMO, refusals)
    expect((forOther[0] as never as { content: { result: { value: unknown[] } }[] }).content[0]!.result.value[1]).toEqual({
      type: "file",
      uri: "data:x;base64,AAA",
      mime: "video/mp4",
      name: "clip.mp4",
    })

    const otherModality = mediaMessage("audio/wave")
    sanitizeRefusedMedia(otherModality, GLM, refusals)
    expect((otherModality[0] as never as { content: { result: { value: unknown[] } }[] }).content[0]!.result.value[1]).toEqual({
      type: "file",
      uri: "data:x;base64,AAA",
      mime: "audio/wave",
      name: "clip.mp4",
    })
  })

  test("ignores untouched shapes", () => {
    const refusals = new TransportRefusals()
    refusals.record(GLM, "video")
    const messages = [{ content: [{ type: "text", text: "hi" }] }, { role: "user" }, null]
    expect(() => sanitizeRefusedMedia(messages, GLM, refusals)).not.toThrow()
  })
})
