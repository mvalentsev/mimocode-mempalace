import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "os"
import path from "path"
import { createCapture } from "../src/capture.ts"
import { resolveOptions } from "../src/config.ts"
import type { Miner } from "../src/mempalace.ts"

describe("startup sweep", () => {
  test("pending exchange files trigger a mine on startup", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-sweep-"))
    await mkdir(path.join(tmp, "w1"), { recursive: true })
    await writeFile(path.join(tmp, "w1", "session-old-x.jsonl"), "{}\n{}\n")

    const calls: string[] = []
    const miner: Miner = { schedule: () => calls.push("schedule"), flush: async () => {} }
    const o = resolveOptions({ exportsDir: tmp, wing: "w1" }, "/p/x")
    createCapture(o, miner, () => {})

    await Bun.sleep(50)
    expect(calls).toEqual(["schedule"])
  })

  test("clean directory schedules nothing", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-sweep-"))
    const calls: string[] = []
    const miner: Miner = { schedule: () => calls.push("schedule"), flush: async () => {} }
    const o = resolveOptions({ exportsDir: tmp, wing: "w1" }, "/p/x")
    createCapture(o, miner, () => {})

    await Bun.sleep(50)
    expect(calls).toEqual([])
  })
})
