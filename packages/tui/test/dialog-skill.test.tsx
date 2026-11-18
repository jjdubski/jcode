import { beforeEach, expect, test } from "bun:test"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

// The draft stash is process-global: prompt-offset and other app tests leave a home draft that
// this prompt would restore ahead of the typed trigger.
beforeEach(() => takeDraft(undefined))

test("skills dialog lists every skill in alphabetical order", async () => {
  await using setup = await createAppFixture({
    fetch: (url) => {
      if (url.pathname !== "/api/skill") return undefined
      return json({
        location: { directory },
        data: ["zulu", "mike", "alpha"].map((id) => ({
          id,
          name: id,
          description: `${id} skill detail`,
          path: `/skills/${id}`,
          content: id,
        })),
      })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  await setup.mockInput.typeText("/skills")
  await setup.waitForFrame((frame) => frame.includes("/skills"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("alpha skill detail"))
  const frame = setup.captureCharFrame()
  expect(frame.indexOf("alpha skill detail")).toBeLessThan(frame.indexOf("mike skill detail"))
  expect(frame.indexOf("mike skill detail")).toBeLessThan(frame.indexOf("zulu skill detail"))
  setup.mockInput.pressEscape()
  await setup.flush()
})
