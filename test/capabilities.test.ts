import { describe, expect, test } from "bun:test"
import {
  CapabilityCache,
  capabilitiesOf,
  findModel,
  modalityOfMime,
  type ModelInfoLike,
} from "../src/capabilities.ts"

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

describe("CapabilityCache", () => {
  test("caches the snapshot within the TTL and reloads after expiry", async () => {
    let loads = 0
    const cache = new CapabilityCache(
      () => {
        loads++
        return Promise.resolve([catalogModel(["text", "audio"])])
      },
      20,
    )

    await cache.for({ providerID: "google", id: "m1" })
    const again = await cache.for({ providerID: "google", id: "m1" })
    expect(loads).toBe(1)
    expect(again.audio).toBe(true)

    await Bun.sleep(30)
    await cache.for({ providerID: "google", id: "m1" })
    expect(loads).toBe(2)
  })

  test("fail-closed when the catalog cannot be loaded", async () => {
    const cache = new CapabilityCache(() => Promise.reject(new Error("busy")), 10_000)
    const caps = await cache.for({ providerID: "google", id: "gemini-2.5-pro" })
    expect(caps.known).toBe(false)
    expect(caps.audio).toBeNull()
  })

  test("unknown refs are unknown without touching the loader twice for identical frames", async () => {
    let loads = 0
    const cache = new CapabilityCache(
      () => {
        loads++
        return Promise.resolve([])
      },
      60_000,
    )
    const caps = await cache.for({ providerID: "milkyway", id: "aster" })
    expect(caps.known).toBe(false)
    expect(loads).toBe(1)
  })
})

function catalogModel(input: readonly string[]): ModelInfoLike {
  return { providerID: "google", id: "m1", capabilities: { input } }
}
