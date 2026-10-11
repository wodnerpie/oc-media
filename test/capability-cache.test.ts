import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CapabilityCache } from "../src/capability-cache.ts"

type ModelInfoLike = { providerID: string; id: string; capabilities: { input: readonly string[] } }

const dir = await mkdtemp(join(tmpdir(), "oc-media-capacs-"))
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const catalogModel = (input: readonly string[], id = "m1"): ModelInfoLike => ({
  providerID: "google",
  id,
  capabilities: { input },
})

describe("CapabilityCache (effect)", () => {
  test("caches the snapshot within the TTL and reloads after expiry", async () => {
    let loads = 0
    const cache = new CapabilityCache(
      Effect.gen(function* () {
        loads++
        yield* Effect.promise(() => writeFile(join(dir, `probe-${loads}.ok`), "ok"))
        return [catalogModel(["text", "audio"])]
      }),
      20,
    )

    const first = await cache.for({ providerID: "google", id: "m1" })
    await cache.for({ providerID: "google", id: "m1" })
    expect(loads).toBe(1)
    expect(first.audio).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 30))
    await cache.for({ providerID: "google", id: "m1" })
    expect(loads).toBe(2)
  })

  test("fail-closed when the catalog cannot be loaded", async () => {
    const cache = new CapabilityCache(Effect.fail(new Error("busy")), 10_000)
    const view = await cache.for({ providerID: "google", id: "gemini-2.5-pro" })
    expect(view.known).toBe(false)
    expect(view.audio).toBeNull()
  })

  test("unknown model refs are unknown, loaded once", async () => {
    let loads = 0
    const cache = new CapabilityCache(
      Effect.gen(function* () {
        loads++
        return []
      }),
      60_000,
    )
    const view = await cache.for({ providerID: "milkyway", id: "aster" })
    expect(view).toEqual({ audio: null, video: null, image: null, pdf: null, known: false })
    expect(loads).toBe(1)
  })
})
