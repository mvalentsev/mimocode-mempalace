import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "os"
import path from "path"
import { resolveOptions } from "../src/config.ts"
import { createMiner, extractResults, mineArgs, run, searchArgs } from "../src/mempalace.ts"

const fakeBin = async (body: string) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mm-bin-"))
  const bin = path.join(dir, "fake-mempalace")
  await writeFile(bin, `#!/usr/bin/env bash\n${body}\n`)
  await chmod(bin, 0o755)
  return { dir, bin }
}

describe("run", () => {
  test("captures stdout and exit code", async () => {
    const f = await fakeBin(`echo "hello $1"`)
    const res = await run(f.bin, ["world"], 5000)
    expect(res.ok).toBe(true)
    expect(res.stdout.trim()).toBe("hello world")
  })

  test("kills on timeout", async () => {
    const f = await fakeBin("sleep 30")
    const res = await run(f.bin, [], 150)
    expect(res.ok).toBe(false)
    expect(res.timedOut).toBe(true)
  })

  test("missing binary reports failure without throwing", async () => {
    const res = await run("/nonexistent/mempalace-xyz", ["--version"], 1000)
    expect(res.ok).toBe(false)
  })

  test("a grandchild holding the pipe cannot outlast the timeout", async () => {
    // The child exits at once but leaves a background process on stdout, so
    // the stream never ends on its own.
    const f = await fakeBin(`( sleep 8 ) &\necho hi\nexit 0`)
    const t0 = Date.now()
    await run(f.bin, [], 500)
    // The child's grandchild lives 8s; anything under that proves the read
    // was bounded, with slack for a loaded CI box.
    expect(Date.now() - t0).toBeLessThan(6000)
  })

  test("a child that ignores SIGTERM is still killed", async () => {
    const f = await fakeBin(`trap '' TERM\nsleep 8`)
    const t0 = Date.now()
    const res = await run(f.bin, [], 400)
    expect(Date.now() - t0).toBeLessThan(6000)
    expect(res.timedOut).toBe(true)
    expect(res.ok).toBe(false)
  })
})

describe("args", () => {
  const o = resolveOptions({ palace: "/p/palace", wing: "w1", injectResults: 3 }, "/p/x")
  test("global --palace precedes the subcommand", () => {
    expect(searchArgs(o, "q")).toEqual(["--palace", "/p/palace", "search", "q", "--results", "3", "--wing", "w1"])
    expect(mineArgs(o, "/dir")).toEqual([
      "--palace", "/p/palace", "mine", "/dir", "--mode", "convos", "--agent", "mimocode", "--wing", "w1",
    ])
  })
  test("wing override for foreign-wing runs", () => {
    expect(mineArgs(o, "/dir", "other")).toContain("other")
    expect(mineArgs(o, "/dir", false)).not.toContain("--wing")
  })
  test("wing=false omits the flag", () => {
    const off = resolveOptions({ palace: "/p/palace", wing: false }, "/p/x")
    expect(searchArgs(off, "q")).not.toContain("--wing")
    expect(mineArgs(off, "/dir")).not.toContain("--wing")
  })
})

describe("extractResults", () => {
  const sample = `
============================================================
  Results for: "payments retry"
============================================================

  [1] convos / technical
      Source: session-1.jsonl
      Match:  cosine_sim=0.768  bm25=1.37

      > How do we configure retry?
      In config/payments.yaml.

  ────────────────────────────────────────────────────────
`
  test("drops the banner, keeps results", () => {
    const got = extractResults(sample, 6000)
    expect(got.startsWith("[1]")).toBe(true)
    expect(got).toContain("payments.yaml")
    expect(got).not.toContain("Results for")
    expect(got).not.toContain("═══")
  })
  test("no [1] marker means no results", () => {
    expect(extractResults("  No results found.\n", 6000)).toBe("")
  })
  test("a query echoed back with [1] in it is not mistaken for a result", () => {
    const miss = `
============================================================
  No results found for: "why does worker[1] drop the retry flag?"
============================================================
`
    expect(extractResults(miss, 6000)).toBe("")
  })
  test("results start at the real marker, not at the echoed query", () => {
    const hit = `
============================================================
  Results for: "does worker[1] drop the flag"
============================================================

  [1] gateway / technical
      Source: session-9.jsonl

      > why does worker[1] drop it?
      Because the flag resets on reconnect.
`
    const got = extractResults(hit, 6000)
    expect(got.startsWith("[1] gateway")).toBe(true)
    expect(got).not.toContain("Results for")
  })
  test("truncates on a line boundary", () => {
    const got = extractResults(sample, 60)
    expect(got.endsWith("[truncated]")).toBe(true)
    expect(got.length).toBeLessThan(60 + 20)
  })
})

describe("createMiner", () => {
  test("serializes overlapping runs and coalesces bursts", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-miner-"))
    const journal = path.join(tmp, "journal.txt")
    const f = await fakeBin(
      `echo "start $$" >> ${journal}\nsleep 0.15\necho "end $$" >> ${journal}`,
    )
    const o = resolveOptions(
      { bin: f.bin, palace: "/p", wing: "w", mineDebounceMs: 40, mineTimeoutMs: 5000 },
      "/p/x",
    )
    const miner = createMiner(o, "/exchanges/w", () => {})

    miner.schedule()
    miner.schedule()
    miner.schedule()
    await Bun.sleep(60)
    miner.schedule() // lands while the first run is in flight
    await miner.flush()

    const lines = (await readFile(journal, "utf8")).trim().split("\n")
    const runs = lines.filter((l) => l.startsWith("start")).length
    expect(runs).toBeGreaterThanOrEqual(1)
    expect(runs).toBeLessThanOrEqual(2)
    for (let i = 0; i < lines.length; i += 2) {
      expect(lines[i]!.startsWith("start")).toBe(true)
      expect(lines[i + 1]!.startsWith("end")).toBe(true)
    }
  })
})

describe("searchScope", () => {
  test("palace scope drops the wing filter from search only", () => {
    const o = resolveOptions({ palace: "/p", wing: "w1", searchScope: "palace" }, "/p/x")
    expect(searchArgs(o, "q")).not.toContain("--wing")
    expect(mineArgs(o, "/d")).toContain("--wing")
  })
})

describe("cleanupAfterMine", () => {
  test("mined transcripts are removed after a successful run, later arrivals survive", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mm-clean-"))
    await writeFile(path.join(dir, "session-a.jsonl"), "{}\n")
    const f = await fakeBin("sleep 0.15")
    const o = resolveOptions(
      { bin: f.bin, palace: "/p", wing: "w", cleanupAfterMine: true, mineDebounceMs: 30, mineTimeoutMs: 5000 },
      "/p/x",
    )
    const miner = createMiner(o, dir, () => {})
    miner.schedule()
    await Bun.sleep(80) // mine (sleep 0.15) is now in flight
    // Lands mid-run with no new schedule: the snapshot cleanup must not touch it.
    await writeFile(path.join(dir, "session-b.jsonl"), "{}\n")
    await miner.flush()
    const bAlive = await readFile(path.join(dir, "session-b.jsonl"), "utf8").catch(() => null)
    expect(bAlive).toBe("{}\n")
    const aGone = (await readFile(path.join(dir, "session-a.jsonl"), "utf8").catch(() => null)) === null
    expect(aGone).toBe(true)
  })

  test("failed mine keeps transcripts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mm-clean-"))
    await writeFile(path.join(dir, "session-a.jsonl"), "{}\n")
    const f = await fakeBin("exit 2")
    const o = resolveOptions(
      { bin: f.bin, palace: "/p", wing: "w", cleanupAfterMine: true, mineDebounceMs: 30 },
      "/p/x",
    )
    const miner = createMiner(o, dir, () => {})
    miner.schedule()
    await miner.flush()
    const still = await readFile(path.join(dir, "session-a.jsonl"), "utf8")
    expect(still).toBe("{}\n")
  })
})
