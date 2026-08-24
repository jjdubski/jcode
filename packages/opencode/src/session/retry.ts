import type { NamedError } from "@opencode-ai/core/util/error"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"

export type Err = ReturnType<NamedError["toObject"]>

export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go"
export const GO_UPSELL_URL = "https://opencode.ai/go"
export type RetryReason = "free_tier_limit" | "account_rate_limit" | (string & {})

export type Retryable = {
  message: string
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_JITTER_FACTOR = 0.25
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
export const RETRY_MAX_RETRIES = 5

const RETRYABLE_MESSAGE_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: SessionV1.APIError, random = Math.random()) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(exponential(attempt, random))
    }
  }

  return cap(Math.min(exponential(attempt, random), RETRY_MAX_DELAY_NO_HEADERS))
}

function exponential(attempt: number, random: number) {
  const base = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
  return Math.ceil(base + base * RETRY_JITTER_FACTOR * random)
}

export function retryable(error: Err, provider: string): Retryable | undefined {
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (
      !error.data.isRetryable &&
      !(status !== undefined && status >= 500) &&
      !matchesRetryableMessage(error.data.message) &&
      !matchesRetryableMessage(error.data.responseBody)
    )
      return undefined
    if (error.data.responseBody?.includes("FreeUsageLimitError")) {
      return {
        message: GO_UPSELL_MESSAGE,
        action: {
          reason: "free_tier_limit",
          provider,
          title: "Free limit reached",
          message: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
          label: "subscribe",
          link: GO_UPSELL_URL,
        },
      }
    }
    if (error.data.responseBody?.includes("GoUsageLimitError")) {
      const body = parseJSON(error.data.responseBody)
      const workspace = str(body?.metadata?.workspace)
      const limitName = str(body?.metadata?.limitName)
      const retryAfter = num(error.data.responseHeaders?.["retry-after"])
      const resetIn = iife(() => {
        if (retryAfter === undefined) return ""
        const seconds = Math.max(0, Math.ceil(retryAfter))
        const days = Math.floor(seconds / 86_400)
        const hours = Math.floor((seconds % 86_400) / 3_600)
        const minutes = Math.ceil((seconds % 3_600) / 60)
        const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`

        if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")
        if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")
        return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
      })

      const message = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`

      const link = `https://opencode.ai/workspace/${workspace}/go`
      return {
        message: `${message} - ${link}`,
        action: {
          reason: "account_rate_limit",
          provider,
          title: "Go limit reached",
          message,
          label: "open settings",
          link,
        },
      }
    }
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  const message = isRecord(error.data) ? error.data.message : undefined
  if (typeof message !== "string") return undefined
  const lower = message.toLowerCase()
  if (lower.includes("too_many_requests")) return { message: "Too Many Requests" }
  if (lower.includes("exhausted") || lower.includes("unavailable")) return { message: "Provider is overloaded" }
  if (matchesRetryableMessage(message)) return { message }
  return undefined
}

function matchesRetryableMessage(value: unknown) {
  return typeof value === "string" && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
}

function str(value: unknown) {
  if (value === undefined || value === null) return ""
  return String(value)
}

function num(value: unknown) {
  const parsed = Number.parseFloat(str(value))
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

/**
 * Detects connection-type errors where the HTTP request never reached the server
 * (no HTTP status code). The AI SDK's `APICallError` with `statusCode: undefined`
 * and `isRetryable: true` indicates a network/connection failure.
 */
export function isRetriableConnectionError(error: Err): boolean {
  // Check on message text first regardless of error type
  if (SessionV1.APIError.isInstance(error)) {
    if (error.data.statusCode === undefined && error.data.isRetryable === true) return true
    const msg = (error.data.message ?? "").toLowerCase()
    if (msg.includes("cannot connect to api") || msg.includes("unable to connect")) return true
  }
  // Also check generic error messages for connection failures
  const genericMsg =
    typeof error.data === "object" && error.data !== null
      ? String((error.data as Record<string, unknown>).message ?? "")
      : ""
  return (
    genericMsg.toLowerCase().includes("cannot connect to api") || genericMsg.toLowerCase().includes("unable to connect")
  )
}

/**
 * Detects "Model unloaded" errors from the provider. These are non-recoverable
 * for the current model — retrying the same model will keep failing — so the
 * caller should fall through to a backup model instead.
 */
export function isModelUnloadedError(error: Err): boolean {
  if (!SessionV1.APIError.isInstance(error)) return false
  const msg = error.data.message?.toLowerCase() ?? ""
  return msg.includes("model unloaded")
}

/**
 * Detects temporary inference unavailability errors. Retrying the same model
 * is unlikely to help, so the caller should fall through to a backup model.
 */
export function isInferenceUnavailableError(error: Err): boolean {
  if (!SessionV1.APIError.isInstance(error)) return false
  const msg = error.data.message?.toLowerCase() ?? ""
  return msg.includes("inference is temporarily unavailable")
}

/**
 * Detects rate limit errors from the provider (HTTP 429, "rate limit exceeded",
 * "too many requests", etc.). These indicate the model or API key is being
 * rate-limited — retrying the same model is unlikely to succeed within a
 * reasonable timeframe, so the caller should fall through to a backup model.
 */
export function isRateLimitError(error: Err): boolean {
  // HTTP 429 Too Many Requests
  if (SessionV1.APIError.isInstance(error) && error.data.statusCode === 429) return true

  // Check for rate limit patterns in plain text error messages
  const msg = isRecord(error.data) ? error.data.message : undefined
  if (typeof msg === "string") {
    const lower = msg.toLowerCase()
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests")
    )
      return true

    const json = parseJSON(msg)
    if (json && typeof json === "object") {
      if (json.type === "error" && json.error?.type === "too_many_requests") return true
      if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit"))
        return true
    }
  }

  return false
}

/**
 * Detects usage limit errors from the provider (free tier, Go, or account
 * balance limits). These indicate the account has exhausted its usage
 * allowance — retrying the same model will not help, so the caller should fall
 * through to a backup model immediately.
 */
export function isUsageLimitError(error: Err): boolean {
  if (!SessionV1.APIError.isInstance(error)) return false
  const body = error.data.responseBody ?? ""
  return (
    body.includes("FreeUsageLimitError") ||
    body.includes("GoUsageLimitError") ||
    body.includes("BlackUsageLimitError")
  )
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

/**
 * Creates a retry policy schedule. With `maxRetries: 0`, the first attempt
 * runs but no retries occur after failure. With `maxRetries: 1`, one retry
 * follows the initial attempt. `maxRetries` defaults to undefined (unlimited
 * retries) when omitted.
 */
export function policy(opts: {
  provider: string
  maxRetries?: number
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const retry = retryable(error, opts.provider)
      if (!retry) return Cause.done(meta.attempt)
      if (meta.attempt > RETRY_MAX_RETRIES) return Cause.done(meta.attempt)

      // Connection errors, "Model unloaded" errors, and rate limit errors are
      // capped at 1 retry so the caller can fall through to a backup model
      // quickly. Usage limit errors are not retried at all — the caller should
      // switch to a backup model immediately.
      const cap = isUsageLimitError(error)
        ? 0
        : isRetriableConnectionError(error) ||
            isModelUnloadedError(error) ||
            isRateLimitError(error) ||
            isInferenceUnavailableError(error)
          ? 1
          : opts.maxRetries
      if (cap !== undefined && meta.attempt > cap) return Cause.done(meta.attempt)

      return Effect.gen(function* () {
        const wait = delay(meta.attempt, SessionV1.APIError.isInstance(error) ? error : undefined)
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: retry.message,
          action: retry.action,
          next: now + wait,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
