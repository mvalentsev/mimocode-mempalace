import { lstat } from "node:fs/promises"
import path from "path"
import type { Plugin } from "@mimo-ai/plugin"
import { resolveOptions } from "./config.ts"
import { createLogger } from "./log.ts"
import { createMiner, run } from "./mempalace.ts"
import { captureDir, createCapture, type SessionPostInput } from "./capture.ts"
import { createInjector } from "./inject.ts"
import { runBackfill } from "./backfill.ts"

/** Anything older is refused: the plugin logs `plugin disabled` and stays inert. */
const MIN_MEMPALACE = [3, 3, 5] as const

const versionAtLeast = (reported: string, min: readonly [number, number, number]) => {
  const m = reported.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return false
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < 3; i++) {
    if (parts[i]! > min[i]!) return true
    if (parts[i]! < min[i]!) return false
  }
  return true
}

export const server: Plugin = async (input, options) => {
  const o = resolveOptions(options as Record<string, unknown> | undefined, input.directory)
  const log = createLogger(o.log)

  const available = run(o.bin, ["--version"], 10_000).then((res) => {
    if (!res.ok) {
      log(`mempalace unavailable (${o.bin}): ${(res.stderr || res.stdout).slice(0, 200)}; plugin is a no-op`)
      return false
    }
    const version = (res.stdout || res.stderr).trim()
    if (!versionAtLeast(version, MIN_MEMPALACE)) {
      log(`plugin disabled: ${version} is older than 3.3.5; upgrade mempalace`)
      return false
    }
    log(`ready: ${version}, palace=${o.palace}, wing=${o.wing === false ? "(off)" : o.wing}`)
    // ChromaDB keeps vectors in segment folders next to the real database file,
    // so a palace assembled around a symlinked chroma.sqlite3 has documents but
    // no vectors and searches fail with "Error finding id".
    void lstat(path.join(o.palace, "chroma.sqlite3"))
      .then((st) => {
        if (st.isSymbolicLink()) {
          log(
            `palace warning: chroma.sqlite3 in ${o.palace} is a symlink; the palace is the whole directory, searches here fail with "Error finding id" - use one real palace directory`,
          )
        }
      })
      .catch(() => {})
    return true
  })

  const miner = createMiner(o, captureDir(o), log)
  const capture = createCapture(o, miner, log, available)
  const injector = createInjector(o, log)

  if (o.capture && o.backfill !== false) {
    void available.then((ok) => {
      if (!ok) return
      return runBackfill(o, miner, log).catch((e) => log(`backfill error: ${e}`))
    })
  }

  return {
    "chat.message": async (hookInput, output) => {
      if (!o.inject) return
      try {
        injector.onChatMessage(hookInput.sessionID, output)
      } catch (e) {
        log(`chat.message hook error: ${e}`)
      }
    },
    "experimental.chat.system.transform": async (hookInput, output) => {
      if (!o.inject) return
      if (!(await available)) return
      try {
        await injector.onSystemTransform(hookInput.sessionID, output)
      } catch (e) {
        log(`system.transform hook error: ${e}`)
      }
    },
    "session.post": async (hookInput) => {
      if (!o.capture) return
      if (!(await available)) return
      try {
        await capture.onSessionPost(hookInput as SessionPostInput)
      } catch (e) {
        log(`session.post hook error: ${e}`)
      }
    },
  }
}

export default { id: "mimocode-mempalace", server }
