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
 * Claude-Code-shaped JSONL, the transcript form `mempalace mine --mode convos`
 * files into the palace. Two lines for an exchange.
 */
export function buildExchangeJsonl(user: string, assistant: string) {
  const lines = [
    { type: "user", message: { content: user } },
    { type: "assistant", message: { content: assistant } },
  ]
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
}

/**
 * "turn" capture: everything from the last human user turn to the end of the
 * trajectory, so intermediate assistant replies between tool calls survive,
 * not just the final answer. Returns undefined when there is no user turn.
 */
export function buildTurnJsonl(trajectory: TrajectoryMessageLike[], finalText: string) {
  let start = -1
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const msg = trajectory[i]!
    if (msg.role === "user" && msg.provenance === undefined && partText(msg.parts ?? [])) {
      start = i
      break
    }
  }
  if (start === -1) return undefined
  const lines: { type: string; message: { content: string } }[] = []
  for (const msg of trajectory.slice(start)) {
    if (msg.provenance !== undefined) continue
    const text = partText(msg.parts ?? [])
    if (!text) continue
    lines.push({ type: msg.role, message: { content: text } })
  }
  const last = lines[lines.length - 1]
  const final = finalText.trim()
  if (final && (!last || last.type !== "assistant" || !last.message.content.includes(final))) {
    lines.push({ type: "assistant", message: { content: final } })
  }
  if (lines.length < 2) return undefined
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
}

export const sanitizeId = (raw: string) => raw.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 64) || "x"

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

export function createCapture(o: Options, miner: Miner, log: Logger, gate: Promise<boolean>): Capture {
  const dir = captureDir(o)
  const ready = mkdir(dir, { recursive: true }).then(
    () => true,
    (e) => {
      log(`capture disabled, cannot create ${dir}: ${e}`)
      return false
    },
  )
  // A short-lived session can exit before the debounced mine fires, leaving
  // the newest exchange unmined; sweep leftovers on the next startup. Other
  // wings' subdirectories (backfill output, sessions from other projects)
  // are swept too — their subdirectory name is their wing. The gate matters:
  // an absent or too-old mempalace must mean no mine runs at all.
  ready.then(async (ok) => {
    if (!ok || !(await gate)) return
    const leftovers = await readdir(dir).catch(() => [])
    if (leftovers.some((f) => f.endsWith(".jsonl"))) {
      log(`startup: ${leftovers.length} exchange file(s) pending, scheduling mine`)
      miner.schedule()
    }
    const siblings = await readdir(o.exportsDir, { withFileTypes: true }).catch(() => [])
    for (const e of siblings) {
      const subdir = path.join(o.exportsDir, e.name)
      if (!e.isDirectory() || subdir === dir) continue
      const files = await readdir(subdir).catch(() => [])
      if (files.some((f) => f.endsWith(".jsonl"))) {
        log(`startup: pending exchanges in foreign wing ${e.name}, queueing mine`)
        void miner.enqueue(subdir, e.name)
      }
    }
  })
  return {
    dir,
    onSessionPost: async (input) => {
      if (!o.agents.includes(input.agentID)) {
        log(`skip ${input.sessionID}: agent "${input.agentID}" not in [${o.agents.join(", ")}]`)
        return
      }
      if (input.outcome !== "completed") {
        log(`skip ${input.sessionID}: outcome=${input.outcome}, only completed turns are saved`)
        return
      }
      const assistant = input.finalText?.trim()
      if (!assistant) return
      const trajectory = input.trajectory ?? []
      const user = extractLastUserText(trajectory)
      if (!user) {
        log(`skip ${input.sessionID}: no non-synthetic user turn in trajectory`)
        return
      }
      const body =
        o.captureMode === "turn"
          ? (buildTurnJsonl(trajectory, assistant) ?? buildExchangeJsonl(user, assistant))
          : buildExchangeJsonl(user, assistant)
      if (!(await ready)) return
      const file = path.join(dir, exchangeFilename(input.sessionID, input.assistantMessageID))
      await Bun.write(file, body)
      log(`captured ${path.basename(file)} (${body.length} chars, mode=${o.captureMode})`)
      miner.schedule()
    },
  }
}
