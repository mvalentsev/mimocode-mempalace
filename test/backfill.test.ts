import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "os"
import path from "path"
import { extractSessions, markerPath, runBackfill } from "../src/backfill.ts"
import { resolveOptions } from "../src/config.ts"
import type { Miner } from "../src/mempalace.ts"

const NOW = 2_000_000

const fixtureDb = (file: string) => {
  const db = new Database(file, { create: true })
  db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_created INTEGER NOT NULL)`)
  db.run(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT 'main', time_created INTEGER NOT NULL, data TEXT NOT NULL)`)
  db.run(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)`)

  const addMsg = (sid: string, mid: string, t: number, role: string, text: string, extra: object = {}) => {
    db.run(`INSERT INTO message VALUES (?, ?, 'main', ?, ?)`, [mid, sid, t, JSON.stringify({ role, ...extra })])
    db.run(`INSERT INTO part VALUES (?, ?, ?, ?)`, [`p-${mid}`, mid, t, JSON.stringify({ type: "text", text })])
  }

  db.run(`INSERT INTO session VALUES ('ses_a', NULL, '/home/u/projalpha', 100)`)
  addMsg("ses_a", "am1", 110, "user", "alpha question")
  addMsg("ses_a", "am2", 120, "assistant", "alpha answer")

  db.run(`INSERT INTO session VALUES ('ses_b', NULL, '/home/u/projbeta', 200)`)
  addMsg("ses_b", "bm1", 210, "user", "beta question")
  addMsg("ses_b", "bm2", 220, "assistant", "beta answer")

  // child (subagent) session: never exported
  db.run(`INSERT INTO session VALUES ('ses_child', 'ses_a', '/home/u/projalpha', 130)`)
  addMsg("ses_child", "cm1", 131, "user", "child prompt")
  addMsg("ses_child", "cm2", 132, "assistant", "child reply")

  // provenance-marked user turn and non-text parts: filtered out
  db.run(`INSERT INTO session VALUES ('ses_noise', NULL, '/home/u/projalpha', 300)`)
  addMsg("ses_noise", "nm1", 310, "user", "injected", { provenance: { source: "hook" } })
  db.run(`INSERT INTO message VALUES ('nm2', 'ses_noise', 'main', 320, ?)`, [JSON.stringify({ role: "assistant" })])
  db.run(`INSERT INTO part VALUES ('p-nm2', 'nm2', 320, ?)`, [JSON.stringify({ type: "tool", text: "zzz" })])

  return db
}

const opts = (tmp: string, over: Record<string, unknown> = {}) =>
  resolveOptions(
    { exportsDir: path.join(tmp, "exchanges"), mimoDb: path.join(tmp, "mimo.db"), backfill: true, ...over },
    "/home/u/current",
  )

const setup = async (over: Record<string, unknown> = {}) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-backfill-"))
  const o = opts(tmp, over)
  await mkdir(o.exportsDir, { recursive: true })
  fixtureDb(o.mimoDb).close()
  return { tmp, o }
}

describe("extractSessions", () => {
  test("exports top-level sessions as convos jsonl, per-project wings", async () => {
    const { o } = await setup()
    const db = new Database(o.mimoDb, { readonly: true })
    const r = await extractSessions(db, o, NOW, [])
    db.close()
    expect(r.sessions).toBe(2)
    const byWing = Object.fromEntries(r.exported.map((x) => [path.basename(path.dirname(x.file)), x.body]))
    expect(byWing["projalpha"]).toBe(
      `{"type":"user","message":{"content":"alpha question"}}\n{"type":"assistant","message":{"content":"alpha answer"}}\n`,
    )
    expect(byWing["projbeta"]).toContain("beta answer")
    // ses_child excluded entirely; ses_noise had no usable pair
    expect(r.exported.some((x) => x.body.includes("child"))).toBe(false)
    expect(r.skippedEmpty).toBe(1)
  })

  test("pinned wing keeps everything together; limit counts most recent sessions", async () => {
    // limit=2 covers ses_noise (empty after filtering) and ses_b; ses_a falls outside
    const { o } = await setup({ wing: "pinned", backfill: 2 })
    const db = new Database(o.mimoDb, { readonly: true })
    const r = await extractSessions(db, o, NOW, [])
    db.close()
    expect(r.sessions).toBe(1)
    expect(r.exported[0]!.file).toContain(`${path.sep}pinned${path.sep}`)
    expect(r.exported[0]!.body).toContain("beta")
    expect(r.exported.some((x) => x.body.includes("alpha"))).toBe(false)
  })

  test("already-captured sessions are skipped", async () => {
    const { o } = await setup()
    const db = new Database(o.mimoDb, { readonly: true })
    const r = await extractSessions(db, o, NOW, ["ses_a"])
    db.close()
    expect(r.sessions).toBe(1)
    expect(r.skippedCaptured).toBe(1)
    expect(r.exported[0]!.body).toContain("beta")
  })
})

describe("runBackfill", () => {
  const spy = () => {
    const enqueued: string[] = []
    const miner: Miner = { schedule: () => {}, enqueue: async (d, w) => void enqueued.push(`${path.basename(d)}:${w}`), flush: async () => {} }
    return { miner, enqueued }
  }

  test("writes files, marker, and queues one mine per wing; second run is a no-op", async () => {
    const { o } = await setup()
    const logs: string[] = []
    const s = spy()
    await runBackfill(o, s.miner, (m) => void logs.push(m))
    expect(s.enqueued.sort()).toEqual(["projalpha:projalpha", "projbeta:projbeta"])
    const marker = JSON.parse(await readFile(markerPath(o), "utf8"))
    expect(marker.sessions).toBe(2)
    const alpha = await readdir(path.join(o.exportsDir, "projalpha"))
    expect(alpha).toEqual(["backfill-ses_a.jsonl"])

    const s2 = spy()
    await runBackfill(o, s2.miner, () => {})
    expect(s2.enqueued).toEqual([])
  })

  test("captured session files suppress re-export", async () => {
    const { o } = await setup()
    await mkdir(path.join(o.exportsDir, "projalpha"), { recursive: true })
    await writeFile(path.join(o.exportsDir, "projalpha", "session-ses_a-m9.jsonl"), "{}\n")
    const s = spy()
    await runBackfill(o, s.miner, () => {})
    expect(s.enqueued).toEqual(["projbeta:projbeta"])
  })

  test("missing db logs and stays quiet", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-backfill-"))
    const o = opts(tmp, { mimoDb: path.join(tmp, "nope.db") })
    await mkdir(o.exportsDir, { recursive: true })
    const logs: string[] = []
    const s = spy()
    await runBackfill(o, s.miner, (m) => void logs.push(m))
    expect(s.enqueued).toEqual([])
    expect(logs.join("\n")).toContain("backfill skipped")
  })

  test("unexpected schema logs and does not write the marker", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-backfill-"))
    const o = opts(tmp)
    await mkdir(o.exportsDir, { recursive: true })
    new Database(o.mimoDb, { create: true }).run("CREATE TABLE unrelated (x INTEGER)")
    const logs: string[] = []
    const s = spy()
    await runBackfill(o, s.miner, (m) => void logs.push(m))
    expect(logs.join("\n")).toContain("unexpected schema")
    expect(await readFile(markerPath(o), "utf8").catch(() => null)).toBe(null)
  })
})

describe("extractSessions yields", () => {
  test("does not hold the event loop for the whole scan", async () => {
    const s = await setup()
    // A four-session fixture scans faster than a timer tick, which says nothing
    // either way; give the scan enough sessions to be observable.
    const db = new Database(s.o.mimoDb, { create: true })
    db.run("BEGIN")
    for (let i = 0; i < 120; i++) {
      const sid = `ses_bulk_${i}`
      db.run(`INSERT INTO session VALUES (?, NULL, '/home/u/bulk', ?)`, [sid, 400 + i])
      for (const [mid, role, text] of [
        [`${sid}_u`, "user", "bulk question"],
        [`${sid}_a`, "assistant", "bulk answer"],
      ] as const) {
        db.run(`INSERT INTO message VALUES (?, ?, 'main', ?, ?)`, [mid, sid, 401 + i, JSON.stringify({ role })])
        db.run(`INSERT INTO part VALUES (?, ?, ?, ?)`, [`p-${mid}`, mid, 401 + i, JSON.stringify({ type: "text", text })])
      }
    }
    db.run("COMMIT")
    db.close()

    const reader = new Database(s.o.mimoDb, { readonly: true })
    let ticks = 0
    const iv = setInterval(() => ticks++, 1)
    const r = await extractSessions(reader, s.o, NOW, [])
    clearInterval(iv)
    reader.close()

    expect(r.sessions).toBeGreaterThan(50)
    expect(ticks).toBeGreaterThan(0)
  })
})
