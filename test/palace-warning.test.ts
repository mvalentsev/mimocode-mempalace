import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import os from "os"
import path from "path"
import type { PluginInput } from "@mimo-ai/plugin"
import plugin from "../src/index.ts"

const fakeBin = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mm-bin-"))
  const bin = path.join(dir, "fake-mempalace")
  await writeFile(bin, `#!/usr/bin/env bash\necho "MemPalace 3.5.0"\n`)
  await chmod(bin, 0o755)
  return bin
}

const startAndWait = async (palace: string, marker: string) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-warn-"))
  const logPath = path.join(tmp, "plugin.log")
  await plugin.server({ directory: path.join(tmp, "proj") } as unknown as PluginInput, {
    palace,
    bin: await fakeBin(),
    exportsDir: path.join(tmp, "exchanges"),
    identityFile: false,
    log: logPath,
  })
  const read = () => readFile(logPath, "utf8").catch(() => "")
  const deadline = Date.now() + 5000
  let text = ""
  while (Date.now() < deadline) {
    text = await read()
    if (text.includes(marker)) break
    await Bun.sleep(50)
  }
  // The warning lands a tick after ready; settle before the final read.
  await Bun.sleep(200)
  return read()
}

describe("palace symlink warning", () => {
  test("symlinked chroma.sqlite3 is called out", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-pal-"))
    const palace = path.join(tmp, "palace")
    await mkdir(palace, { recursive: true })
    const real = path.join(tmp, "real-chroma.sqlite3")
    await writeFile(real, "not a real db")
    await symlink(real, path.join(palace, "chroma.sqlite3"))

    const log = await startAndWait(palace, "palace warning")
    expect(log).toContain("ready: MemPalace 3.5.0")
    expect(log).toContain("palace warning: chroma.sqlite3")
    expect(log).toContain("Error finding id")
  })

  test("a regular chroma.sqlite3 stays quiet", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-pal-"))
    const palace = path.join(tmp, "palace")
    await mkdir(palace, { recursive: true })
    await writeFile(path.join(palace, "chroma.sqlite3"), "not a real db")

    const log = await startAndWait(palace, "ready:")
    expect(log).toContain("ready: MemPalace 3.5.0")
    expect(log).not.toContain("palace warning")
  })

  test("a fresh palace without chroma.sqlite3 stays quiet", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-pal-"))
    const palace = path.join(tmp, "palace")
    await mkdir(palace, { recursive: true })

    const log = await startAndWait(palace, "ready:")
    expect(log).toContain("ready: MemPalace 3.5.0")
    expect(log).not.toContain("palace warning")
  })
})
