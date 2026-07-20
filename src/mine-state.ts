import { readFile, stat } from "node:fs/promises"
import path from "path"

/**
 * When each transcript directory was last filed into the palace, so a restart
 * only mines what changed since. Without it the startup sweep re-runs
 * `mempalace mine` for every directory that still holds a transcript, which on
 * a real palace costs tens of seconds per wing and files nothing.
 */
export type MineState = Record<string, number>

const stateFile = (exportsDir: string) => path.join(exportsDir, ".mine-state.json")

export async function readMineState(exportsDir: string): Promise<MineState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile(exportsDir), "utf8")) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const state: MineState = {}
    for (const [dir, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) state[dir] = at
    }
    return state
  } catch {
    // Missing or unreadable state means "nothing is known to be filed", which
    // sweeps everything - the behavior this file exists to make cheaper, never
    // to make wrong.
    return {}
  }
}

/**
 * Record that `dir` is filed as of `at` - the moment the run started, not
 * finished, so a transcript written mid-run is swept by the next start.
 * Concurrent sessions read-modify-write the same file; a lost update costs one
 * redundant mine, never a skipped one.
 */
export async function markMined(exportsDir: string, dir: string, at: number): Promise<void> {
  const state = await readMineState(exportsDir)
  state[dir] = at
  await Bun.write(stateFile(exportsDir), JSON.stringify(state, null, 2) + "\n")
}

/** Transcripts in `dir` written after `since`; these are what a sweep owes the palace. */
export async function pendingSince(dir: string, since: number, names: string[]): Promise<number> {
  let pending = 0
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue
    const st = await stat(path.join(dir, name)).catch(() => undefined)
    if (!st || st.mtimeMs > since) pending++
  }
  return pending
}
