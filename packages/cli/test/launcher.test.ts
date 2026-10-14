import { expect, test } from "bun:test"
import { chmod, copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

const bin = path.resolve(import.meta.dir, "../bin")

test.skipIf(process.platform === "win32")("CLI aliases forward arguments and exit status through OPENCODE_BIN_PATH", async () => {
  await using directory = await tmpdir()
  const executable = path.join(directory.path, "executable")
  await Bun.write(executable, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2))); process.exit(7)\n')
  await chmod(executable, 0o755)
  for (const command of ["jcode", "opencode", "opencode2"]) {
    const child = Bun.spawn(["node", path.join(bin, `${command}.cjs`), "service", "status", "argument with spaces"], {
      env: { ...process.env, OPENCODE_BIN_PATH: executable },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await new Response(child.stdout).text()).toBe('["service","status","argument with spaces"]\n')
    expect(await child.exited).toBe(7)
  }
})

test.skipIf(process.platform === "win32")("jcode finds a local V2 build and prefers its own cached executable", async () => {
  await using directory = await tmpdir()
  await mkdir(path.join(directory.path, "bin"))
  await Promise.all(
    ["jcode", "opencode", "opencode2"].map((command) =>
      copyFile(path.join(bin, `${command}.cjs`), path.join(directory.path, "bin", `${command}.cjs`)),
    ),
  )
  const executable = path.join(directory.path, "dist", `cli-${process.platform}-${process.arch}`, "bin", "opencode")
  await Bun.write(executable, '#!/usr/bin/env node\nconsole.log("local-build")\n')
  await chmod(executable, 0o755)
  const launch = () =>
    Bun.spawn(["node", path.join(directory.path, "bin/jcode.cjs")], {
      env: { ...process.env, OPENCODE_BIN_PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    })
  const built = launch()
  expect(await new Response(built.stdout).text()).toBe("local-build\n")
  expect(await built.exited).toBe(0)

  const upstreamCached = path.join(directory.path, "bin/.opencode")
  await Bun.write(upstreamCached, '#!/usr/bin/env node\nconsole.log("cached-opencode")\n')
  await chmod(upstreamCached, 0o755)
  for (const command of ["jcode", "opencode", "opencode2"]) {
    const child = Bun.spawn(["node", path.join(directory.path, "bin", `${command}.cjs`)], {
      env: { ...process.env, OPENCODE_BIN_PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await new Response(child.stdout).text()).toBe("cached-opencode\n")
    expect(await child.exited).toBe(0)
  }

  const cached = path.join(directory.path, "bin/.jcode")
  await Bun.write(cached, '#!/usr/bin/env node\nconsole.log("cached-jcode")\n')
  await chmod(cached, 0o755)
  const child = launch()
  expect(await new Response(child.stdout).text()).toBe("cached-jcode\n")
  expect(await child.exited).toBe(0)
})

test.skipIf(process.platform === "win32")("jcode forwards SIGUSR1 to its child", async () => {
  await using directory = await tmpdir()
  const executable = path.join(directory.path, "executable")
  await Bun.write(
    executable,
    '#!/usr/bin/env node\nprocess.on("SIGUSR1", () => { console.log("forwarded"); process.exit(0) }); console.log("ready"); setInterval(() => {}, 1000)\n',
  )
  await chmod(executable, 0o755)
  const child = Bun.spawn(["node", path.join(bin, "jcode.cjs")], {
    env: { ...process.env, OPENCODE_BIN_PATH: executable },
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = child.stdout.getReader()
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n")
    process.kill(child.pid, "SIGUSR1")
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("forwarded\n")
    expect(await child.exited).toBe(0)
  } finally {
    reader.releaseLock()
    child.kill()
  }
})

test.skipIf(process.platform === "win32")("postinstall preserves jcode and opencode aliases for the V2 executable", async () => {
  await using directory = await tmpdir()
  const name = `@opencode/cli-${process.platform}-${process.arch}`
  const executable = path.join(directory.path, "node_modules", name, "bin/opencode")
  await Bun.write(executable, '#!/usr/bin/env node\nconsole.log("fixture-version")\n')
  await chmod(executable, 0o755)
  await Bun.write(path.join(directory.path, "node_modules", name, "package.json"), JSON.stringify({ name, version: "2.0.29" }))
  await Bun.write(
    path.join(directory.path, "package.json"),
    JSON.stringify({
      name: "@opencode/cli",
      bin: { opencode: "bin/opencode.exe", opencode2: "bin/opencode.exe", jcode: "bin/opencode.exe" },
      optionalDependencies: { [name]: "2.0.29" },
    }),
  )
  await copyFile(path.resolve(import.meta.dir, "../script/postinstall.mjs"), path.join(directory.path, "postinstall.mjs"))
  const install = Bun.spawn(["node", path.join(directory.path, "postinstall.mjs")], { stdout: "pipe", stderr: "pipe" })
  expect(await new Response(install.stderr).text()).toBe("")
  expect(await install.exited).toBe(0)
  const installed = Bun.spawn([path.join(directory.path, "bin/opencode.exe"), "--version"], { stdout: "pipe" })
  expect(await new Response(installed.stdout).text()).toBe("fixture-version\n")
  expect(await installed.exited).toBe(0)
})
