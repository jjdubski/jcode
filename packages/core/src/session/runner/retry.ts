export * as SessionRunnerRetry from "./retry.js"

import { AIError, isContextOverflowFailure, isRetryable } from "@opencode/ai/effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { SessionError } from "@opencode/schema/session-error"
import { Clock, Duration, Effect, Option, Schema } from "effect"
import { Bus } from "../../bus.js"
import { ModelRetry } from "../../model-retry.js"
import type { PluginHooks } from "../../plugin/hooks.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"

const decodeModelError = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ object: Schema.Literal("error"), model: Schema.String })),
)

const modelUnavailable = (error: AIError) =>
  /model unloaded|inference is temporarily unavailable/i.test(error.message) ||
  (error.reason.http?.status === 400 && Option.isSome(decodeModelError(error.reason.body)))

const usageLimit = (error: AIError) =>
  error.reason._tag === "QuotaExceeded" || /(?:Free|Go|Black)UsageLimitError/.test(error.reason.body ?? "")

export { isRetryable }

export const shouldRetry = (error: AIError) =>
  !usageLimit(error) &&
  !isContextOverflowFailure(error) &&
  (isRetryable(error) || modelUnavailable(error) || error.reason._tag === "Timeout")

/** Deterministic request, authentication, and policy failures must not silently change models. */
export const canFallback = (error: AIError) =>
  !isContextOverflowFailure(error) && (shouldRetry(error) || usageLimit(error))

interface Input {
  readonly cause: AIError
  readonly error: SessionError.Error
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly hook: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  readonly retry: boolean
}

export interface Decision {
  readonly retry: true
  readonly attempt: number
  readonly delay: number
}

// Availability failures get one same-model retry when backups exist; general transient failures keep the bounded
// upstream schedule. Timeouts have their own cap either way, because each attempt already waited before failing.
const shortRetry = (error: AIError) =>
  error.reason._tag === "Transport" ||
  error.reason._tag === "Timeout" ||
  error.reason._tag === "RateLimit" ||
  /rate increased too quickly|rate[-_ ]limit|too many requests|cannot connect to api|unable to connect|fetch failed|connection (?:error|refused|lost)|econnreset|etimedout/i.test(
    error.message,
  ) ||
  modelUnavailable(error)

/** A timed-out attempt already waited minutes before failing, so it keeps a lower cap than the general allowance. */
const MAX_TIMEOUT_RETRIES = 3

export const policy = (sessionID: SessionSchema.ID, options?: { readonly fallback: boolean }) =>
  Effect.gen(function* () {
    const decide = yield* ModelRetry.policy
    let short = 0
    let timeouts = 0
    return (input: Input) =>
      Effect.gen(function* () {
        // A backup model can take over an unavailable one, so it gets a single same-model retry first.
        const unavailable = options?.fallback === true && shortRetry(input.cause)
        if (unavailable) short++
        const brief = unavailable && short > 1
        if (
          input.cause.reason._tag === "Timeout" ||
          (input.cause.reason._tag === "Transport" && input.cause.reason.code === "Timeout")
        )
          timeouts++
        if (timeouts > MAX_TIMEOUT_RETRIES) return { retry: false as const }
        const next = yield* decide({ cause: input.cause, retry: input.retry && !brief })
        if (!next?.retry) return { retry: false as const }
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt: next.attempt,
          decision: { retry: true, delay: next.delay },
        }
        yield* input.hook(event)
        if (!event.decision.retry) return event.decision
        const normalized =
          Number.isFinite(event.decision.delay) && event.decision.delay >= 0
            ? Math.ceil(event.decision.delay)
            : next.delay
        return { retry: true as const, attempt: next.attempt, delay: normalized }
      })
  })

export const make = (bus: Bus.Interface, sessionID: SessionSchema.ID, options?: { readonly fallback: boolean }) =>
  Effect.gen(function* () {
    const decide = yield* policy(sessionID, options)
    const wait = (input: {
      readonly decision: Decision
      readonly assistantMessageID: SessionMessage.ID
      readonly error: SessionError.Error
    }) =>
      Effect.gen(function* () {
        const scheduled = yield* Clock.currentTimeMillis
        yield* bus.publish(SessionEvent.RetryScheduled, {
          sessionID,
          assistantMessageID: input.assistantMessageID,
          attempt: input.decision.attempt,
          at: scheduled + input.decision.delay,
          error: input.error,
        })
        const remaining = Math.max(0, scheduled + input.decision.delay - (yield* Clock.currentTimeMillis))
        yield* Effect.sleep(Duration.millis(remaining))
      })
    return { decide, wait }
  })
