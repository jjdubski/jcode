import type { PromptInput } from "@opencode/schema"
import { Skill } from "@opencode/schema/skill"
import { displaySlice, mentionTriggerIndex, promptOffsetWidth } from "../../prompt/display"

export function skillTriggerIndex(text: string, offset = promptOffsetWidth(text)) {
  const index = mentionTriggerIndex(text, offset, "$")
  if (index === undefined) return
  const query = displaySlice(text, index + 1, offset)
  // Shell variables are not skill invocations, even when a similarly named skill exists.
  if (query && (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(query) || /^[A-Z_][A-Z0-9_]*$/.test(query))) return
  return index
}

export function withDollarSkills<T extends PromptInput.Prompt>(input: T, ids: readonly string[]) {
  const skills = [...(input.skills ?? [])]
  for (const ref of references(input.text)) {
    if (!ids.includes(ref.name) || skills.some((skill) => skill.id === ref.name)) continue
    const start = promptOffsetWidth(input.text.slice(0, ref.start))
    skills.push({
      id: Skill.ID.make(ref.name),
      mention: { start, end: start + promptOffsetWidth(ref.value), text: ref.value },
    })
  }
  return { ...input, skills }
}

// 'g' flag is required by String.prototype.matchAll; avoid exec/test/match on this object to prevent lastIndex leakage.
const REGEX = /\$([a-zA-Z][a-zA-Z0-9_-]*)/g

function gap(text: string, start: number, end: number) {
  const prev = start === 0 ? "" : text[start - 1]
  const next = text[end] ?? ""
  if (prev && !/(?:\s|\(|\[)/.test(prev)) return false
  if (next && !/(?:\s|\)|\]|\.|,|!|\?|:|;)/.test(next)) return false
  return true
}

export function references(text: string): Array<{ name: string; start: number; end: number; value: string }> {
  const results: Array<{ name: string; start: number; end: number; value: string }> = []
  for (const match of text.matchAll(REGEX)) {
    const name = match[1]
    if (!name) continue
    if (/^[A-Z_][A-Z0-9_]*$/.test(name)) continue
    const start = match.index ?? 0
    const end = start + match[0].length
    if (!gap(text, start, end)) continue
    results.push({ name, start, end, value: match[0] })
  }
  return results
}
