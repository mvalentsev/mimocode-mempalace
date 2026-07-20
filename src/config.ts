import os from "os"
import path from "path"

export type Options = {
  /** Palace directory. Created by `mempalace init <dir>` before first use. */
  palace: string
  /** mempalace executable (name on PATH or absolute path). */
  bin: string
  /** Wing for captured exchanges: "auto" scopes by project directory name, a string pins one wing, false disables wing scoping. */
  wing: string | false
  /** True when wing came from "auto": backfill then scopes each session by its own project directory. */
  wingAuto: boolean
  /** Search scope for injection: "wing" stays inside the project wing, "palace" searches everything. */
  searchScope: "wing" | "palace"
  /** "exchange" saves question + final answer; "turn" also keeps intermediate assistant replies of the turn. */
  captureMode: "exchange" | "turn"
  /** Delete exchange transcripts after they are mined successfully. */
  cleanupAfterMine: boolean
  /** Save completed turns into the palace. */
  capture: boolean
  /** Inject relevant memories into the system prompt. */
  inject: boolean
  /** Markdown file prepended to every injected memory block. */
  identityFile: string | false
  /** Number of search results requested per injection. */
  injectResults: number
  /** Hard cap on injected block size, characters. */
  injectMaxChars: number
  /** Kill a search that runs longer than this. */
  searchTimeoutMs: number
  /** Quiet window before captured exchanges are mined in one batch. */
  mineDebounceMs: number
  /** Kill a mine run that runs longer than this. */
  mineTimeoutMs: number
  /** Agent name recorded on every mined drawer (`mempalace mine --agent`). */
  mineAgent: string
  /** Import past MiMoCode sessions from its SQLite db once: false, true (all), or the N most recent sessions. */
  backfill: boolean | number
  /** MiMoCode SQLite database backfill reads from. */
  mimoDb: string
  /** Where captured exchange transcripts are written. */
  exportsDir: string
  /** Agent slices to capture; the top-level loop is "main". */
  agents: string[]
  /** false: silent, true: default log file, string: custom log file path. */
  log: boolean | string
}

const dataHome = () => process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")

export const defaultDataDir = () => path.join(dataHome(), "mimocode-mempalace")

export const defaultMimoDb = () => path.join(dataHome(), "mimocode", "mimocode.db")

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p)

const str = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? expandHome(v.trim()) : fallback)

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback)

const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback)

/** FNV-1a, base36: enough to tell two names apart, short enough to read. */
const digest = (raw: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/**
 * Wing names stay within mempalace slug conventions: lowercase, [a-z0-9_-].
 * Names that leave nothing behind - Cyrillic, CJK, emoji - used to land in the
 * shared `unsorted` wing together, which mixed unrelated projects' memories
 * into each other's prompts; they get a digest of their own name instead.
 */
export function slugifyWing(raw: string) {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (slug) return slug
  // Nothing survived. A name that still carries letters or digits is a real
  // project name in another script, so it earns a wing of its own; a name that
  // was only separators has nothing to tell apart and stays in the bucket.
  return /[\p{L}\p{N}]/u.test(raw) ? `w-${digest(raw)}` : "unsorted"
}

export function resolveOptions(raw: Record<string, unknown> | undefined, projectDir: string): Options {
  const o = raw ?? {}
  const wingAuto = o.wing !== false && !(typeof o.wing === "string" && o.wing.trim() && o.wing !== "auto")
  const wing = (() => {
    if (o.wing === false) return false as const
    if (!wingAuto) return slugifyWing(o.wing as string)
    return slugifyWing(path.basename(projectDir || "") || "unsorted")
  })()
  const identityFile = (() => {
    if (o.identityFile === false) return false as const
    return str(o.identityFile, path.join(defaultDataDir(), "identity.md"))
  })()
  const log = (() => {
    if (typeof o.log === "string" && o.log.trim()) return expandHome(o.log.trim())
    // On by default: every failure this plugin can hit is invisible otherwise,
    // and "no memories appeared and nothing says why" is the worst way to meet
    // a bug. `false` still turns it off.
    return bool(o.log, true)
  })()
  return {
    palace: str(o.palace, path.join(defaultDataDir(), "palace")),
    bin: str(o.bin, "mempalace"),
    wing,
    wingAuto,
    searchScope: o.searchScope === "palace" ? "palace" : "wing",
    captureMode: o.captureMode === "turn" ? "turn" : "exchange",
    cleanupAfterMine: bool(o.cleanupAfterMine, false),
    capture: bool(o.capture, true),
    inject: bool(o.inject, true),
    identityFile,
    injectResults: num(o.injectResults, 5),
    injectMaxChars: num(o.injectMaxChars, 6000),
    searchTimeoutMs: num(o.searchTimeoutMs, 10000),
    mineDebounceMs: num(o.mineDebounceMs, 3000),
    mineTimeoutMs: num(o.mineTimeoutMs, 120000),
    mineAgent: str(o.mineAgent, "mimocode"),
    backfill: typeof o.backfill === "number" && Number.isFinite(o.backfill) && o.backfill > 0
      ? Math.floor(o.backfill)
      : o.backfill === true,
    mimoDb: str(o.mimoDb, defaultMimoDb()),
    exportsDir: str(o.exportsDir, path.join(defaultDataDir(), "exchanges")),
    agents: Array.isArray(o.agents) && o.agents.every((a) => typeof a === "string") ? (o.agents as string[]) : ["main"],
    log,
  }
}
