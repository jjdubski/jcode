import { expect } from "bun:test"
import {
  AIError,
  LLMClient,
  LLMEvent,
  LanguageModel,
  QuotaExceededError,
  type LLMRequest,
} from "@opencode/ai/effect"
import { OpenAIChat, OpenAIResponses } from "@opencode/ai/protocols"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Instructions } from "@opencode/core/instructions/index"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTable } from "@opencode/core/session/sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime, Effect, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"

const native = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "native-primary", provider: "test", route: OpenAIResponses.route }),
  {
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
    compaction: { type: "native" },
  },
)
const backup = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "summary-backup", provider: "test", route: OpenAIChat.route }),
  {
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
  },
)

const compacted: string[] = []
const streamed: string[] = []
const quota = new AIError({ reason: new QuotaExceededError({ message: "Usage exhausted" }) })
const client = Layer.mock(LLMClient.Service)({
  compact: (request: LLMRequest) => {
    compacted.push(String(request.model.id))
    return Effect.fail(quota)
  },
  stream: (request: LLMRequest) => {
    streamed.push(String(request.model.id))
    return Stream.make(LLMEvent.textDelta({ id: "summary", text: "## Objective\n- backup summary" }))
  },
  generate: () => Effect.die("unused"),
})

const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: (session) => Effect.succeed(session.model?.id === backup.ref.id ? backup : native),
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionCompaction.node,
      SessionModelRequest.node,
      PluginHooks.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      llmClient.replace(client),
      SessionRunnerModel.node.replace(models),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

/** Seeds the global project plus one session row, returning the projected session. */
const insertSession = (id: Session.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    const store = yield* SessionStore.Service
    return yield* store
      .get(id)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die(`session missing: ${id}`))))
  })

it.effect("a native primary falls back to a summary-only backup model", () =>
  Effect.gen(function* () {
    compacted.length = 0
    streamed.length = 0
    const compaction = yield* SessionCompaction.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const session = yield* insertSession(Session.ID.make("ses_native_backup"))
    const messages = [
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Please compact this session.",
        time: { created: DateTime.makeUnsafe(0) },
      }),
    ]
    const inputID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.Compaction.Started, { sessionID: session.id, reason: "manual", inputID })

    expect(
      yield* compaction.compact({
        reason: "manual",
        inputID,
        context: {
          session,
          messages,
          model: native,
          agent: {
            id: Agent.defaultID,
            info: { ...Agent.Info.default(Agent.defaultID), backupModel: [backup.ref] },
          },
          initial: [{ key: Instructions.Key.make("test/session"), text: "Session instructions" }],
          tools: { definitions: [], execute: () => Effect.die("Compaction must not execute tools") },
        },
      }),
    ).toEqual({ status: "completed", model: backup.ref })

    // The native primary took the provider checkpoints path, and the backup answered with a text summary.
    expect(compacted).toEqual(["native-primary"])
    expect(streamed).toEqual(["summary-backup"])
    expect(yield* store.context(session.id)).toMatchObject([
      {
        type: "compaction",
        reason: "manual",
        status: "completed",
        summary: "## Objective\n- backup summary",
        model: { id: "summary-backup", providerID: "test" },
      },
    ])
    expect((yield* store.context(session.id))[0]).not.toHaveProperty("native")
  }),
)
