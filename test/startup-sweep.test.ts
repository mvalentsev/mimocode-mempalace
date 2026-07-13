import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "os"
import path from "path"
import { createCapture } from "../src/capture.ts"
import { resolveOptions } from "../src/config.ts"
import type { Miner } from "../src/mempalace.ts"

/** Poll until pred holds; loaded machines make fixed sleeps flaky. */
const until = async (pred: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!pred() && Date.now() - t0 < ms) await Bun.sleep(10)
}

describe("startup sweep", () => {
  test("pending exchange files trigger a mine on startup", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-sweep-"))
    await mkdir(path.join(tmp, "w1"), { recursive: true })
    await writeFile(path.join(tmp, "w1", "session-old-x.jsonl"), "{}\n{}\n")

    const calls: string[] = []
    const miner: Miner = { schedule: () => calls.push("schedule"), enqueue: async (d, w) => void calls.push(`enqueue:${path.basename(d)}:${w}`), flush: async () => {} }
    const o = resolveOptions({ exportsDir: tmp, wing: "w1" }, "/p/x")
    createCapture(o, miner, () => {}, Promise.resolve(true))

    await until(() => calls.length > 0)
    expect(calls).toEqual(["schedule"])
  })

  test("foreign wing subdirectories are queued with their own wing", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-sweep-"))
    await mkdir(path.join(tmp, "w2"), { recursive: true })
    await writeFile(path.join(tmp, "w2", "backfill-old.jsonl"), "{}\n{}\n")

    const calls: string[] = []
    const miner: Miner = { schedule: () => calls.push("schedule"), enqueue: async (d, w) => void calls.push(`enqueue:${path.basename(d)}:${w}`), flush: async () => {} }
    const o = resolveOptions({ exportsDir: tmp, wing: "w1" }, "/p/x")
    createCapture(o, miner, () => {}, Promise.resolve(true))

    await until(() => calls.length > 0)
    expect(calls).toEqual(["enqueue:w2:w2"])
  })

  test("failed availability gate suppresses the sweep entirely", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-sweep-"))
    await mkdir(path.join(tmp, "w1"), { recursive: true })
    await mkdir(path.join(tmp, "w2"), { recursive: true })
    await writeFile(path.join(tmp, "w1", "session-old-x.jsonl"), "{}\n{}\n")
    await writeFile(path.join(tmp, "w2", "backfill-old.jsonl"), "{}\n{}\n")

    const calls: string[] = []
    const miner: Miner = { schedule: () => calls.push("schedule"), enqueue: async (d, w) => void calls.push(`enqueue:${path.basename(d)}:${w}`), flush: async () => {} }
    const o = resolveOptions({ exportsDir: tmp, wing: "w1" }, "/p/x")
    createCapture(o, miner, () => {}, Promise.resolve(false))

    await Bun.sleep(150)
    expect(calls).toEqual([])
  })

  test("clean directory schedules nothing", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-sweep-"))
    const calls: string[] = []
    const miner: Miner = { schedule: () => calls.push("schedule"), enqueue: async (d, w) => void calls.push(`enqueue:${path.basename(d)}:${w}`), flush: async () => {} }
    const o = resolveOptions({ exportsDir: tmp, wing: "w1" }, "/p/x")
    createCapture(o, miner, () => {}, Promise.resolve(true))

    await Bun.sleep(150)
    expect(calls).toEqual([])
  })
})
