import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import os from "os"
import path from "path"
import { resolveOptions } from "../src/config.ts"
import { createInjector } from "../src/inject.ts"

const RESULT = `Results for: "q"
====
  [1] convos / technical
      The retry config lives in payments.yaml.
`

const fakeSearchBin = async (body: string) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mm-inj-"))
  const bin = path.join(dir, "fake-mempalace")
  await writeFile(bin, `#!/usr/bin/env bash\n${body}\n`)
  await chmod(bin, 0o755)
  return { dir, bin }
}

const userMessage = (text: string) => ({ parts: [{ type: "text", text }] })

describe("createInjector", () => {
  test("injects identity plus search results into system", async () => {
    const f = await fakeSearchBin(`cat <<'EOF'\n${RESULT}\nEOF`)
    const identity = path.join(f.dir, "identity.md")
    await writeFile(identity, "I work on the payments service.")
    const o = resolveOptions({ bin: f.bin, identityFile: identity, wing: "w" }, "/p/x")
    const inj = createInjector(o, () => {})

    inj.onChatMessage({ sessionID: "s1" }, userMessage("how is retry configured?"))
    const out = { system: [] as string[] }
    await inj.onSystemTransform("s1", out)

    expect(out.system).toHaveLength(1)
    expect(out.system[0]).toContain("# Long-term memory (MemPalace)")
    expect(out.system[0]).toContain("payments service")
    expect(out.system[0]).toContain("payments.yaml")
    expect(out.system[0]).not.toContain("Results for")
  })

  test("no user text yet: identity only; no identity: nothing", async () => {
    const f = await fakeSearchBin(`echo nothing`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const inj = createInjector(o, () => {})
    const out = { system: [] as string[] }
    await inj.onSystemTransform("s-unknown", out)
    expect(out.system).toEqual([])
  })

  test("search runs once per query thanks to the cache", async () => {
    const counter = path.join(await mkdtemp(path.join(os.tmpdir(), "mm-cnt-")), "hits.txt")
    const f = await fakeSearchBin(`echo "hit" >> "${counter}"\ncat <<'EOF'\n${RESULT}\nEOF`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const inj = createInjector(o, () => {})
    inj.onChatMessage({ sessionID: "s1" }, userMessage("same question"))
    await inj.onSystemTransform("s1", { system: [] })
    await inj.onSystemTransform("s1", { system: [] })
    await inj.onSystemTransform("s1", { system: [] })
    const hits = (await Bun.file(counter).text()).trim().split("\n").length
    expect(hits).toBe(1)
  })

  test("failing search degrades to no injection", async () => {
    const f = await fakeSearchBin(`exit 3`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const inj = createInjector(o, () => {})
    inj.onChatMessage({ sessionID: "s1" }, userMessage("anything"))
    const out = { system: [] as string[] }
    await inj.onSystemTransform("s1", out)
    expect(out.system).toEqual([])
  })

  test("parallel steps racing a slow search share one spawn", async () => {
    const counter = path.join(await mkdtemp(path.join(os.tmpdir(), "mm-cnt-")), "hits.txt")
    const f = await fakeSearchBin(`echo "hit" >> "${counter}"\nsleep 0.3\ncat <<'EOF'\n${RESULT}\nEOF`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const inj = createInjector(o, () => {})
    inj.onChatMessage({ sessionID: "s1" }, userMessage("same question"))
    const a = { system: [] as string[] }
    const b = { system: [] as string[] }
    await Promise.all([inj.onSystemTransform("s1", a), inj.onSystemTransform("s1", b)])
    const hits = (await Bun.file(counter).text()).trim().split("\n").length
    expect(hits).toBe(1)
    expect(a.system[0]).toContain("payments.yaml")
    expect(b.system[0]).toContain("payments.yaml")
  })

  test("parallel steps of one turn share a failing search, later turns retry it", async () => {
    const counter = path.join(await mkdtemp(path.join(os.tmpdir(), "mm-cnt-")), "hits.txt")
    const f = await fakeSearchBin(`echo "hit" >> "${counter}"\nsleep 0.2\nexit 3`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const inj = createInjector(o, () => {})
    inj.onChatMessage({ sessionID: "s1" }, userMessage("same question"))
    // The many LLM steps of one turn overlap and must cost one spawn...
    await Promise.all([inj.onSystemTransform("s1", { system: [] }), inj.onSystemTransform("s1", { system: [] })])
    expect((await Bun.file(counter).text()).trim().split("\n").length).toBe(1)
    // ...and the steps that follow within the turn reuse the failure instead of
    // paying the search budget again.
    await inj.onSystemTransform("s1", { system: [] })
    expect((await Bun.file(counter).text()).trim().split("\n").length).toBe(1)
    // Once the short failure window passes, a later turn asks again.
    await Bun.sleep(3200)
    await inj.onSystemTransform("s1", { system: [] })
    expect((await Bun.file(counter).text()).trim().split("\n").length).toBe(2)
  })

  test("synthetic parts never become the query", async () => {
    const f = await fakeSearchBin(`echo`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const inj = createInjector(o, () => {})
    inj.onChatMessage({ sessionID: "s1" }, { parts: [{ type: "text", text: "reminder", synthetic: true }] })
    const out = { system: [] as string[] }
    await inj.onSystemTransform("s1", out)
    expect(out.system).toEqual([])
  })
})

describe("trimQuery via onChatMessage", () => {
  test("a pasted wall of text becomes a bounded query", async () => {
    const counter = path.join(await mkdtemp(path.join(os.tmpdir(), "mm-q-")), "q.txt")
    const f = await fakeSearchBin(`printf '%s' "$4" > "${counter}"\ncat <<'EOF2'\n${RESULT}\nEOF2`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const inj = createInjector(o, () => {})
    inj.onChatMessage({ sessionID: "s1" }, userMessage("intent words " + "x".repeat(5000)))
    await inj.onSystemTransform("s1", { system: [] })
    const sent = await Bun.file(counter).text()
    expect(sent.length).toBeLessThanOrEqual(600)
    expect(sent.startsWith("intent words")).toBe(true)
  })
})

describe("failures and stale queries", () => {
  test("a failed search is not cached, so the next turn tries again", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mm-inj-"))
    const counter = path.join(dir, "count")
    // Fails once (backend locked), succeeds afterwards.
    const f = await fakeSearchBin(
      `echo x >> "${counter}"\nif [ "$(wc -l < "${counter}")" = "1" ]; then echo "database is locked" >&2; exit 1; fi\ncat <<'EOF'\n${RESULT}\nEOF`,
    )
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const inj = createInjector(o, () => {})

    inj.onChatMessage({ sessionID: "s1" }, userMessage("how is retry configured?"))
    const first = { system: [] as string[] }
    await inj.onSystemTransform("s1", first)
    expect(first.system).toEqual([])

    // Within the short negative window the failure is remembered, so a
    // multi-step turn does not pay the timeout again and again...
    const during = { system: [] as string[] }
    await inj.onSystemTransform("s1", during)
    expect(during.system).toEqual([])
    expect((await Bun.file(counter).text()).trim().split("\n").length).toBe(1)

    // ...but it expires quickly, so the next turn retries instead of staying
    // blind for the full result TTL.
    await Bun.sleep(3200)
    inj.onChatMessage({ sessionID: "s2" }, userMessage("how is retry configured?"))
    const second = { system: [] as string[] }
    await inj.onSystemTransform("s2", second)
    expect(second.system[0]).toContain("payments.yaml")
  })

  test("a turn with no text of its own does not reuse the previous question", async () => {
    const f = await fakeSearchBin(`cat <<'EOF'\n${RESULT}\nEOF`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const inj = createInjector(o, () => {})

    inj.onChatMessage({ sessionID: "s1" }, userMessage("how is retry configured?"))
    inj.onChatMessage({ sessionID: "s1" }, { parts: [{ type: "image", text: "" }] } as never)
    const out = { system: [] as string[] }
    await inj.onSystemTransform("s1", out)
    expect(out.system).toEqual([])
  })

  test("a search that returns nothing usable says so in the log", async () => {
    const f = await fakeSearchBin(`echo "No memories matched."`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const logs: string[] = []
    const inj = createInjector(o, (m) => logs.push(m))
    inj.onChatMessage({ sessionID: "s1" }, userMessage("anything?"))
    await inj.onSystemTransform("s1", { system: [] as string[] })
    expect(logs.some((l) => l.includes("no results"))).toBe(true)
  })
})

describe("only the agents the plugin follows get memories", () => {
  const spawnCounter = async () => path.join(await mkdtemp(path.join(os.tmpdir(), "mm-agent-")), "hits.txt")

  test("a turn from another agent is neither searched for nor injected into", async () => {
    // MiMoCode runs its own maintenance passes as sessions of their own —
    // "Auto Dream" and "Auto Distill", spawned with agent "dream"/"distill" —
    // whose job is to write the host's memory files. Their task text used to
    // become a search query, and this plugin's block landed in the prompt of
    // the very pass that consolidates facts, which is how excerpts of past
    // sessions end up copied into MEMORY.md. Subagents cost a search each too.
    const counter = await spawnCounter()
    const f = await fakeSearchBin(`echo "hit" >> "${counter}"\ncat <<'EOF'\n${RESULT}\nEOF`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const logs: string[] = []
    const inj = createInjector(o, (m) => logs.push(m))

    inj.onChatMessage({ sessionID: "s-dream", agent: "dream" }, userMessage("Run one automatic dream pass"))
    const out = { system: [] as string[] }
    await inj.onSystemTransform("s-dream", out)

    expect(out.system).toEqual([])
    expect(await Bun.file(counter).exists()).toBe(false)
    expect(logs.some((l) => l.includes("dream"))).toBe(true)
  })

  test("the main loop is unaffected, and a host that names no agent still gets memories", async () => {
    const f = await fakeSearchBin(`cat <<'EOF'\n${RESULT}\nEOF`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const inj = createInjector(o, () => {})

    inj.onChatMessage({ sessionID: "s-main", agent: "main" }, userMessage("how is retry configured?"))
    const main = { system: [] as string[] }
    await inj.onSystemTransform("s-main", main)
    expect(main.system[0]).toContain("payments.yaml")

    inj.onChatMessage({ sessionID: "s-old" }, userMessage("how is retry configured?"))
    const old = { system: [] as string[] }
    await inj.onSystemTransform("s-old", old)
    expect(old.system[0]).toContain("payments.yaml")
  })

  test("the agents option decides, so a project can opt its subagents back in", async () => {
    const f = await fakeSearchBin(`cat <<'EOF'\n${RESULT}\nEOF`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w", agents: ["main", "reviewer"] }, "/p/x")
    const inj = createInjector(o, () => {})

    inj.onChatMessage({ sessionID: "s-rev", agent: "reviewer" }, userMessage("how is retry configured?"))
    const out = { system: [] as string[] }
    await inj.onSystemTransform("s-rev", out)
    expect(out.system[0]).toContain("payments.yaml")
  })
})

describe("cache eviction is least-recently-used", () => {
  test("a recently reused query survives; the truly-oldest is evicted", async () => {
    // The cache holds 20 entries. Fill it, reuse the oldest so it is no longer
    // the least-recently-used, then overflow by one. FIFO eviction would drop
    // the entry we just reused; LRU drops the one that has actually gone cold.
    const counter = path.join(await mkdtemp(path.join(os.tmpdir(), "mm-lru-")), "hits.txt")
    const f = await fakeSearchBin(`printf '%s\\n' "$4" >> "${counter}"\ncat <<'EOF'\n${RESULT}\nEOF`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const inj = createInjector(o, () => {})
    const ask = async (q: string) => {
      inj.onChatMessage({ sessionID: "s1" }, userMessage(q))
      await inj.onSystemTransform("s1", { system: [] })
    }
    const spawns = async () => (await Bun.file(counter).text()).trim().split("\n").length

    for (let i = 0; i < 20; i++) await ask("query number " + i) // 20 distinct misses
    await ask("query number 0") // reuse the oldest: a hit, and now most-recently-used
    await ask("query number 20") // overflow by one, evicting the real LRU
    const base = await spawns()

    await ask("query number 0") // reused entry must still be cached: no new spawn
    expect(await spawns()).toBe(base)
    await ask("query number 1") // the true LRU was evicted: this re-spawns
    expect(await spawns()).toBe(base + 1)
  })
})

describe("identity file", () => {
  test("a huge identity file is capped instead of pasted whole", async () => {
    const f = await fakeSearchBin(`echo nothing`)
    const big = path.join(f.dir, "identity.md")
    await writeFile(big, "x".repeat(500_000))
    const logs: string[] = []
    const o = resolveOptions({ bin: f.bin, identityFile: big, wing: "w" }, "/p/x")
    const inj = createInjector(o, (m) => logs.push(m))
    const out = { system: [] as string[] }
    await inj.onSystemTransform("s1", out)
    expect(out.system[0]!.length).toBeLessThan(10_000)
    expect(logs.some((l) => l.includes("identity"))).toBe(true)
  })

  test("an identity file created after the first read is picked up", async () => {
    const f = await fakeSearchBin(`echo nothing`)
    const late = path.join(f.dir, "identity.md")
    const o = resolveOptions({ bin: f.bin, identityFile: late, wing: "w" }, "/p/x")
    const inj = createInjector(o, () => {})
    await inj.onSystemTransform("s1", { system: [] })
    await writeFile(late, "I work on the payments service.")
    const out = { system: [] as string[] }
    await inj.onSystemTransform("s1", out)
    expect(out.system[0] ?? "").toContain("payments service")
  })
})
