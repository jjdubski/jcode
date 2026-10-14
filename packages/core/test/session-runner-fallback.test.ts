import { expect, test } from "bun:test"
import { LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Model } from "@opencode/schema/model"
import { SessionRunnerFallback } from "@opencode/core/session/runner/fallback"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Effect } from "effect"
import { it } from "./lib/effect"

test("backup candidates retain order and variants without cycling through the primary or duplicates", () => {
  const primary = Model.Ref.parse("test/primary")
  const first = Model.Ref.parse("test/backup#high")
  const second = Model.Ref.parse("test/backup#low")
  const backups = [first, primary, first, second]
  expect(SessionRunnerFallback.candidates(primary, backups)).toEqual([first, second])
  expect(SessionRunnerFallback.candidates(first, backups, primary)).toEqual([second])
  expect(SessionRunnerFallback.candidates(second, backups, primary)).toEqual([])
})

it.effect("skips unavailable backups and returns the first resolvable variant", () =>
  Effect.gen(function* () {
    const primary = Model.Ref.parse("test/primary")
    const missing = Model.Ref.parse("test/missing")
    const backup = Model.Ref.parse("test/backup#high")
    const seen: Model.Ref[] = []
    const selected = yield* SessionRunnerFallback.next(primary, [missing, backup], (ref) => {
      seen.push(ref)
      if (ref.id === "missing")
        return Effect.fail(
          new SessionRunnerModel.ModelUnavailableError({ providerID: ref.providerID, modelID: ref.id }),
        )
      return Effect.succeed(
        SessionRunnerModel.resolved(
          LanguageModel.make({ id: ref.id, provider: ref.providerID, route: OpenAIChat.route }),
          {
            capabilities: Model.Capabilities.default(),
            cost: [],
            limit: { context: 200_000, output: 32_000 },
            variant: ref.variant,
          },
        ),
      )
    })
    expect(seen).toEqual([missing, backup])
    expect(selected?.ref).toEqual(backup)
  }),
)
