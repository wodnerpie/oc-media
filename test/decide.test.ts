import { describe, expect, test } from "bun:test"
import { decide, type DecisionInputs } from "../src/decide.ts"
import { DEFAULT_MAX_BYTES, resolveOptions } from "../src/options.ts"

const options = resolveOptions(undefined)

const media = (overrides: Partial<DecisionInputs> = {}): DecisionInputs => ({
  exists: true,
  sizeBytes: 1024,
  mime: "video/mp4",
  modality: "video",
  capability: true,
  options,
  path: "media/clip.mp4",
  ...overrides,
})

describe("decide", () => {
  test("delegates when the path does not exist (native read owns missing-file UX)", () => {
    expect(decide(media({ exists: false })).action).toBe("delegate")
  })

  test("delegates every non-media file byte-for-byte", () => {
    for (const mime of [null, "text/plain", "image/png", "application/pdf", "application/octet-stream"]) {
      expect(decide(media({ mime, modality: mime && mime.startsWith("audio/") ? "audio" : null })).action).toBe("delegate")
    }
  })

  test("delegates media when the stat result is not usable for attachment", () => {
    expect(decide(media({ sizeBytes: null })).action).toBe("delegate")
  })

  test("delegates a modality the user disabled instead of erroring", () => {
    const disabled = resolveOptions({ audio: false })
    expect(decide(media({ mime: "audio/mpeg", modality: "audio", options: disabled })).action).toBe("delegate")
  })

  test("rejects an empty media file with a distinct error", () => {
    const decision = decide(media({ sizeBytes: 0 }))
    expect(decision.action).toBe("reject")
    expect(decision.action === "reject" && decision.error.message).toContain("empty (0 bytes)")
  })

  test("rejects oversize media with size and limit in the message", () => {
    const decision = decide(media({ sizeBytes: 21 * 1024 * 1024 }))
    expect(decision.action).toBe("reject")
    expect(decision.action === "reject" && decision.error.message).toContain("larger than the 20 MB")
    expect(decision.action === "reject" && decision.error.message).toContain("21 MB")
  })

  test("rejects when the model cannot ingest the modality", () => {
    const decision = decide(
      media({ mime: "audio/mpeg", modality: "audio", capability: false }),
    )
    expect(decision.action).toBe("reject")
    expect(decision.action === "reject" && decision.error.message).toContain("does not support audio input")
  })

  test("rejects unknown-capability models unless allowUnknown is set", () => {
    const conservative = decide(media({ capability: null }))
    expect(conservative.action).toBe("reject")
    expect(conservative.action === "reject" && conservative.error.message).toContain("capabilities of the current model")

    const permissive = resolveOptions({ allowUnknown: true })
    expect(decide(media({ capability: null, options: permissive })).action).toBe("attach")
  })

  test("attaches capable media reads", () => {
    expect(decide(media({})).action).toBe("attach")
    expect(decide(media({ mime: "audio/mpeg", modality: "audio", capability: true })).action).toBe("attach")
  })

  test("does not claim options maxBytes when invalid (falls back to default)", () => {
    expect(resolveOptions({ maxBytes: 0 }).maxBytes).toBe(DEFAULT_MAX_BYTES)
    expect(resolveOptions({ maxBytes: "big" }).maxBytes).toBe(DEFAULT_MAX_BYTES)
    expect(resolveOptions({ maxBytes: 1024 }).maxBytes).toBe(1024)
    expect(resolveOptions({ allowUnknown: "yes" })).toEqual({
      maxBytes: DEFAULT_MAX_BYTES,
      allowUnknown: false,
      matchAllClaims: true,
      audio: true,
      video: true,
    })
  })
})
