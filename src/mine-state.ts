import { readFile, stat } from "node:fs/promises"
import path from "path"

/**
 * When each transcript directory was last filed into the palace, and how many
 * transcripts it held at that point, so a restart only mines what changed.
 * Without it the startup sweep re-runs `mempalace mine` for every directory
 * that still holds a transcript, which on a real palace costs tens of seconds
 * per wing and files nothing.
 */
export type MineEntry = { at: number; files?: number }
export type MineState = Record<string, MineEntry>

const stateFile = (exportsDir: string) => path.join(exportsDir, ".mine-state.json")

export async function readMineState(exportsDir: string): Promise<MineState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile(exportsDir), "utf8")) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const state: MineState = {}
    for (const [dir, value] of Object.entries(parsed as Record<string, unknown>)) {
      // 0.2.1 stored a bare timestamp; such entries keep working, they simply
      // carry no file count until that directory is mined again.
      if (typeof value === "number" && Number.isFinite(value)) state[dir] = { at: value }
      else if (value && typeof value === "object") {
        const { at, files } = value as { at?: unknown; files?: unknown }
        if (typeof at === "number" && Number.isFinite(at)) {
          state[dir] = typeof files === "number" && Number.isFinite(files) ? { at, files } : { at }
        }
      }
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
 * finished, so a transcript written mid-run is swept by the next start - along
 * with the transcript count the next sweep should expect to see.
 * Concurrent sessions read-modify-write the same file; a lost update costs one
 * redundant mine, never a skipped one.
 */
export async function markMined(exportsDir: string, dir: string, at: number, files: number): Promise<void> {
  const state = await readMineState(exportsDir)
  state[dir] = { at, files }
  await Bun.write(stateFile(exportsDir), JSON.stringify(state, null, 2) + "\n")
}

/**
 * Transcripts in `dir` that a mine still owes the palace. Timestamps alone are
 * not enough: a restore from backup (`tar -x`, `cp -p` and `rsync -a` all keep
 * the original mtime) or a clock stepped backwards would hide a file that was
 * never mined, so a changed transcript count, or a stamp from the future,
 * re-sweeps the whole directory.
 */
export async function pendingSince(
  dir: string,
  entry: MineEntry | undefined,
  names: string[],
  now = Date.now(),
): Promise<number> {
  const transcripts = names.filter((name) => name.endsWith(".jsonl"))
  if (!entry || entry.at > now) return transcripts.length
  if (entry.files !== undefined && entry.files !== transcripts.length) return transcripts.length
  let pending = 0
  for (const name of transcripts) {
    const st = await stat(path.join(dir, name)).catch(() => undefined)
    if (!st || st.mtimeMs > entry.at) pending++
  }
  return pending
}
