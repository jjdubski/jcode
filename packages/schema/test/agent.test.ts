import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "../src/agent.js"
import { Model } from "../src/model.js"
import { ConfigAgent } from "../src/config/agent.js"

test("Agent.Color preserves configured colors at the public boundary", () => {
  const encode = Schema.encodeSync(Agent.Color)

  expect(encode("info")).toBe("info")
  expect(encode("custom-color")).toBe("custom-color")
})

test("agent backup models preserve ordered typed model references and omit absent values", () => {
  const agent = Agent.Info.default(Agent.ID.make("build"))
  const encode = Schema.encodeSync(Agent.Info)
  expect(encode({ ...agent, backupModel: undefined })).not.toHaveProperty("backupModel")
  const backupModel = [Model.Ref.parse("test/chat#high"), Model.Ref.parse("other/chat")]
  expect(encode({ ...agent, backupModel }).backupModel).toEqual(backupModel)
})

test("native backup model selections accept strings and explicit variants in order", () => {
  const config = Schema.decodeUnknownSync(ConfigAgent.Info)({
    backupModel: ["test/chat#high", { providerID: "other", model: "chat", variant: "low" }],
  })
  expect(config.backupModel?.map((model) => `${model.providerID}/${model.model}#${model.variant}`)).toEqual([
    "test/chat#high",
    "other/chat#low",
  ])
  expect(Schema.encodeSync(ConfigAgent.Info)(new ConfigAgent.Info({ backupModel: undefined }))).not.toHaveProperty(
    "backupModel",
  )
  expect(() => Schema.decodeUnknownSync(ConfigAgent.Info)({ backupModel: ["invalid"] })).toThrow()
})
