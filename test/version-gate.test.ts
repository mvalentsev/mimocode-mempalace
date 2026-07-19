import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "os"
import path from "path"
import type { PluginInput } from "@mimo-ai/plugin"
import plugin from "../src/index.ts"

const fakeBin = async (version: string) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mm-bin-"))
  const bin = path.join(dir, "fake-mempalace")
  await writeFile(bin, `#!/usr/bin/env bash\necho "MemPalace ${version}"\n`)
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

  test("the minimum itself is accepted and captures", async () => {
    const { log, written } = await startAndCapture("3.6.0", "ready:")
    expect(log).toContain("ready: MemPalace 3.6.0")
    expect(log).not.toContain("plugin disabled")
    expect(written).toEqual(["session-ses_gate-msg_a1.jsonl"])
  })
})
