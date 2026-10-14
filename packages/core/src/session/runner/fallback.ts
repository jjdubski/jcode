export * as SessionRunnerFallback from "./fallback.js"

import { Model } from "@opencode/schema/model"
import { Effect } from "effect"
import type { SessionRunnerModel } from "./model.js"

/** A selected backup consumes the candidates before it, including across subsequent Steps. */
export const candidates = (current: Model.Ref, backups: ReadonlyArray<Model.Ref>, primary = current) => {
  const index = same(current, primary) ? -1 : backups.findIndex((model) => same(model, current))
  const seen = new Set([key(current), key(primary)])
  return backups.filter((model, position) => {
    const id = key(model)
    if (seen.has(id)) return false
    seen.add(id)
    return position > index
  })
}

export const same = (left: Model.Ref | undefined, right: Model.Ref | undefined) =>
  left?.providerID === right?.providerID && left?.id === right?.id && left?.variant === right?.variant

const key = (model: Model.Ref) => `${model.providerID}/${model.id}#${model.variant ?? ""}`

export const next = (
  current: Model.Ref,
  backups: ReadonlyArray<Model.Ref>,
  resolve: (model: Model.Ref) => Effect.Effect<SessionRunnerModel.Resolved, SessionRunnerModel.Error>,
  primary = current,
) =>
  Effect.gen(function* () {
    for (const model of candidates(current, backups, primary)) {
      const resolved = yield* resolve(model).pipe(Effect.orElseSucceed(() => undefined))
      if (resolved) return resolved
      yield* Effect.logWarning("backup model unavailable", { model })
    }
  })
