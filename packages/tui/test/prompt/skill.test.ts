import { describe, expect, test } from "bun:test"
import { Skill } from "@opencode/schema/skill"
import { references, skillTriggerIndex, withDollarSkills } from "../../src/component/prompt/skill"
import { emptyPrompt, parsePromptHistory } from "../../src/prompt/history"
import { expandPromptInputPastedText, realignPromptInputMentions } from "../../src/prompt/mention"
import { projectedPromptInput } from "../../src/prompt/codec"

describe("dollar skills", () => {
  test("opens only at token boundaries and uses textarea offsets", () => {
    expect(skillTriggerIndex("$", "unicode")).toBe(0)
    expect(skillTriggerIndex("日本\n$code-review", "unicode")).toBe(5)
    expect(skillTriggerIndex("$code next", "unicode")).toBeUndefined()
    expect(skillTriggerIndex("cost$code", "unicode")).toBeUndefined()
    expect(skillTriggerIndex("\\$code", "unicode")).toBeUndefined()
    expect(skillTriggerIndex("$HOME", "unicode")).toBeUndefined()
    expect(skillTriggerIndex("${HOME}", "unicode")).toBeUndefined()
    expect(skillTriggerIndex("$_TOKEN", "unicode")).toBeUndefined()
    expect(skillTriggerIndex("$HOME/path", "unicode")).toBeUndefined()
  })

  test("recognizes bounded names without treating environment variables as skills", () => {
    expect(references("$review, ($test) [$code]. $HOME ${HOME} cost$review \\$review").map((ref) => ref.name)).toEqual([
      "review",
      "test",
      "code",
    ])
    expect(withDollarSkills({ text: "$HOME $unknown $review" }, ["HOME", "review"], "unicode").skills).toEqual([
      { id: Skill.ID.make("review"), mention: { start: 15, end: 22, text: "$review" } },
    ])
  })

  test("deduplicates explicit @ skills and leaves attachments untouched", () => {
    const input = {
      ...emptyPrompt(),
      text: "@review $review $test $test",
      skills: [{ id: Skill.ID.make("review"), mention: { start: 0, end: 7, text: "@review" } }],
      agents: [{ name: "build" }],
      files: [{ uri: "file:///project/a.ts" }],
    }
    const result = withDollarSkills(input, ["review", "test"], "unicode")
    expect(result.skills).toEqual([
      input.skills[0],
      { id: Skill.ID.make("test"), mention: { start: 16, end: 21, text: "$test" } },
    ])
    expect(result.agents).toEqual(input.agents)
    expect(result.files).toEqual(input.files)
    expect(input.skills).toHaveLength(1)
  })

  test("round-trips semantic mentions through history, external editing and projected messages", () => {
    const prompt = withDollarSkills({ ...emptyPrompt(), text: "日本\n$review" }, ["review"], "unicode")
    expect(prompt.skills[0]?.mention).toEqual({ start: 5, end: 12, text: "$review" })
    const restored = parsePromptHistory(JSON.stringify(prompt))[0]!
    const edited = realignPromptInputMentions("prefix 日本\n$review", restored, "unicode")
    expect(edited.skills?.[0]?.mention).toEqual({ start: 12, end: 19, text: "$review" })
    expect(projectedPromptInput({ text: edited.text, skills: edited.skills }).skills).toEqual(edited.skills)
    expect(realignPromptInputMentions("removed", edited, "unicode").skills).toEqual([])
  })

  test("resolves skills in expanded multiline pastes before submitting", () => {
    const prompt = {
      ...emptyPrompt(),
      text: "日本 [Pasted] $test",
      skills: [{ id: Skill.ID.make("test"), mention: { start: 14, end: 19, text: "$test" } }],
      pasted: [{ text: "use\n$review", source: { start: 5, end: 13, text: "[Pasted]" } }],
    }
    const submitted = withDollarSkills(expandPromptInputPastedText(prompt, prompt.pasted, "unicode"), ["review", "test"], "unicode")
    expect(submitted.text).toBe("日本 use\n$review $test")
    expect(submitted.skills).toEqual([
      { id: Skill.ID.make("test"), mention: { start: 17, end: 22, text: "$test" } },
      { id: Skill.ID.make("review"), mention: { start: 9, end: 16, text: "$review" } },
    ])
  })
})
