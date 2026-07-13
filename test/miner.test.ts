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
})

describe("args", () => {
  const o = resolveOptions({ palace: "/p/palace", wing: "w1", injectResults: 3 }, "/p/x")
  test("global --palace precedes the subcommand", () => {
    expect(searchArgs(o, "q")).toEqual(["--palace", "/p/palace", "search", "q", "--results", "3", "--wing", "w1"])
    expect(mineArgs(o, "/dir")).toEqual(["--palace", "/p/palace", "mine", "/dir", "--mode", "convos", "--wing", "w1"])
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
