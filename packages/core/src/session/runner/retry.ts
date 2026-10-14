export * as SessionRunnerRetry from "./retry.js"

import {
  AIError,
  isContextOverflowFailure,
  isRetryable,
  ProviderInternalError,
  QuotaExceededError,
  RateLimitError,
  TransportError,
  UnknownProviderError,
  type ProviderErrorEvent,
} from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { SessionError } from "@opencode/schema/session-error"
import { Clock, Duration, Effect, Option, Pull, Schedule, Schema } from "effect"
import { Bus } from "../../bus.js"
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

/** Streaming protocols sometimes report recoverable failures in-band rather than as typed HTTP errors. */
export const fromProviderError = (event: ProviderErrorEvent) => {
  if (event.classification !== undefined) return
  const message = event.message
  if (/(?:Free|Go|Black)UsageLimitError|usage (?:limit|exceeded)|quota exceeded/i.test(message))
    return new AIError({ reason: new QuotaExceededError({ message }) })
  if (/rate increased too quickly|rate[-_ ]limit|too many requests/i.test(message))
    return new AIError({ reason: new RateLimitError({ message }) })
  if (/model unloaded|inference is temporarily unavailable/i.test(message))
    return new AIError({ reason: new UnknownProviderError({ message }) })
  if (
    /fetch failed|cannot connect to api|unable to connect|connection (?:error|refused|lost)|socket hang up|econnreset|etimedout/i.test(
      message,
    )
  )
    return new AIError({ reason: new TransportError({ message, transport: "http", operation: "read" }) })
  if (/overloaded|service unavailable|internal server error|try your request again/i.test(message))
    return new AIError({ reason: new ProviderInternalError({ message }) })
}

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

/** Bound provider-requested delays so a hostile or buggy retry-after cannot stall a session for hours. */
const RETRY_AFTER_MAX = Duration.toMillis("15 minutes")

const retryAfter = (input: Input) => {
  if (input.cause.reason._tag === "RateLimit" || input.cause.reason._tag === "ProviderInternal")
    return input.cause.reason.retryAfterMs === undefined
      ? undefined
      : Math.min(input.cause.reason.retryAfterMs, RETRY_AFTER_MAX)
  return undefined
}

// Exponential from 2s capped at 10s per gap, for 10 retries: 2, 4, 8, then 10 × 7, about 84s of
// waiting when every attempt fails (67–101s with jitter). `min` takes the faster schedule, so the
// cap applies per gap; `max` with `recurs` bounds the count.
const schedule = Schedule.max([
  Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced("10 seconds")]),
  Schedule.recurs(10),
]).pipe(
  Schedule.jittered,
  Schedule.setInputType<Input>(),
  Schedule.modifyDelay(({ input, duration: delay }) => {
    const minimum = retryAfter(input)
    const duration = minimum === undefined ? delay : Duration.max(delay, Duration.millis(minimum))
    return Effect.succeed(Duration.millis(Math.ceil(Duration.toMillis(duration))))
  }),
)

// Availability failures get one same-model retry when backups exist; general transient failures
// retain the bounded upstream schedule. Without backups, timeouts retain their separate three-retry cap.
const shortRetry = (error: AIError) =>
  error.reason._tag === "Transport" ||
  error.reason._tag === "Timeout" ||
  error.reason._tag === "RateLimit" ||
  /rate increased too quickly|rate[-_ ]limit|too many requests|cannot connect to api|unable to connect|fetch failed|connection (?:error|refused|lost)|econnreset|etimedout/i.test(
    error.message,
  ) ||
  modelUnavailable(error)

export const policy = (sessionID: SessionSchema.ID, options?: { readonly fallback: boolean }) =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(schedule)
    let attempt = 1
    let short = 0
    let timeouts = 0
    return (input: Input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const next = yield* step(now, input).pipe(Pull.catchDone(() => Effect.succeed(undefined)))
        if (!next) return { retry: false as const }
        const [, duration] = next
        attempt++
        if (shortRetry(input.cause)) short++
        if (
          input.cause.reason._tag === "Timeout" ||
          (input.cause.reason._tag === "Transport" && input.cause.reason.code === "Timeout")
        )
          timeouts++
        const delay = Math.ceil(Duration.toMillis(duration))
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt,
          decision:
            input.retry && timeouts <= 3 && (!options?.fallback || short <= 1)
              ? { retry: true, delay }
              : { retry: false },
        }
        yield* input.hook(event)
        if (!event.decision.retry) return event.decision
        const normalized =
          Number.isFinite(event.decision.delay) && event.decision.delay >= 0 ? Math.ceil(event.decision.delay) : delay
        return { retry: true as const, attempt, delay: normalized }
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
