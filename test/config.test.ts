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
    expect(o.log).toBe(false)
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
    expect(resolveOptions({ log: "~/x.log" }, "/p/x").log).toBe(path.join(os.homedir(), "x.log"))
  })

  test("identityFile can be disabled", () => {
    expect(resolveOptions({ identityFile: false }, "/p/x").identityFile).toBe(false)
    expect(resolveOptions(undefined, "/p/x").identityFile).toContain("identity.md")
  })
})
