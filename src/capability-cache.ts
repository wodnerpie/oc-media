import { Effect, Result } from "effect"
import { capabilitiesOf, findModel, type CapabilityLookup, type MediaCapabilities, type ModelRefLike, type ModelInfoLike } from "./capabilities.ts"

export type { CapabilityLookup, MediaCapabilities, ModelRefLike }

const UNKNOWN: MediaCapabilities = { audio: null, video: null, image: null, pdf: null, known: false }

/**
 * Effect-based TTL cache over a `ctx.model.list()` snapshot.
 *
 * Model capability data changes at catalog-refresh cadence (OpenCode pulls
 * models.dev every few minutes), so one minute of staleness is invisible but
 * keeps hooks off the client on every single dispatch. Loads fail closed
 * (`known: false`), never positively wrong.
 */
export class CapabilityCache implements CapabilityLookup {
  private entry: { value: readonly ModelInfoLike[]; at: number } | undefined

  constructor(
    private readonly load: Effect.Effect<readonly ModelInfoLike[], unknown>,
    private readonly ttlMs = 60_000,
  ) {}

  private snapshot(): Effect.Effect<readonly ModelInfoLike[], unknown> {
    return Effect.suspend(() => {
      if (this.entry && Date.now() - this.entry.at <= this.ttlMs) {
        return Effect.succeed(this.entry.value)
      }
      const self = this
      return Effect.gen(function* () {
        const models = yield* self.load
        self.entry = { value: models, at: Date.now() }
        return models
      })
    })
  }

  forEffect(ref: ModelRefLike | undefined): Effect.Effect<MediaCapabilities> {
    const self = this
    return Effect.gen(function* () {
      const outcome = yield* Effect.result(self.snapshot())
      if (Result.isFailure(outcome)) {
        // The service call may fail (busy, shutting down): unknown
        // capabilities rather than a wrong "supported".
        return UNKNOWN
      }
      return capabilitiesOf(findModel(outcome.success, ref))
    })
  }

  for(ref: ModelRefLike | undefined): Promise<MediaCapabilities> {
    return Effect.runPromise(this.forEffect(ref))
  }
}

export { capabilitiesOf, findModel }
