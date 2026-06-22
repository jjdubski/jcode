/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ExitProvider, useExit } from "../src/context/exit"
import { EpilogueProvider, useEpilogue } from "../src/context/epilogue"
import { onCleanup } from "solid-js"
import { sessionEpilogue } from "../src/util/presentation"
import type { CliRenderer } from "@opentui/core"

test("epilogue snapshot preserves value through renderer destroy and cleanup", async () => {
  // Emulate the exit object from app.tsx (line 178)
  const exit = {
    epilogue: undefined as string | undefined,
    epilogueSnapshot: undefined as string | undefined,
  }
  const rendererRef = { current: undefined as CliRenderer | undefined }
  let triggerExit!: (reason?: unknown) => void
  let setEpilogue!: (value?: string) => void

  function TestApp() {
    setEpilogue = useEpilogue()
    triggerExit = useExit()

    // Set epilogue (same as Session route does via createEffect, line 198)
    setEpilogue(sessionEpilogue({ title: "Test Session", sessionID: "ses_test" }))

    // Register cleanup that clears epilogue (same as Session route, line 200)
    onCleanup(() => setEpilogue())

    return <text>test</text>
  }

  const app = await testRender(() => (
    <ExitProvider
      exit={() => {
        // This matches the ExitProvider callback in app.tsx (line 239)
        exit.epilogueSnapshot = exit.epilogue
        rendererRef.current?.destroy()
      }}
    >
      <EpilogueProvider set={(value) => (exit.epilogue = value)}>
        <TestApp />
      </EpilogueProvider>
    </ExitProvider>
  ))

  try {
    rendererRef.current = app.renderer

    // Verify epilogue was set by the component
    expect(exit.epilogue).toContain("Test Session")
    expect(exit.epilogue).toContain("jcode -s ses_test")

    // Trigger exit — same flow as user pressing exit / ExitProvider callback
    triggerExit()

    // Let Solid's unmount + cleanup settle
    await app.renderOnce()

    // The snapshot must preserve the epilogue value
    expect(exit.epilogueSnapshot).toContain("Test Session")
    expect(exit.epilogueSnapshot).toContain("jcode -s ses_test")

    // The original epilogue should be cleared by onCleanup
    expect(exit.epilogue).toBeUndefined()

    // The final read expression (app.tsx line 345) should return the snapshot
    const finalEpilogue = exit.epilogueSnapshot ?? exit.epilogue
    expect(finalEpilogue).toContain("Test Session")
  } finally {
    if (!app.renderer.isDestroyed) app.renderer.destroy()
  }
})

test("snapshot is undefined when no epilogue was set", async () => {
  const exit = {
    epilogue: undefined as string | undefined,
    epilogueSnapshot: undefined as string | undefined,
  }
  const rendererRef = { current: undefined as CliRenderer | undefined }
  let triggerExit!: (reason?: unknown) => void

  function TestApp() {
    triggerExit = useExit()
    // Notably: no epilogue is set, and no onCleanup registered for epilogue
    return <text>test</text>
  }

  const app = await testRender(() => (
    <ExitProvider
      exit={() => {
        exit.epilogueSnapshot = exit.epilogue
        rendererRef.current?.destroy()
      }}
    >
      <EpilogueProvider set={(value) => (exit.epilogue = value)}>
        <TestApp />
      </EpilogueProvider>
    </ExitProvider>
  ))

  try {
    rendererRef.current = app.renderer
    triggerExit()
    await app.renderOnce()

    expect(exit.epilogueSnapshot).toBeUndefined()
    expect(exit.epilogue).toBeUndefined()

    // The final read should be undefined (no epilogue to write)
    const finalEpilogue = exit.epilogueSnapshot ?? exit.epilogue
    expect(finalEpilogue).toBeUndefined()
  } finally {
    if (!app.renderer.isDestroyed) app.renderer.destroy()
  }
})
