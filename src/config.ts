import os from "os"
import path from "path"

export type Options = {
  /** Palace directory. Created by `mempalace init <dir>` before first use. */
  palace: string
  /** mempalace executable (name on PATH or absolute path). */
  bin: string
  /** Wing for captured exchanges: "auto" scopes by project directory name, a string pins one wing, false disables wing scoping. */
  wing: string | false
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
  /** Where captured exchange transcripts are written. */
  exportsDir: string
  /** Agent slices to capture; the top-level loop is "main". */
  agents: string[]
  /** false: silent, true: default log file, string: custom log file path. */
  log: boolean | string
}

const dataHome = () => process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")

export const defaultDataDir = () => path.join(dataHome(), "mimocode-mempalace")

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p)

const str = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? expandHome(v.trim()) : fallback)

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback)

const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback)

/** Wing names stay within mempalace slug conventions: lowercase, [a-z0-9_-]. */
export function slugifyWing(raw: string) {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "unsorted"
}

export function resolveOptions(raw: Record<string, unknown> | undefined, projectDir: string): Options {
  const o = raw ?? {}
  const wing = (() => {
    if (o.wing === false) return false as const
    if (typeof o.wing === "string" && o.wing.trim() && o.wing !== "auto") return slugifyWing(o.wing)
    return slugifyWing(path.basename(projectDir || "") || "unsorted")
  })()
  const identityFile = (() => {
    if (o.identityFile === false) return false as const
    return str(o.identityFile, path.join(defaultDataDir(), "identity.md"))
  })()
  const log = (() => {
    if (typeof o.log === "string" && o.log.trim()) return expandHome(o.log.trim())
    return bool(o.log, false)
  })()
  return {
    palace: str(o.palace, path.join(defaultDataDir(), "palace")),
    bin: str(o.bin, "mempalace"),
    wing,
    capture: bool(o.capture, true),
    inject: bool(o.inject, true),
    identityFile,
    injectResults: num(o.injectResults, 5),
    injectMaxChars: num(o.injectMaxChars, 6000),
    searchTimeoutMs: num(o.searchTimeoutMs, 10000),
    mineDebounceMs: num(o.mineDebounceMs, 3000),
    mineTimeoutMs: num(o.mineTimeoutMs, 120000),
    exportsDir: str(o.exportsDir, path.join(defaultDataDir(), "exchanges")),
    agents: Array.isArray(o.agents) && o.agents.every((a) => typeof a === "string") ? (o.agents as string[]) : ["main"],
    log,
  }
}
