export * as SessionRunner from "./index.js"

import type { FileSystem } from "../../filesystem.js"
import type { AIError } from "@opencode/ai"
import { Context, Data, Effect } from "effect"
import { SessionSchema } from "../schema.js"
import type { Promotable } from "../inbox.js"
import type { AgentNotFoundError, MessageDecodeError, StepFailedError } from "../error.js"
import { SessionRunnerModel } from "./model.js"
import type { Instructions } from "../../instructions/index.js"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"

export type RunError =
  | AIError
  | SessionRunnerModel.Error
  | MessageDecodeError
  | AgentNotFoundError
  | StepFailedError
  | Instructions.InitializationBlocked
  | FileSystem.DirectoryNotFoundError

export type Continuation = {
  readonly step: number
  readonly fallback?: {
    readonly agent: Agent.ID
    readonly requested?: Model.Ref
    readonly primary: Model.Ref
    readonly selected: Model.Ref
  }
}

export type DrainResult = Data.TaggedEnum<{
  Complete: {}
  Moved: { readonly continuation?: Continuation }
  Reloaded: { readonly force: boolean; readonly continuation?: Continuation }
}>
export const DrainResult = Data.taggedEnum<DrainResult>()

/** Runs one local continuation from already-recorded Session history. */
export interface Interface {
  /** Drains eligible durable work, returning transient state when execution must continue at a new Location. */
  readonly drain: (input: {
    readonly sessionID: SessionSchema.ID
    readonly force: boolean
    readonly continuation?: Continuation
    /** "steer" settles the active intent without promoting queued next-turn work. */
    readonly promotable?: Promotable
  }) => Effect.Effect<DrainResult, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunner") {}
