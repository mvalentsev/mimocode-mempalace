import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises"
import os from "os"
import path from "path"
import { captureDir, createCapture } from "../src/capture.ts"
import { resolveOptions } from "../src/config.ts"
import { createMiner, type Miner } from "../src/mempalace.ts"

/** Poll until pred holds; loaded machines make fixed sleeps flaky. */
const until = async (pred: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!pred() && Date.now() - t0 < ms) await Bun.sleep(10)
}

/** A mempalace stub that succeeds at everything, mine included. */
const fakeBin = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mm-bin-"))
  const bin = path.join(dir, "fake-mempalace")
  await writeFile(bin, `#!/usr/bin/env bash\necho "MemPalace 3.6.0"\n`)
  await chmod(bin, 0o755)
  return bin
}

/** Same stub, except a mine run takes a second; --version stays instant. */
const slowMineBin = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mm-bin-"))
  const bin = path.join(dir, "fake-mempalace")
  await writeFile(
    bin,
    `#!/usr/bin/env bash\ncase "$*" in *" mine "*) sleep 1 ;; *) echo "MemPalace 3.6.0" ;; esac\n`,
  )
  await chmod(bin, 0o755)
  return bin
}

const recorder = () => {
  const calls: string[] = []
  const miner: Miner = {
    schedule: () => calls.push("schedule"),
    enqueue: async (d, w) => void calls.push(`enqueue:${path.basename(d)}:${w}`),
    flush: async () => {},
  }
  return { calls, miner }
}

/** One full plugin start: sweep, then let the real miner drain its queue. */
const startAndDrain = async (o: ReturnType<typeof resolveOptions>) => {
  const miner = createMiner(o, captureDir(o), () => {})
  createCapture(o, miner, () => {}, Promise.resolve(true))
  await Bun.sleep(150)
  await miner.flush()
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

  test("transcripts an earlier run already filed are not mined again", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-sweep-"))
    await mkdir(path.join(tmp, "w1"), { recursive: true })
    await writeFile(path.join(tmp, "w1", "session-old-x.jsonl"), "{}\n{}\n")
    const o = resolveOptions({ exportsDir: tmp, wing: "w1", bin: await fakeBin(), mineDebounceMs: 10 }, "/p/x")

    await startAndDrain(o)

    const { calls, miner } = recorder()
    createCapture(o, miner, () => {}, Promise.resolve(true))
    await Bun.sleep(150)
    expect(calls).toEqual([])
  })

  test("a foreign wing filed by an earlier run is not queued again", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-sweep-"))
    await mkdir(path.join(tmp, "w2"), { recursive: true })
    await writeFile(path.join(tmp, "w2", "backfill-old.jsonl"), "{}\n{}\n")
    const o = resolveOptions({ exportsDir: tmp, wing: "w1", bin: await fakeBin(), mineDebounceMs: 10 }, "/p/x")

    await startAndDrain(o)

    const { calls, miner } = recorder()
    createCapture(o, miner, () => {}, Promise.resolve(true))
    await Bun.sleep(150)
    expect(calls).toEqual([])
  })

  test("a transcript written after the last mine is swept again", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-sweep-"))
    await mkdir(path.join(tmp, "w1"), { recursive: true })
    await writeFile(path.join(tmp, "w1", "session-old-x.jsonl"), "{}\n{}\n")
    const o = resolveOptions({ exportsDir: tmp, wing: "w1", bin: await fakeBin(), mineDebounceMs: 10 }, "/p/x")

    await startAndDrain(o)
    await Bun.sleep(20)
    await writeFile(path.join(tmp, "w1", "session-new-y.jsonl"), "{}\n{}\n")

    const { calls, miner } = recorder()
    createCapture(o, miner, () => {}, Promise.resolve(true))
    await until(() => calls.length > 0)
    expect(calls).toEqual(["schedule"])
  })

  test("a transcript written while a mine is in flight is swept by the next start", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-sweep-"))
    await mkdir(path.join(tmp, "w1"), { recursive: true })
    await writeFile(path.join(tmp, "w1", "session-old-x.jsonl"), "{}\n{}\n")
    // Answers --version instantly, but takes a second to "mine" - long enough
    // to land a transcript in the middle of the run.
    const bin = await slowMineBin()
    const o = resolveOptions({ exportsDir: tmp, wing: "w1", bin, mineDebounceMs: 10 }, "/p/x")

    const miner = createMiner(o, captureDir(o), () => {})
    createCapture(o, miner, () => {}, Promise.resolve(true))
    await Bun.sleep(400)
    await writeFile(path.join(tmp, "w1", "session-midrun-y.jsonl"), "{}\n{}\n")
    await miner.flush()

    const { calls, miner: stub } = recorder()
    createCapture(o, stub, () => {}, Promise.resolve(true))
    await until(() => calls.length > 0)
    expect(calls).toEqual(["schedule"])
  })

  test("a transcript restored with an old timestamp is still swept", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-sweep-"))
    await mkdir(path.join(tmp, "w1"), { recursive: true })
    await writeFile(path.join(tmp, "w1", "session-old-x.jsonl"), "{}\n{}\n")
    const o = resolveOptions({ exportsDir: tmp, wing: "w1", bin: await fakeBin(), mineDebounceMs: 10 }, "/p/x")
    await startAndDrain(o)

    // tar -x, cp -p and rsync -a all restore the original mtime, which can
    // predate the mine that filed the rest of the wing.
    const restored = path.join(tmp, "w1", "session-restored-z.jsonl")
    await writeFile(restored, "{}\n{}\n")
    const longAgo = new Date(Date.now() - 24 * 3600_000)
    await utimes(restored, longAgo, longAgo)

    const { calls, miner } = recorder()
    createCapture(o, miner, () => {}, Promise.resolve(true))
    await until(() => calls.length > 0)
    expect(calls).toEqual(["schedule"])
  })

  test("capture: false keeps the sweep from mining anything", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-sweep-"))
    await mkdir(path.join(tmp, "w1"), { recursive: true })
    await mkdir(path.join(tmp, "w2"), { recursive: true })
    await writeFile(path.join(tmp, "w1", "session-old-x.jsonl"), "{}\n{}\n")
    await writeFile(path.join(tmp, "w2", "backfill-old.jsonl"), "{}\n{}\n")

    const { calls, miner } = recorder()
    const o = resolveOptions({ exportsDir: tmp, wing: "w1", capture: false }, "/p/x")
    createCapture(o, miner, () => {}, Promise.resolve(true))

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
