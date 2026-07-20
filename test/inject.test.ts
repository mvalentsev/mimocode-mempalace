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

    inj.onChatMessage("s1", userMessage("how is retry configured?"))
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
    inj.onChatMessage("s1", userMessage("same question"))
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
    inj.onChatMessage("s1", userMessage("anything"))
    const out = { system: [] as string[] }
    await inj.onSystemTransform("s1", out)
    expect(out.system).toEqual([])
  })

  test("parallel steps racing a slow search share one spawn", async () => {
    const counter = path.join(await mkdtemp(path.join(os.tmpdir(), "mm-cnt-")), "hits.txt")
    const f = await fakeSearchBin(`echo "hit" >> "${counter}"\nsleep 0.3\ncat <<'EOF'\n${RESULT}\nEOF`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const inj = createInjector(o, () => {})
    inj.onChatMessage("s1", userMessage("same question"))
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
    inj.onChatMessage("s1", userMessage("same question"))
    // The many LLM steps of one turn overlap and must cost one spawn...
    await Promise.all([inj.onSystemTransform("s1", { system: [] }), inj.onSystemTransform("s1", { system: [] })])
    expect((await Bun.file(counter).text()).trim().split("\n").length).toBe(1)
    // ...but a failure is not remembered, so a later turn asks again.
    await inj.onSystemTransform("s1", { system: [] })
    expect((await Bun.file(counter).text()).trim().split("\n").length).toBe(2)
  })

  test("synthetic parts never become the query", async () => {
    const f = await fakeSearchBin(`echo`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const inj = createInjector(o, () => {})
    inj.onChatMessage("s1", { parts: [{ type: "text", text: "reminder", synthetic: true }] })
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
    inj.onChatMessage("s1", userMessage("intent words " + "x".repeat(5000)))
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

    inj.onChatMessage("s1", userMessage("how is retry configured?"))
    const first = { system: [] as string[] }
    await inj.onSystemTransform("s1", first)
    expect(first.system).toEqual([])

    // A different session, same question, right after the backend recovered.
    inj.onChatMessage("s2", userMessage("how is retry configured?"))
    const second = { system: [] as string[] }
    await inj.onSystemTransform("s2", second)
    expect(second.system[0]).toContain("payments.yaml")
  })

  test("a turn with no text of its own does not reuse the previous question", async () => {
    const f = await fakeSearchBin(`cat <<'EOF'\n${RESULT}\nEOF`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const inj = createInjector(o, () => {})

    inj.onChatMessage("s1", userMessage("how is retry configured?"))
    inj.onChatMessage("s1", { parts: [{ type: "image", text: "" }] } as never)
    const out = { system: [] as string[] }
    await inj.onSystemTransform("s1", out)
    expect(out.system).toEqual([])
  })

  test("a search that returns nothing usable says so in the log", async () => {
    const f = await fakeSearchBin(`echo "No memories matched."`)
    const o = resolveOptions({ bin: f.bin, identityFile: false, wing: "w" }, "/p/x")
    const logs: string[] = []
    const inj = createInjector(o, (m) => logs.push(m))
    inj.onChatMessage("s1", userMessage("anything?"))
    await inj.onSystemTransform("s1", { system: [] as string[] })
    expect(logs.some((l) => l.includes("no results"))).toBe(true)
  })
})
