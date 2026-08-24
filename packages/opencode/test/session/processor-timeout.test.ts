import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"
import { Permission } from "@/permission"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { TestClock } from "effect/testing"
import { LLMEvent } from "@opencode-ai/llm"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
        "test-backup": {
          id: "test-backup",
          name: "Test Backup",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
  Permission.node,
])
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const

// LLM layer where the primary model (test-model) hangs forever — forcing the
// processor's Effect.timeout("120 seconds") to fire — and the backup model
// (test-backup) answers immediately.
const hangThenSucceedLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) => {
      if (input.model.id === "test-backup") {
        return Stream.make(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      }
      return Stream.never
    },
  }),
)
const env = LayerNode.compile(root, [...replacements, [LLM.node, hangThenSucceedLLM]])
const it = testEffect(env)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// Runs the processor against a hanging primary model, advancing the TestClock
// past the 120s stream timeout so the Effect.timeout actually fires.
const runWithTimeout = Effect.fn("test.runWithTimeout")(function* (
  root: string,
  backupModels?: Provider.Model[],
) {
  const { processors, session, provider } = yield* boot()
  const chat = yield* session.create({})
  const parent = yield* user(chat.id, "hi")
  const msg = yield* assistant(chat.id, parent.id, root)
  const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
  const handle = yield* processors.create({
    assistantMessage: msg,
    sessionID: chat.id,
    model: mdl,
    backupModels,
  })
  const run = yield* handle
    .process({
      user: {
        id: parent.id,
        sessionID: chat.id,
        role: "user",
        time: parent.time,
        agent: parent.agent,
        model: { providerID: ref.providerID, modelID: ref.modelID },
      } satisfies SessionV1.User,
      sessionID: chat.id,
      model: mdl,
      agent: agent(),
      system: [],
      messages: [{ role: "user", content: "hi" }],
      tools: {},
    })
    .pipe(Effect.forkChild)
  yield* TestClock.adjust("121 seconds")
  const exit = yield* Fiber.await(run)
  return { exit, handle }
})

describe("session.processor timeout recovery", () => {
  it.effect("recovers from a stream timeout when backup models are available", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const backup = yield* boot().pipe(
            Effect.flatMap(({ provider }) => provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-backup"))),
          )
          const { exit, handle } = yield* runWithTimeout(dir, [backup])

          expect(Exit.isSuccess(exit)).toBe(true)
          if (!Exit.isSuccess(exit)) return
          expect(exit.value).toBe("continue")
          // The backup model should have been switched to after the timeout.
          expect(handle.message.modelID).toBe(ModelV2.ID.make("test-backup"))
        }),
      { config: cfg },
    ),
  )

  it.effect("does not recover from a stream timeout without backup models", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { exit, handle } = yield* runWithTimeout(dir, undefined)

          expect(Exit.isSuccess(exit)).toBe(true)
          if (!Exit.isSuccess(exit)) return
          expect(exit.value).toBe("stop")
          // A raw TimeoutError has no dedicated SessionRetry predicate, so
          // MessageV2.fromError falls back to UnknownError. The processor
          // replaces the opaque "TimeoutError" with a descriptive message.
          expect(handle.message.error?.name).toBe("UnknownError")
          expect(handle.message.error?.data).toMatchObject({
            message: "Stream timed out after 120 seconds — the model did not respond",
          })
        }),
      { config: cfg },
    ),
  )

  it.effect("does not time out while waiting for a permission reply", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          const permission = yield* Permission.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "hi")
          const msg = yield* assistant(chat.id, parent.id, dir)
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          // Raise a pending permission request for this session, simulating the
          // user being asked Allow/Always/Reject. The ask blocks until replied.
          const ask = yield* permission
            .ask({
              sessionID: chat.id,
              permission: "bash",
              patterns: ["*"],
              always: ["*"],
              metadata: { command: "sleep 1" },
              ruleset: [],
            })
            .pipe(Effect.forkChild)

          const requestID = yield* pollWithTimeout(
            Effect.gen(function* () {
              // Advance the TestClock so the poll sleep and the forked ask
              // fiber can make progress under it.effect.
              yield* TestClock.adjust("50 millis")
              return (yield* permission.list()).find((r) => r.sessionID === chat.id)?.id
            }),
            "permission request never became pending",
          )

          const run = yield* handle
            .process({
              user: {
                id: parent.id,
                sessionID: chat.id,
                role: "user",
                time: parent.time,
                agent: parent.agent,
                model: { providerID: ref.providerID, modelID: ref.modelID },
              } satisfies SessionV1.User,
              sessionID: chat.id,
              model: mdl,
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "hi" }],
              tools: {},
            })
            .pipe(Effect.forkChild)

          // Past the timeout, but the pending permission must pause the watchdog.
          yield* TestClock.adjust("121 seconds")
          expect(run.pollUnsafe()).toBeUndefined()

          // Reply to clear the pending request, then advance again: the watchdog
          // resumes and stops the hung stream.
          yield* permission.reply({ requestID, reply: "once" })
          yield* TestClock.adjust("121 seconds")
          const exit = yield* Fiber.await(run)
          expect(Exit.isSuccess(exit)).toBe(true)
          if (!Exit.isSuccess(exit)) return
          expect(exit.value).toBe("stop")
          expect(handle.message.error?.data).toMatchObject({
            message: "Stream timed out after 120 seconds — the model did not respond",
          })

          yield* Fiber.interrupt(ask)
        }),
      { config: cfg },
    ),
  )

  it.effect("Cause.isTimeoutError identifies the error produced by Effect.timeout", () =>
    Effect.gen(function* () {
      const run = yield* Stream.never.pipe(
        Stream.runDrain,
        Effect.timeout("10 millis"),
        Effect.forkChild,
      )
      yield* TestClock.adjust("1 second")
      const exit = yield* Fiber.await(run)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const error = Cause.squash(exit.cause)
      expect(Cause.isTimeoutError(error)).toBe(true)
      expect(Cause.isTimeoutError(new Cause.TimeoutError("Operation timed out"))).toBe(true)
      expect(Cause.isTimeoutError(new Error("not a timeout"))).toBe(false)
    }),
  )
})
