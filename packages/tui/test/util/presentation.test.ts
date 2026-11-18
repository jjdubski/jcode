import { expect, test } from "bun:test"
import { epilogue } from "../../src/util/presentation"
import { logo } from "../../src/logo"

const rows = (text: string | undefined) =>
  Bun.stripANSI(text ?? "")
    .split("\n")
    .filter((line) => line.trim() && !/[▀▄█⠀]/.test(line))

test("prints nothing without a session or update", () => {
  expect(epilogue({})).toBeUndefined()
})

test("formats session continuation summary", () => {
  expect(rows(epilogue({ session: { title: "A session", sessionID: "ses_123" } }))).toEqual([
    "  Session   A session",
    "  Continue  jcode -s ses_123",
  ])
})

test("tells the user to start jcode again after an update", () => {
  expect(rows(epilogue({ updatedVersion: "2.0.0" }))).toEqual(["  Run jcode to use 2.0.0"])
})

test("keeps the session continuation after an update", () => {
  expect(rows(epilogue({ session: { title: "A session", sessionID: "ses_123" }, updatedVersion: "2.0.0" }))).toEqual([
    "  Run jcode to use 2.0.0",
    "  Session   A session",
    "  Continue  jcode -s ses_123",
  ])
})

test("draws the jcode logo", () => {
  const text = epilogue({ session: { title: "A session", sessionID: "ses_123" } })
  expect(logo.left).toEqual(["⠀    ", "⠀   ▀", "    █", " █__█", " ▀vv█"])
  expect(text).not.toContain("vv")
  expect(text).toContain("▄")
})
