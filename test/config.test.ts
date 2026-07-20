import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { resolveOptions, slugifyWing } from "../src/config.ts"

describe("slugifyWing", () => {
  test("lowercases and keeps hyphens/underscores", () => {
    expect(slugifyWing("My Project")).toBe("my-project")
    expect(slugifyWing("api_v2")).toBe("api_v2")
    expect(slugifyWing("weird///name!!")).toBe("weird-name")
  })
  test("never returns empty", () => {
    expect(slugifyWing("///")).toBe("unsorted")
    expect(slugifyWing("")).toBe("unsorted")
  })
})

describe("resolveOptions", () => {
  test("defaults", () => {
    const o = resolveOptions(undefined, "/home/u/projects/My App")
    expect(o.wing).toBe("my-app")
    expect(o.capture).toBe(true)
    expect(o.inject).toBe(true)
    expect(o.bin).toBe("mempalace")
    expect(o.injectResults).toBe(5)
    expect(o.agents).toEqual(["main"])
    expect(o.log).toBe(true)
    expect(o.palace).toContain("mimocode-mempalace")
  })

  test("wing pinning and disabling", () => {
    expect(resolveOptions({ wing: "Shared Notes" }, "/p/x").wing).toBe("shared-notes")
    expect(resolveOptions({ wing: false }, "/p/x").wing).toBe(false)
    expect(resolveOptions({ wing: "auto" }, "/p/some-dir").wing).toBe("some-dir")
  })

  test("tilde expansion", () => {
    const o = resolveOptions({ palace: "~/palace" }, "/p/x")
    expect(o.palace).toBe(path.join(os.homedir(), "palace"))
  })

  test("invalid values fall back to defaults", () => {
    const o = resolveOptions(
      { injectResults: -3, searchTimeoutMs: "soon", capture: "yes", agents: [1, 2] },
      "/p/x",
    )
    expect(o.injectResults).toBe(5)
    expect(o.searchTimeoutMs).toBe(10000)
    expect(o.capture).toBe(true)
    expect(o.agents).toEqual(["main"])
  })

  test("log accepts boolean or path", () => {
    expect(resolveOptions({ log: true }, "/p/x").log).toBe(true)
    expect(resolveOptions({ log: false }, "/p/x").log).toBe(false)
    expect(resolveOptions({ log: "~/x.log" }, "/p/x").log).toBe(path.join(os.homedir(), "x.log"))
  })

  test("identityFile can be disabled", () => {
    expect(resolveOptions({ identityFile: false }, "/p/x").identityFile).toBe(false)
    expect(resolveOptions(undefined, "/p/x").identityFile).toContain("identity.md")
  })
})

describe("new options", () => {
  test("searchScope, captureMode, cleanupAfterMine defaults", () => {
    const o = resolveOptions(undefined, "/p/x")
    expect(o.searchScope).toBe("wing")
    expect(o.captureMode).toBe("exchange")
    expect(o.cleanupAfterMine).toBe(false)
  })
  test("overrides accepted, junk rejected", () => {
    const o = resolveOptions({ searchScope: "palace", captureMode: "turn", cleanupAfterMine: true }, "/p/x")
    expect(o.searchScope).toBe("palace")
    expect(o.captureMode).toBe("turn")
    expect(o.cleanupAfterMine).toBe(true)
    const junk = resolveOptions({ searchScope: "galaxy", captureMode: 7 }, "/p/x")
    expect(junk.searchScope).toBe("wing")
    expect(junk.captureMode).toBe("exchange")
  })

  test("backfill: off by default, true, session count, junk", () => {
    expect(resolveOptions(undefined, "/p/x").backfill).toBe(false)
    expect(resolveOptions({ backfill: true }, "/p/x").backfill).toBe(true)
    expect(resolveOptions({ backfill: 25.9 }, "/p/x").backfill).toBe(25)
    expect(resolveOptions({ backfill: -1 }, "/p/x").backfill).toBe(false)
    expect(resolveOptions({ backfill: "all" }, "/p/x").backfill).toBe(false)
  })

  test("mineAgent and mimoDb defaults and overrides", () => {
    const o = resolveOptions(undefined, "/p/x")
    expect(o.mineAgent).toBe("mimocode")
    expect(o.mimoDb.endsWith(path.join("mimocode", "mimocode.db"))).toBe(true)
    const c = resolveOptions({ mineAgent: "michael", mimoDb: "~/elsewhere.db" }, "/p/x")
    expect(c.mineAgent).toBe("michael")
    expect(c.mimoDb).toBe(path.join(os.homedir(), "elsewhere.db"))
  })

  test("a project name with no slug characters keeps its own wing", () => {
    const cyrillic = resolveOptions({}, "/home/u/проекты/секретный-клиент").wing
    const cjk = resolveOptions({}, "/home/u/oss/日本語プロジェクト").wing
    expect(cyrillic).not.toBe("unsorted")
    expect(cjk).not.toBe("unsorted")
    expect(cyrillic).not.toBe(cjk)
    // Still a legal mempalace slug.
    expect(cyrillic as string).toMatch(/^[a-z0-9_-]+$/)
  })

  test("latin project names keep the wing they always had", () => {
    expect(resolveOptions({}, "/home/u/work/api").wing).toBe("api")
    expect(resolveOptions({}, "/home/u/x/My.Project").wing).toBe("my-project")
    expect(resolveOptions({ wing: "pinned" }, "/p/x").wing).toBe("pinned")
  })

  test("wingAuto reflects how wing was chosen", () => {
    expect(resolveOptions(undefined, "/p/x").wingAuto).toBe(true)
    expect(resolveOptions({ wing: "auto" }, "/p/x").wingAuto).toBe(true)
    expect(resolveOptions({ wing: "pin" }, "/p/x").wingAuto).toBe(false)
    expect(resolveOptions({ wing: false }, "/p/x").wingAuto).toBe(false)
  })
})

describe("counts that reach the CLI", () => {
  test("injectResults is always an integer", () => {
    expect(resolveOptions({ injectResults: 2.5 }, "/p/x").injectResults).toBe(2)
    expect(resolveOptions({ injectResults: 0.4 }, "/p/x").injectResults).toBe(5)
    expect(resolveOptions({ injectResults: 1e21 }, "/p/x").injectResults).toBe(5)
  })
})

describe("wings that lost characters to the slug", () => {
  test("a Latin fragment does not merge unrelated projects", () => {
    const a = resolveOptions({}, "/home/u/проект-v2").wing
    const b = resolveOptions({}, "/home/u/задача-v2").wing
    const c = resolveOptions({}, "/home/u/仕様-v2").wing
    expect(new Set([a, b, c]).size).toBe(3)
    expect(a as string).toMatch(/^[a-z0-9_-]+$/)
  })

  test("names the slug carries whole are untouched", () => {
    expect(resolveOptions({}, "/home/u/work/api").wing).toBe("api")
    expect(resolveOptions({}, "/home/u/x/My.Project").wing).toBe("my-project")
    expect(resolveOptions({}, "/home/u/x/api_v2").wing).toBe("api_v2")
  })
})
