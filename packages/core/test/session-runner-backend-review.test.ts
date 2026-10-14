import { expect, test } from "bun:test"
import { SessionRunnerFallback } from "@opencode/core/session/runner/fallback"
import { Model } from "@opencode/schema/model"
import { SessionV1 } from "@opencode/schema/v1/session"
import { Schema } from "effect"

test("exhausted backup variants are not revisited through later duplicate entries", () => {
  const primary = Model.Ref.parse("test/primary")
  const high = Model.Ref.parse("test/backup#high")
  const low = Model.Ref.parse("test/backup#low")
  expect(SessionRunnerFallback.candidates(low, [high, low, high], primary)).toEqual([])
})

test("legacy skill parts coexist with existing text, agent, and file attachment parts", () => {
  const parts = [
    { type: "text", text: "Review this" },
    { type: "agent", name: "reviewer" },
    { type: "file", mime: "text/plain", filename: "notes.txt", url: "data:text/plain,notes" },
    { type: "skill", name: "review", source: { value: "$review", start: 0, end: 7 } },
  ].map((part, index) => ({ id: `prt_${index}`, sessionID: "ses_legacy", messageID: "msg_legacy", ...part }))
  const decode = Schema.decodeUnknownSync(Schema.Array(SessionV1.Part))
  const decoded = decode(parts)
  expect(decoded.map((part) => part.type)).toEqual(["text", "agent", "file", "skill"])
  expect(decoded[2]).toMatchObject({ mime: "text/plain", filename: "notes.txt", url: "data:text/plain,notes" })
  expect(decoded[3]).toMatchObject({ name: "review", source: { value: "$review", start: 0, end: 7 } })
})
