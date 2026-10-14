import { test } from "node:test"
import { deepStrictEqual, partialDeepStrictEqual } from "node:assert/strict"
import { fromV1 } from "../Share"
import type { LegacyMessage } from "./legacy"

test("legacy user shares preserve text, attachments, and original part indexes", () => {
  deepStrictEqual(
    fromV1({
      id: "message",
      role: "user",
      metadata: { sessionID: "session", time: { created: 1 }, tool: {} },
      parts: [
        { type: "text", text: "hello" },
        { type: "step-start" },
        { type: "file", mediaType: "image/png", filename: "image.png", url: "https://example.com/image.png" },
      ],
    }),
    {
      id: "message",
      sessionID: "session",
      role: "user",
      agent: "user",
      model: { providerID: "", modelID: "" },
      time: { created: 1 },
      parts: [
        { id: "0", messageID: "message", sessionID: "session", type: "text", text: "hello" },
        {
          id: "2",
          messageID: "message",
          sessionID: "session",
          type: "file",
          mime: "image/png",
          filename: "image.png",
          url: "https://example.com/image.png",
        },
      ],
    },
  )
})

test("legacy assistant shares preserve tool states, metadata, and token defaults", () => {
  const legacy: LegacyMessage = {
    id: "message",
    role: "assistant",
    metadata: {
      sessionID: "session",
      time: { created: 1, completed: 4 },
      assistant: { cost: 0.2, path: { cwd: "/work", root: "/" }, modelID: "model", providerID: "provider" },
      tool: { call: { title: "Read file", time: { start: 2, end: 3 }, lines: 10 } },
    },
    parts: [
      { type: "step-start" },
      { type: "tool-invocation", toolInvocation: { state: "partial-call", toolCallId: "call", toolName: "read" } },
      {
        type: "tool-invocation",
        toolInvocation: { state: "call", toolCallId: "call", toolName: "read", args: { file: "a" } },
      },
      {
        type: "tool-invocation",
        toolInvocation: {
          state: "result",
          toolCallId: "call",
          toolName: "read",
          args: { file: "a" },
          result: "contents",
        },
      },
      { type: "text", text: "done" },
    ],
  }
  const result = fromV1(legacy)
  partialDeepStrictEqual(result, {
    role: "assistant",
    parentID: "",
    agent: "build",
    mode: "build",
    cost: 0.2,
    path: { cwd: "/work", root: "/" },
    time: { created: 1, completed: 4 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  partialDeepStrictEqual(result.parts, [
    { id: "0", type: "step-start" },
    { id: "1", type: "tool", state: { status: "pending", input: {}, raw: "" } },
    { id: "2", type: "tool", state: { status: "running", input: { file: "a" }, time: { start: 2 } } },
    {
      id: "3",
      type: "tool",
      state: {
        status: "completed",
        input: { file: "a" },
        output: "contents",
        title: "Read file",
        time: { start: 2, end: 3 },
        metadata: { lines: 10 },
      },
    },
    { id: "4", type: "text", text: "done" },
  ])
  legacy.metadata.assistant!.tokens = { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } }
  partialDeepStrictEqual(fromV1(legacy), { tokens: legacy.metadata.assistant!.tokens })
})
