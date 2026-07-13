import { Database } from "bun:sqlite"
import { mkdir, readdir, stat } from "node:fs/promises"
import path from "path"
import { slugifyWing, type Options } from "./config.ts"
import type { Logger } from "./log.ts"
import type { Miner } from "./mempalace.ts"
import { sanitizeId } from "./capture.ts"

/** One-shot marker; backfill never runs twice against the same exports dir. */
export const markerPath = (o: Options) => path.join(o.exportsDir, ".backfill-done.json")

type SessionRow = { id: string; directory: string }
type MessageRow = { mid: string; mdata: string; pdata: string }

type Exported = { wing: string | false; file: string; body: string }

/**
 * Read past top-level MiMoCode sessions straight out of its SQLite database
 * (read-only; MiMoCode keeps it in WAL mode, so a live instance is fine) and
 * turn each into one convos-mode transcript. Sessions the plugin has already
 * captured exchanges for are skipped rather than half-deduplicated.
 */
export function extractSessions(
  db: Database,
  o: Options,
  before: number,
  capturedSessionPrefixes: string[],
): { exported: Exported[]; sessions: number; skippedCaptured: number; skippedEmpty: number } {
  const limit = typeof o.backfill === "number" ? o.backfill : -1
  const sessions = db
    .query<SessionRow, [number]>(
      `SELECT id, directory FROM session
       WHERE parent_id IS NULL AND time_created < ?1
       ORDER BY time_created DESC ${limit > 0 ? `LIMIT ${limit}` : ""}`,
    )
    .all(before)
    .reverse()

  const agentPlaceholders = o.agents.map(() => "?").join(", ")
  const msgQuery = db.query<MessageRow, (string | number)[]>(
    `SELECT m.id as mid, m.data as mdata, p.data as pdata
     FROM message m JOIN part p ON p.message_id = m.id
     WHERE m.session_id = ? AND m.agent_id IN (${agentPlaceholders}) AND m.time_created < ?
     ORDER BY m.time_created, p.time_created`,
  )

  const exported: Exported[] = []
  let skippedCaptured = 0
  let skippedEmpty = 0

  for (const s of sessions) {
    const sid = sanitizeId(s.id)
    if (capturedSessionPrefixes.some((p) => p === sid)) {
      skippedCaptured++
      continue
    }
    const rows = msgQuery.all(s.id, ...o.agents, before)
    const lines: { type: string; message: { content: string } }[] = []
    let currentMid = ""
    let role = ""
    let texts: string[] = []
    const flushMsg = () => {
      const content = texts.join("\n").trim()
      if ((role === "user" || role === "assistant") && content) {
        lines.push({ type: role, message: { content } })
      }
      texts = []
    }
    for (const r of rows) {
      if (r.mid !== currentMid) {
        flushMsg()
        currentMid = r.mid
        let meta: { role?: string; provenance?: unknown } = {}
        try {
          meta = JSON.parse(r.mdata)
        } catch {}
        role = meta.provenance !== undefined ? "" : (meta.role ?? "")
      }
      if (!role) continue
      let part: { type?: string; text?: string; synthetic?: boolean; ignored?: boolean } = {}
      try {
        part = JSON.parse(r.pdata)
      } catch {}
      if (part.type === "text" && !part.synthetic && !part.ignored && typeof part.text === "string" && part.text.trim()) {
        texts.push(part.text.trim())
      }
    }
    flushMsg()
    if (lines.length < 2 || !lines.some((l) => l.type === "user")) {
      skippedEmpty++
      continue
    }
    const wing: string | false =
      o.wing === false ? false : o.wingAuto ? slugifyWing(path.basename(s.directory || "") || "unsorted") : o.wing
    const dirName = wing === false ? "unsorted" : wing
    exported.push({
      wing,
      file: path.join(o.exportsDir, dirName, `backfill-${sid}.jsonl`),
      body: lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    })
  }
  return { exported, sessions: exported.length, skippedCaptured, skippedEmpty }
}

/** Session ids (sanitized) that already have plugin-captured exchange files. */
async function capturedSessionIds(exportsDir: string): Promise<string[]> {
  const ids = new Set<string>()
  const entries = await readdir(exportsDir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const files = await readdir(path.join(exportsDir, e.name)).catch(() => [])
    for (const f of files) {
      const m = f.match(/^session-(.+)-[^-]+\.jsonl$/)
      if (m) ids.add(m[1]!)
    }
  }
  return [...ids]
}

export async function runBackfill(o: Options, miner: Miner, log: Logger): Promise<void> {
  if (o.backfill === false) return
  if (await stat(markerPath(o)).then(() => true, () => false)) return

  let db: Database
  try {
    db = new Database(o.mimoDb, { readonly: true })
  } catch (e) {
    log(`backfill skipped: cannot open ${o.mimoDb}: ${e}`)
    return
  }
  let result: ReturnType<typeof extractSessions>
  try {
    result = extractSessions(db, o, Date.now(), await capturedSessionIds(o.exportsDir))
  } catch (e) {
    log(`backfill skipped: ${o.mimoDb} has an unexpected schema: ${e}`)
    return
  } finally {
    db.close()
  }

  const wings = new Map<string, string | false>()
  for (const x of result.exported) {
    const dir = path.dirname(x.file)
    await mkdir(dir, { recursive: true })
    await Bun.write(x.file, x.body)
    wings.set(dir, x.wing)
  }
  await Bun.write(
    markerPath(o),
    JSON.stringify({ finishedAt: new Date().toISOString(), ...result, exported: result.exported.length }) + "\n",
  )
  log(
    `backfill: exported ${result.sessions} session(s) into ${wings.size} wing(s)` +
      ` (skipped: ${result.skippedCaptured} already captured, ${result.skippedEmpty} empty)`,
  )
  for (const [dir, wing] of wings) await miner.enqueue(dir, wing)
  if (wings.size) log("backfill: mining queued/done")
}
