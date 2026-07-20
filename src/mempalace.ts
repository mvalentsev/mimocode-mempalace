import { readdir, unlink } from "node:fs/promises"
import path from "path"
import type { Logger } from "./log.ts"
import type { Options } from "./config.ts"
import { markMined } from "./mine-state.ts"

export type RunResult = {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** How long a finished process gets to have its pipes drained. */
const STREAM_GRACE_MS = 2000
/** How long a SIGTERM gets before the process is killed outright. */
const TERM_GRACE_MS = 300

/**
 * Run the mempalace CLI with a hard timeout. Never throws, and never waits
 * longer than the budget: a child that ignores SIGTERM is killed, and a
 * grandchild holding the pipes open cannot stall the read either. Both of
 * those otherwise hang the caller forever - and every hook awaits this.
 */
export async function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  try {
    const proc = Bun.spawn([bin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    })
    const stdoutP = new Response(proc.stdout).text().catch(() => "")
    const stderrP = new Response(proc.stderr).text().catch(() => "")
    const exited = proc.exited.then(() => true)
    const deadline = <T,>(p: Promise<T>, ms: number, fallback: T) =>
      Promise.race([p, Bun.sleep(ms).then(() => fallback)])

    let timedOut = false
    if (!(await deadline(exited, timeoutMs, false))) {
      timedOut = true
      proc.kill()
      if (!(await deadline(exited, TERM_GRACE_MS, false))) {
        proc.kill("SIGKILL")
        await deadline(exited, TERM_GRACE_MS, false)
      }
    }
    const code = proc.exitCode
    const [stdout, stderr] = await Promise.all([
      deadline(stdoutP, STREAM_GRACE_MS, ""),
      deadline(stderrP, STREAM_GRACE_MS, ""),
    ])
    return { ok: code === 0 && !timedOut, code, stdout, stderr, timedOut }
  } catch (e) {
    return { ok: false, code: null, stdout: "", stderr: String(e), timedOut: false }
  }
}

/** `--palace` is a global flag and must precede the subcommand. */
export function searchArgs(o: Options, query: string) {
  const args = ["--palace", o.palace, "search", query, "--results", String(o.injectResults)]
  if (o.wing !== false && o.searchScope === "wing") args.push("--wing", o.wing)
  return args
}

export function mineArgs(o: Options, dir: string, wing: string | false = o.wing) {
  const args = ["--palace", o.palace, "mine", dir, "--mode", "convos", "--agent", o.mineAgent]
  if (wing !== false) args.push("--wing", wing)
  return args
}

/**
 * Search results arrive as human-oriented text; the model reads it fine as-is.
 * Empty palaces and misses produce no `[1]` marker, which is the "no results" signal.
 */
export function extractResults(stdout: string, maxChars: number) {
  // mempalace echoes the query above its results, so a question containing
  // "[1]" (argv[1], worker[1], a footnote) would otherwise be sliced out of
  // the echo and handed to the model as somebody's past memory. Skip the
  // echoed header, then require the marker to open its own line.
  const header = [...stdout.matchAll(/^.*Results for:.*$/gm)].pop()
  const offset = header?.index !== undefined ? header.index + header[0].length : 0
  const marker = stdout.slice(offset).match(/^([ \t]*)\[1\]/m)
  if (marker?.index === undefined) return ""
  const start = offset + marker.index + marker[1]!.length
  const body = stdout
    .slice(start)
    .replace(/[═─]{4,}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
  if (body.length <= maxChars) return body
  const cut = body.slice(0, maxChars)
  const lastLine = cut.lastIndexOf("\n")
  return (lastLine > 0 ? cut.slice(0, lastLine) : cut) + "\n[truncated]"
}

/** Transcripts a mine run says it handled: filed plus already-filed. */
const accountedFor = (stdout: string) => {
  const processed = stdout.match(/Files processed:\s*(\d+)/)
  const skipped = stdout.match(/Files skipped[^:]*:\s*(\d+)/)
  if (!processed && !skipped) return undefined
  return Number(processed?.[1] ?? 0) + Number(skipped?.[1] ?? 0)
}

export type Miner = {
  /** Mark the exports dir dirty; a mine run fires after the debounce window. */
  schedule: () => void
  /** Chain a mine of another directory (backfill, foreign-wing sweep) into the same serialized queue. */
  enqueue: (dir: string, wing: string | false) => Promise<void>
  /** Resolves once every scheduled run has finished (tests and shutdown). */
  flush: () => Promise<void>
}

/**
 * Serialized, coalescing mine queue: this plugin never has two mine runs in
 * flight against its palace. schedule() calls landing during a run mark the
 * state dirty and trigger exactly one follow-up run.
 */
export function createMiner(o: Options, dir: string, log: Logger): Miner {
  let chain = Promise.resolve()
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const mineRun = async (target: string, wing: string | false) => {
    // Snapshot before the run: files that land while mine is in flight are
    // not covered by it and must survive the cleanup below.
    const before = o.cleanupAfterMine ? await readdir(target).catch(() => [] as string[]) : []
    const startedAt = Date.now()
    const res = await run(o.bin, mineArgs(o, target, wing), o.mineTimeoutMs)
    if (!res.ok) {
      log(`mine failed (code=${res.code} timedOut=${res.timedOut}): ${res.stderr.slice(0, 500)}`)
      return
    }
    log(`mine ok: ${target}`)
    const snapshot = before.filter((f) => f.endsWith(".jsonl"))
    const accounted = accountedFor(res.stdout)
    // Exit 0 does not mean every transcript was filed: mempalace skips files it
    // cannot chunk and still succeeds. Deleting on the exit code alone loses
    // those for good, so cleanup needs the run's own tally to add up.
    if (o.cleanupAfterMine && (accounted === undefined || accounted < snapshot.length)) {
      log(`cleanup skipped: the run accounted for ${accounted ?? "no"} of ${snapshot.length} transcript(s)`)
    } else if (o.cleanupAfterMine) {
      const gone = await Promise.all(
        snapshot
          .map((f) =>
            unlink(path.join(target, f)).then(
              () => 1,
              () => 0,
            ),
          ),
      )
      const count = gone.reduce((a: number, b) => a + b, 0)
      if (count) log(`cleanup: removed ${count} mined transcript(s)`)
    }
    // Filed as of the moment the run started, so the next startup sweep skips
    // this directory until a newer transcript lands in it. The count is taken
    // after cleanup, so it describes the directory the next sweep will find.
    const left = await readdir(target).catch(() => [] as string[])
    await markMined(o.exportsDir, target, startedAt, left.filter((f) => f.endsWith(".jsonl")).length).catch((e) =>
      log(`mine state not saved: ${e}`),
    )
  }

  const fire = () => {
    timer = undefined
    if (!dirty) return
    dirty = false
    chain = chain.then(async () => {
      await mineRun(dir, o.wing)
      if (dirty && timer === undefined) timer = setTimeout(fire, o.mineDebounceMs)
    })
  }

  return {
    schedule: () => {
      dirty = true
      if (timer === undefined) timer = setTimeout(fire, o.mineDebounceMs)
    },
    enqueue: (target, wing) => {
      chain = chain.then(() => mineRun(target, wing))
      return chain
    },
    flush: async () => {
      // A schedule() landing while the last chain was being awaited used to be
      // missed, so shutdown left the newest exchange unmined until the next
      // startup sweep. Re-check after every await, not before the last one.
      let awaited: Promise<void> | undefined
      do {
        if (timer !== undefined) {
          clearTimeout(timer)
          fire()
        }
        awaited = chain
        await awaited
        // `chain` is reassigned by every run queued meanwhile, so awaiting the
        // snapshot proves nothing until it stops moving. Without this a mine
        // scheduled during shutdown was left for the next startup sweep.
      } while (timer !== undefined || dirty || chain !== awaited)
    },
  }
}
