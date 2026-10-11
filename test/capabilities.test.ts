import { describe, expect, test } from "bun:test"
import {
  capabilitiesOf,
  findModel,
  modalityOfMime,
  type ModelInfoLike,
} from "../src/capabilities.ts"

const catalogModel = (input: readonly string[], providerID = "google", id = "m1"): ModelInfoLike => ({
  providerID,
  id,
  capabilities: { input },
})

describe("modalityOfMime", () => {
  test("matchesOpenCodeCore Mime prefixes", () => {
    expect(modalityOfMime("audio/mpeg")).toBe("audio")
    expect(modalityOfMime("video/mp4")).toBe("video")
    expect(modalityOfMime("image/png")).toBe("image")
    expect(modalityOfMime("application/pdf")).toBe("pdf")
    expect(modalityOfMime("text/plain")).toBeNull()
    expect(modalityOfMime("application/octet-stream")).toBeNull()
    expect(modalityOfMime(null)).toBeNull()
    expect(modalityOfMime("AUDIO/MP3")).toBe("audio")
  })
})

describe("capabilitiesOf", () => {
  test("derives media modalities with the startsWith rule core uses", () => {
    const gemini = capabilitiesOf(catalogModel(["text", "image", "audio", "video", "pdf"]))
    expect(gemini).toEqual({ audio: true, video: true, image: true, pdf: true, known: true })
  })

  test("a present model without an input list is unknown, not unsupported", () => {
    const caps = capabilitiesOf({ providerID: "acme", id: "m1", capabilities: {} })
    expect(caps).toEqual({ audio: null, video: null, image: null, pdf: null, known: false })
  })

  test("an empty input list means present-but-none", () => {
    const caps = capabilitiesOf(catalogModel([]))
    expect(caps.audio).toBe(false)
    expect(caps.video).toBe(false)
    expect(caps.known).toBe(true)
  })

  test("an absent model is unknown", () => {
    expect(capabilitiesOf(undefined)).toEqual({ audio: null, video: null, image: null, pdf: null, known: false })
  })

  test("claude-style catalog data", () => {
    const caps = capabilitiesOf(catalogModel(["text", "image", "pdf"]))
    expect(caps.audio).toBe(false)
    expect(caps.video).toBe(false)
    expect(caps.image).toBe(true)
    expect(caps.pdf).toBe(true)
  })
})

describe("findModel", () => {
  const models: ModelInfoLike[] = [
    { providerID: "anthropic", id: "claude-sonnet-4-5" },
    { providerID: "google", id: "gemini-2.5-pro" },
    { providerID: "google", id: "other", modelID: "gemini-2.5-pro" },
  ]

  test("matches by provider and id", () => {
    expect(findModel(models, { providerID: "google", id: "gemini-2.5-pro" })).toBe(models[1])
    expect(findModel(models, { providerID: "anthropic", id: "claude-sonnet-4-5" })).toBe(models[0])
  })

  test("falls back to modelID and never crosses provider rows", () => {
    expect(findModel(models, { providerID: "google", id: "missing" })).toBeUndefined()
    expect(findModel(models, { providerID: "google", id: "gemini-2.5-pro", variant: "high" })!.id).toBe("gemini-2.5-pro")
    expect(findModel(models, { providerID: "openai", id: "gemini-2.5-pro" })).toBeUndefined()
  })

  test("tolerates empty refs", () => {
    expect(findModel(models, { providerID: "", id: "x" })).toBeUndefined()
    expect(findModel(models, undefined)).toBeUndefined()
  })
})
