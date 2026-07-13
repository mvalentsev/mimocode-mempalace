import { mkdir, readdir } from "node:fs/promises"
import path from "path"
import type { Options } from "./config.ts"
import type { Logger } from "./log.ts"
import type { Miner } from "./mempalace.ts"

type TrajectoryPartLike = {
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
}

type TrajectoryMessageLike = {
  role: "user" | "assistant"
  parts: TrajectoryPartLike[]
  provenance?: unknown
}

export type SessionPostInput = {
  sessionID: string
  agentID: string
  outcome: "completed" | "error" | "cancelled"
  finalText?: string
  assistantMessageID?: string
  trajectory: TrajectoryMessageLike[]
}

const partText = (parts: TrajectoryPartLike[]) =>
  parts
    .filter((p) => p.type === "text" && !p.synthetic && !p.ignored && typeof p.text === "string" && p.text.trim())
    .map((p) => p.text!.trim())
    .join("\n")

/**
 * The last user turn a human actually typed: hook-injected synthetic turns
 * carry `provenance`, and synthetic reminder parts are flagged per-part.
 */
export function extractLastUserText(trajectory: TrajectoryMessageLike[]) {
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const msg = trajectory[i]!
    if (msg.role !== "user" || msg.provenance !== undefined) continue
    const text = partText(msg.parts ?? [])
    if (text) return text
  }
  return undefined
}

/**
 * Two-line Claude-Code-shaped JSONL: the exact transcript form
 * `mempalace mine --mode convos` detects and chunks as an exchange pair.
 */
export function buildExchangeJsonl(user: string, assistant: string) {
  const lines = [
    { type: "user", message: { content: user } },
    { type: "assistant", message: { content: assistant } },
  ]
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
}

const sanitizeId = (raw: string) => raw.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 64) || "x"

export function exchangeFilename(sessionID: string, assistantMessageID: string | undefined) {
  const suffix = assistantMessageID ? sanitizeId(assistantMessageID) : String(Date.now())
  return `session-${sanitizeId(sessionID)}-${suffix}.jsonl`
}

export type Capture = {
  onSessionPost: (input: SessionPostInput) => Promise<void>
  /** Exchange transcripts land here; the miner watches this directory. */
  dir: string
}

export const captureDir = (o: Options) =>
  o.wing === false ? path.join(o.exportsDir, "unsorted") : path.join(o.exportsDir, o.wing)

export function createCapture(o: Options, miner: Miner, log: Logger): Capture {
  const dir = captureDir(o)
  const ready = mkdir(dir, { recursive: true }).then(
    () => true,
    (e) => {
      log(`capture disabled, cannot create ${dir}: ${e}`)
      return false
    },
  )
  // A short-lived session can exit before the debounced mine fires, leaving
  // the newest exchange unmined; sweep leftovers on the next startup.
  ready.then(async (ok) => {
    if (!ok) return
    const leftovers = await readdir(dir).catch(() => [])
    if (leftovers.some((f) => f.endsWith(".jsonl"))) {
      log(`startup: ${leftovers.length} exchange file(s) pending, scheduling mine`)
      miner.schedule()
    }
  })
  return {
    dir,
    onSessionPost: async (input) => {
      if (!o.agents.includes(input.agentID)) {
        log(`skip ${input.sessionID}: agent "${input.agentID}" not in [${o.agents.join(", ")}]`)
        return
      }
      if (input.outcome !== "completed") return
      const assistant = input.finalText?.trim()
      if (!assistant) return
      const user = extractLastUserText(input.trajectory ?? [])
      if (!user) {
        log(`skip ${input.sessionID}: no non-synthetic user turn in trajectory`)
        return
      }
      if (!(await ready)) return
      const file = path.join(dir, exchangeFilename(input.sessionID, input.assistantMessageID))
      await Bun.write(file, buildExchangeJsonl(user, assistant))
      log(`captured ${path.basename(file)} (${user.length}+${assistant.length} chars)`)
      miner.schedule()
    },
  }
}
