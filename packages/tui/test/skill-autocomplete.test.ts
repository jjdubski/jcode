import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

test.each(["$", "@"])("%s skill autocomplete sorts skills and retains the selected prefix", async (prefix) => {
  await using setup = await createAppFixture({
    fetch: (url) => {
      if (url.pathname === "/api/fs/find") return json({ location: { directory }, data: [] })
      if (url.pathname === "/api/skill")
        return json({
          location: { directory },
          data: ["zulu", "alpha"].map((id) => ({
            id,
            name: id,
            description: `${id} skill detail`,
            path: `/skills/${id}`,
            content: id,
          })),
        })
      return undefined
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  await setup.mockInput.typeText(prefix)
  await setup.waitForFrame((frame) => frame.includes("zulu skill detail"))
  const frame = setup.captureCharFrame()
  expect(frame.indexOf("alpha skill detail")).toBeLessThan(frame.indexOf("zulu skill detail"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes(`${prefix}alpha`) && !frame.includes("zulu skill detail"))
  expect(setup.captureCharFrame()).toContain(`${prefix}alpha`)
  setup.mockInput.pressKey("u", { ctrl: true })
  await setup.renderOnce()
})

test("environment variables dismiss dollar autocomplete without invoking skills", async () => {
  await using setup = await createAppFixture({
    fetch: (url) =>
      url.pathname === "/api/skill"
        ? json({
            location: { directory },
            data: [
              { id: "HOME", name: "HOME", description: "not a variable popup", path: "/skills/HOME", content: "" },
            ],
          })
        : undefined,
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  await setup.mockInput.typeText("$")
  await setup.waitForFrame((frame) => frame.includes("not a variable popup"))
  await setup.mockInput.typeText("HOME")
  await setup.waitForFrame((frame) => frame.includes("$HOME") && !frame.includes("not a variable popup"))
  setup.mockInput.pressKey("u", { ctrl: true })
  await setup.renderOnce()
})

test.each(["$", "@"])("selected %s skills submit using current semantic attachments", async (prefix) => {
  const location = { directory, project: { id: "project", directory } }
  const session = {
    id: "ses_skills",
    title: "Skill fixture",
    projectID: "project",
    location: { directory },
    agent: "build",
    model: { providerID: "provider", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const submitted = Promise.withResolvers<unknown>()
  await using setup = await createAppFixture({
    args: { sessionID: session.id },
    fetch: async (url, request) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }] })
      if (url.pathname === "/api/skill")
        return json({
          location,
          data: [
            { id: "review", name: "review", description: "review skill detail", path: "/skills/review", content: "" },
          ],
        })
      if (url.pathname === "/api/fs/find") return json({ location, data: [] })
      if (url.pathname === `/api/session/${session.id}/prompt`) {
        submitted.resolve(await request.json())
        return json({ data: {} })
      }
      return undefined
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Skill fixture") && frame.includes("Model"))
  await setup.mockInput.typeText(prefix)
  await setup.waitForFrame((frame) => frame.includes("review skill detail"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes(`${prefix}review`) && !frame.includes("review skill detail"))
  setup.mockInput.pressEnter()
  const body = await Promise.race([
    submitted.promise,
    Bun.sleep(2000).then(() => {
      throw new Error("skill prompt was not submitted")
    }),
  ])
  expect(body).toMatchObject({
    text: `${prefix}review `,
    skills: [{ id: "review", mention: { start: 0, end: 7, text: `${prefix}review` } }],
  })
  expect(body).not.toHaveProperty("parts")
})
