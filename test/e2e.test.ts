import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir } from "node:fs/promises"
import os from "os"
import path from "path"
import type { PluginInput } from "@mimo-ai/plugin"
import plugin from "../src/index.ts"
import { run } from "../src/mempalace.ts"

/**
 * Full-cycle test against a real mempalace install: a turn captured in one
 * session is mined into a throwaway palace and comes back through system
 * prompt injection in a later session. Skipped when mempalace is not on PATH.
 */
const probe = await run("mempalace", ["--version"], 10_000)
const FACT = "The staging gateway listens on port 8443, set in deploy/gateway.toml under listen.port."

describe.skipIf(!probe.ok)("e2e against real mempalace", () => {
  test(
    "capture, mine, and recall across sessions",
    async () => {
      const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-e2e-"))
      const palace = path.join(tmp, "palace")
      await mkdir(palace, { recursive: true })
      const init = await run("mempalace", ["init", palace, "--yes", "--auto-mine"], 60_000)
      expect(init.ok).toBe(true)

      const hooks = await plugin.server(
        { directory: "/home/u/projects/gateway" } as unknown as PluginInput,
        {
          palace,
          exportsDir: path.join(tmp, "exchanges"),
          mineDebounceMs: 100,
          identityFile: false,
          searchTimeoutMs: 30_000,
        },
      )

      await hooks["session.post"]!(
        {
          sessionID: "ses_one",
          agentID: "main",
          task_id: undefined,
          outcome: "completed" as const,
          error: undefined,
          finalText: FACT,
          assistantMessageID: "msg_a1",
          trajectory: [
            {
              role: "user" as const,
              id: "msg_u1",
              agent: "main",
              created: 0,
              parts: [{ type: "text", text: "Which port does the staging gateway listen on?" }],
            },
          ],
        },
        {},
      )

      const exchanges = await readdir(path.join(tmp, "exchanges", "gateway"))
      expect(exchanges).toEqual(["session-ses_one-msg_a1.jsonl"])

      // The miner debounces and then shells out; poll the palace until the
      // exchange is searchable (the first mine also warms the embedder).
      const searchable = async () => {
        const res = await run(
          "mempalace",
          ["--palace", palace, "search", "staging gateway port", "--wing", "gateway"],
          30_000,
        )
        return res.ok && res.stdout.includes("8443")
      }
      const deadline = Date.now() + 90_000
      while (!(await searchable())) {
        if (Date.now() > deadline) throw new Error("mined exchange never became searchable")
        await Bun.sleep(2000)
      }

      const out = { system: [] as string[] }
      await hooks["chat.message"]!(
        { sessionID: "ses_two" },
        {
          message: {} as never,
          parts: [{ type: "text", text: "remind me which port the staging gateway uses" }] as never,
        },
      )
      await hooks["experimental.chat.system.transform"]!({ sessionID: "ses_two", model: {} as never }, out)

      expect(out.system).toHaveLength(1)
      expect(out.system[0]).toContain("Long-term memory (MemPalace)")
      expect(out.system[0]).toContain("8443")
    },
    180_000,
  )
})
