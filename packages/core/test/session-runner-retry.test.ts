import { describe, expect } from "bun:test"
import {
  AIError,
  HttpContext,
  InvalidRequestError,
  ProviderInternalError,
  QuotaExceededError,
  RateLimitError,
  TransportError,
} from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/core/provider"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { Effect } from "effect"
import { it } from "./lib/effect"

const timeout = new AIError({
  reason: new TransportError({ message: "Timed out", transport: "http", operation: "request", code: "Timeout" }),
})
const internal = new AIError({ reason: new ProviderInternalError({ message: "internal" }) })

const input = (cause: AIError) => ({
  cause,
  error: toSessionError(cause),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }),
  hook: () => Effect.void,
  retry: SessionRunnerRetry.isRetryable(cause),
})

// Decisions for `count` consecutive failures of the same cause within one step.
const decisions = (cause: AIError, count: number, fallback = false) =>
  Effect.gen(function* () {
    const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"), { fallback })
    const results: boolean[] = []
    for (let i = 0; i < count; i++) results.push((yield* policy(input(cause))).retry)
    return results
  })

describe("SessionRunnerRetry.policy", () => {
  for (const cause of [timeout, new AIError({ reason: new RateLimitError({ message: "rate limited" }) })]) {
    it.effect(`retries ${cause.reason._tag} only once before configured fallbacks`, () =>
      Effect.gen(function* () {
        expect(yield* decisions(cause, 3, true)).toEqual([true, false, false])
      }),
    )
  }

  it.effect("never retries exhausted usage", () =>
    Effect.gen(function* () {
      const cause = new AIError({ reason: new QuotaExceededError({ message: "No credits" }) })
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"), { fallback: true })
      expect((yield* policy({ ...input(cause), retry: SessionRunnerRetry.shouldRetry(cause) })).retry).toBe(false)
      expect(SessionRunnerRetry.canFallback(cause)).toBe(true)
    }),
  )

  it.effect("recognizes model-specific 400s without retrying other invalid requests", () =>
    Effect.gen(function* () {
      const cause = new AIError({
        reason: new InvalidRequestError({
          message: "Unavailable",
          body: JSON.stringify({ object: "error", model: "chat" }),
          http: new HttpContext({ url: "https://example.com", status: 400, headers: {} }),
        }),
      })
      expect(SessionRunnerRetry.shouldRetry(cause)).toBe(true)
      expect(SessionRunnerRetry.canFallback(cause)).toBe(true)
      const invalid = new AIError({ reason: new InvalidRequestError({ message: "Bad parameter" }) })
      expect(SessionRunnerRetry.shouldRetry(invalid)).toBe(false)
      expect(SessionRunnerRetry.canFallback(invalid)).toBe(false)
    }),
  )

  it.effect("stops retrying transport timeouts after three attempts", () =>
    Effect.gen(function* () {
      expect(yield* decisions(timeout, 4)).toEqual([true, true, true, false])
    }),
  )

  it.effect("keeps the general allowance for other transient failures", () =>
    Effect.gen(function* () {
      expect(yield* decisions(internal, 10)).toEqual(Array(10).fill(true))
    }),
  )
})
