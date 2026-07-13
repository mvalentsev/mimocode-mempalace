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
