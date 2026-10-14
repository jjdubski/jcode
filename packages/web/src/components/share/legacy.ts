import type { SessionV1 } from "@opencode/schema/session-v1"

// Pre-MessageV2 shares used AI SDK parts and kept message/tool details in metadata.
// Keep this historical wire shape local rather than depending on the retired backend.
export interface LegacyMessage {
  id: string
  role: "user" | "assistant"
  metadata: {
    sessionID: string
    time: { created: number; completed?: number }
    assistant?: {
      cost: number
      path: typeof SessionV1.Assistant.Encoded.path
      summary?: boolean
      tokens?: typeof SessionV1.Assistant.Encoded.tokens
      modelID: string
      providerID: string
    }
    error?: typeof SessionV1.Assistant.Encoded.error
    tool: Record<
      string,
      {
        title: string
        time: { start: number; end: number }
        [key: string]: unknown
      }
    >
  }
  parts: (
    | { type: "text"; text: string }
    | { type: "step-start" }
    | { type: "file"; mediaType: string; filename?: string; url: string }
    | {
        type: "tool-invocation"
        toolInvocation:
          | { state: "partial-call"; toolCallId: string; toolName: string }
          | { state: "call"; toolCallId: string; toolName: string; args: Record<string, unknown> }
          | { state: "result"; toolCallId: string; toolName: string; args: Record<string, unknown>; result: string }
      }
    | { type: "reasoning"; reasoning: string }
    | { type: "source"; source: unknown }
  )[]
}
