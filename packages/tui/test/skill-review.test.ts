import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

test("shell input does not open dollar skill autocomplete", async () => {
  await using setup = await createAppFixture({
    fetch: (url) => {
      if (url.pathname === "/api/fs/find") return json({ location: { directory }, data: [] })
      if (url.pathname === "/api/skill")
        return json({
          location: { directory },
          data: [{ id: "review", name: "review", description: "review skill detail", path: "/skills/review", content: "" }],
        })
      return undefined
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  await setup.mockInput.typeText("!echo ")
  await setup.waitForFrame((frame) => frame.includes("Shell") && frame.includes("echo"))
  await setup.mockInput.typeText("$")
  await Bun.sleep(200)
  await setup.renderOnce()
  await setup.renderOnce()
  expect(setup.captureCharFrame()).not.toContain("review skill detail")
  setup.mockInput.pressTab()
  await setup.renderOnce()
  expect(setup.captureCharFrame()).not.toContain("$review")

  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("exit shell mode"))
  await setup.mockInput.typeText("r")
  await setup.waitForFrame((frame) => frame.includes("review skill detail"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("echo $review") && !frame.includes("review skill detail"))

  setup.mockInput.pressKey("u", { ctrl: true })
  await setup.waitForFrame((frame) => !frame.includes("echo $review"))
  await setup.mockInput.typeText("!")
  await setup.waitForFrame((frame) => frame.includes("Shell"))
  await setup.mockInput.typeText("@r")
  await setup.waitForFrame((frame) => frame.includes("Shell") && frame.includes("review skill detail"))
  setup.mockInput.pressEscape()
  setup.mockInput.pressKey("u", { ctrl: true })
  await setup.waitForFrame((frame) => !frame.includes("@r"))
  await setup.mockInput.typeText("/theme")
  await setup.waitForFrame((frame) => frame.includes("Shell") && frame.includes("Switch theme"))
})
