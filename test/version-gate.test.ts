import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "os"
import path from "path"
import type { PluginInput } from "@mimo-ai/plugin"
import plugin from "../src/index.ts"

const fakeBin = async (version: string) => rawBin(`echo "MemPalace ${version}"`)

/** A stub whose --version output is whatever the script prints, warts and all. */
const rawBin = async (script: string) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mm-bin-"))
  const bin = path.join(dir, "fake-mempalace")
  await writeFile(bin, `#!/usr/bin/env bash\n${script}\n`)
  await chmod(bin, 0o755)
  return bin
}

const turn = {
  sessionID: "ses_gate",
  agentID: "main",
  outcome: "completed" as const,
  finalText: "The gateway listens on 8443.",
  assistantMessageID: "msg_a1",
  trajectory: [
    {
      role: "user" as const,
      id: "msg_u1",
      agent: "main",
      created: 0,
      parts: [{ type: "text", text: "Which port?" }],
    },
  ],
}

/** Just the gate: boot against `bin` and return the first verdict it logs. */
const verdict = async (bin: string) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-gate-"))
  const logPath = path.join(tmp, "plugin.log")
  await plugin.server({ directory: path.join(tmp, "proj") } as unknown as PluginInput, {
    palace: path.join(tmp, "palace"),
    bin,
    exportsDir: path.join(tmp, "exchanges"),
    identityFile: false,
    capture: false,
    log: logPath,
  })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const text = await readFile(logPath, "utf8").catch(() => "")
    if (text.includes("ready:")) return "ready"
    if (text.includes("plugin disabled")) return "disabled"
    await Bun.sleep(50)
  }
  return "(nothing logged)"
}

/** Boot the plugin against a mempalace of `version` and run one completed turn. */
const startAndCapture = async (version: string, marker: string) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-gate-"))
  const logPath = path.join(tmp, "plugin.log")
  const exportsDir = path.join(tmp, "exchanges")
  const hooks = await plugin.server({ directory: path.join(tmp, "proj") } as unknown as PluginInput, {
    palace: path.join(tmp, "palace"),
    bin: await fakeBin(version),
    exportsDir,
    identityFile: false,
    mineDebounceMs: 10_000,
    log: logPath,
  })

  const read = () => readFile(logPath, "utf8").catch(() => "")
  const deadline = Date.now() + 5000
  let log = ""
  while (Date.now() < deadline) {
    log = await read()
    if (log.includes(marker)) break
    await Bun.sleep(50)
  }

  await hooks["session.post"]!(turn, {})
  // The wing directory is created on startup either way; what the gate decides
  // is whether a transcript is ever written into it.
  const written = (await readdir(path.join(exportsDir, "proj")).catch(() => [] as string[])).filter((f) =>
    f.endsWith(".jsonl"),
  )
  return { log: await read(), written }
}

describe("mempalace version gate", () => {
  test("a mempalace below the minimum disables capture", async () => {
    const { log, written } = await startAndCapture("3.5.0", "plugin disabled")
    expect(log).toContain("plugin disabled: MemPalace 3.5.0 is older than 3.6.0; upgrade mempalace")
    expect(log).not.toContain("ready:")
    expect(written).toEqual([])
  })

  test("a version with a two-digit minor is newer, not older", async () => {
    expect(await verdict(await fakeBin("3.10.0"))).toBe("ready")
  })

  test("a warning printed before the version does not fool the gate", async () => {
    const bin = await rawBin(`echo "A NumPy version >=1.22.4 is required"\necho "MemPalace 3.6.0"`)
    expect(await verdict(bin)).toBe("ready")
  })

  test("a version below the minimum is refused however noisy the output", async () => {
    const bin = await rawBin(`echo "Python 3.11.9"\necho "MemPalace 3.5.0"`)
    expect(await verdict(bin)).toBe("disabled")
  })

  test("the minimum itself is accepted and captures", async () => {
    const { log, written } = await startAndCapture("3.6.0", "ready:")
    expect(log).toContain("ready: MemPalace 3.6.0")
    expect(log).not.toContain("plugin disabled")
    expect(written).toEqual(["session-ses_gate-msg_a1.jsonl"])
  })
})
