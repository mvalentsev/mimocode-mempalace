import type { Logger } from "./log.ts"
import type { Options } from "./config.ts"

export type RunResult = {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Run the mempalace CLI with a hard timeout. Never throws. */
export async function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  try {
    const proc = Bun.spawn([bin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, timeoutMs)
    const stdoutP = new Response(proc.stdout).text().catch(() => "")
    const stderrP = new Response(proc.stderr).text().catch(() => "")
    const code = await proc.exited
    clearTimeout(timer)
    // A killed process can leave grandchildren holding the pipes open;
    // after a timeout the streams get a short grace read instead of a hang.
    const grace = (p: Promise<string>) => (timedOut ? Promise.race([p, Bun.sleep(300).then(() => "")]) : p)
    const stdout = await grace(stdoutP)
    const stderr = await grace(stderrP)
    return { ok: code === 0 && !timedOut, code, stdout, stderr, timedOut }
  } catch (e) {
    return { ok: false, code: null, stdout: "", stderr: String(e), timedOut: false }
  }
}

/** `--palace` is a global flag and must precede the subcommand. */
export function searchArgs(o: Options, query: string) {
  const args = ["--palace", o.palace, "search", query, "--results", String(o.injectResults)]
  if (o.wing !== false) args.push("--wing", o.wing)
  return args
}

export function mineArgs(o: Options, dir: string) {
  const args = ["--palace", o.palace, "mine", dir, "--mode", "convos"]
  if (o.wing !== false) args.push("--wing", o.wing)
  return args
}

/**
 * Search results arrive as human-oriented text; the model reads it fine as-is.
 * Empty palaces and misses produce no `[1]` marker, which is the "no results" signal.
 */
export function extractResults(stdout: string, maxChars: number) {
  const start = stdout.indexOf("[1]")
  if (start === -1) return ""
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

export type Miner = {
  /** Mark the exports dir dirty; a mine run fires after the debounce window. */
  schedule: () => void
  /** Resolves once every scheduled run has finished (tests and shutdown). */
  flush: () => Promise<void>
}

/**
 * Serialized, coalescing mine queue. Concurrent mine runs against one palace
 * can corrupt its FTS5 index, so runs are chained; schedule() calls landing
 * during a run mark the state dirty and trigger exactly one follow-up run.
 */
export function createMiner(o: Options, dir: string, log: Logger): Miner {
  let chain = Promise.resolve()
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const fire = () => {
    timer = undefined
    if (!dirty) return
    dirty = false
    chain = chain.then(async () => {
      const res = await run(o.bin, mineArgs(o, dir), o.mineTimeoutMs)
      if (!res.ok) log(`mine failed (code=${res.code} timedOut=${res.timedOut}): ${res.stderr.slice(0, 500)}`)
      if (res.ok) log(`mine ok: ${dir}`)
      if (dirty && timer === undefined) timer = setTimeout(fire, o.mineDebounceMs)
    })
  }

  return {
    schedule: () => {
      dirty = true
      if (timer === undefined) timer = setTimeout(fire, o.mineDebounceMs)
    },
    flush: async () => {
      while (timer !== undefined || dirty) {
        if (timer !== undefined) {
          clearTimeout(timer)
          fire()
        }
        await chain
      }
      await chain
    },
  }
}
