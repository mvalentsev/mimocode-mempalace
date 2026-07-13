import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile } from "node:fs/promises"
import os from "os"
import path from "path"
import {
  buildTurnJsonl,
  buildExchangeJsonl,
  createCapture,
  exchangeFilename,
  extractLastUserText,
  type SessionPostInput,
} from "../src/capture.ts"
import { resolveOptions } from "../src/config.ts"
import type { Miner } from "../src/mempalace.ts"

const textPart = (text: string, extra: Record<string, unknown> = {}) => ({ type: "text", text, ...extra })

describe("extractLastUserText", () => {
  test("takes the last human user turn", () => {
    const got = extractLastUserText([
      { role: "user", parts: [textPart("first question")] },
      { role: "assistant", parts: [textPart("answer")] },
      { role: "user", parts: [textPart("second question")] },
    ])
    expect(got).toBe("second question")
  })

  test("skips hook-injected user turns and synthetic parts", () => {
    const got = extractLastUserText([
      { role: "user", parts: [textPart("real")] },
      { role: "user", parts: [textPart("injected")], provenance: { hookPhase: "post" } },
      { role: "user", parts: [textPart("reminder", { synthetic: true })] },
    ])
    expect(got).toBe("real")
  })

  test("undefined when nothing usable", () => {
    expect(extractLastUserText([])).toBeUndefined()
    expect(extractLastUserText([{ role: "assistant", parts: [textPart("a")] }])).toBeUndefined()
  })
})

describe("buildExchangeJsonl", () => {
  test("two valid JSON lines in Claude Code shape", () => {
    const raw = buildExchangeJsonl("q", "a")
    const lines = raw.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toEqual({ type: "user", message: { content: "q" } })
    expect(JSON.parse(lines[1]!)).toEqual({ type: "assistant", message: { content: "a" } })
  })

  test("newlines inside content survive the round-trip", () => {
    const raw = buildExchangeJsonl("line1\nline2", "resp\nmore")
    const lines = raw.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).message.content).toBe("line1\nline2")
  })
})

describe("exchangeFilename", () => {
  test("stable when message id present, sanitized", () => {
    expect(exchangeFilename("ses_1/2", "msg_9")).toBe("session-ses_12-msg_9.jsonl")
  })
})

const minerSpy = () => {
  const calls: string[] = []
  const miner: Miner = { schedule: () => calls.push("schedule"), enqueue: async () => {}, flush: async () => {} }
  return { miner, calls }
}

const baseInput = (over: Partial<SessionPostInput> = {}): SessionPostInput => ({
  sessionID: "s1",
  agentID: "main",
  outcome: "completed",
  finalText: "the answer",
  assistantMessageID: "m1",
  trajectory: [{ role: "user", parts: [textPart("the question")] }],
  ...over,
})

describe("createCapture.onSessionPost", () => {
  const setup = async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-cap-"))
    const o = resolveOptions({ exportsDir: tmp, wing: "w1" }, "/p/x")
    const spy = minerSpy()
    const capture = createCapture(o, spy.miner, () => {}, Promise.resolve(true))
    return { tmp, capture, spy }
  }

  test("writes an exchange and schedules mining", async () => {
    const s = await setup()
    await s.capture.onSessionPost(baseInput())
    const files = await readdir(s.capture.dir)
    expect(files).toEqual(["session-s1-m1.jsonl"])
    const content = await readFile(path.join(s.capture.dir, files[0]!), "utf8")
    expect(content).toContain("the question")
    expect(content).toContain("the answer")
    // The startup sweep may race the first write and add a second schedule;
    // the miner coalesces, so the contract is "at least one".
    expect(s.spy.calls.length).toBeGreaterThanOrEqual(1)
    expect(s.spy.calls.every((c) => c === "schedule")).toBe(true)
  })

  test.each([
    ["subagent slice", baseInput({ agentID: "reviewer" })],
    ["errored run", baseInput({ outcome: "error" })],
    ["cancelled run", baseInput({ outcome: "cancelled" })],
    ["empty answer", baseInput({ finalText: "   " })],
    ["no user turn", baseInput({ trajectory: [] })],
  ])("skips %s", async (_name, input) => {
    const s = await setup()
    await s.capture.onSessionPost(input)
    const files = await readdir(s.capture.dir).catch(() => [])
    expect(files).toEqual([])
    expect(s.spy.calls).toEqual([])
  })
})

describe("buildTurnJsonl", () => {
  const traj = [
    { role: "user" as const, parts: [textPart("old question")] },
    { role: "assistant" as const, parts: [textPart("old answer")] },
    { role: "user" as const, parts: [textPart("current question")] },
    { role: "assistant" as const, parts: [textPart("let me check the config first")] },
    { role: "assistant" as const, parts: [textPart("reminder", { synthetic: true })] },
    { role: "user" as const, parts: [textPart("injected")], provenance: { hookPhase: "post" } },
    { role: "assistant" as const, parts: [textPart("final: port is 9090")] },
  ]

  test("keeps the current turn only, with intermediate assistant text", () => {
    const raw = buildTurnJsonl(traj, "final: port is 9090")!
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l))
    expect(lines.map((l) => l.type)).toEqual(["user", "assistant", "assistant"])
    expect(lines[0].message.content).toBe("current question")
    expect(lines[1].message.content).toBe("let me check the config first")
    expect(lines[2].message.content).toBe("final: port is 9090")
    expect(raw).not.toContain("old question")
    expect(raw).not.toContain("injected")
    expect(raw).not.toContain("reminder")
  })

  test("appends finalText when the trajectory tail misses it", () => {
    const raw = buildTurnJsonl(traj.slice(0, 4), "the real final")!
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l))
    expect(lines[lines.length - 1].message.content).toBe("the real final")
  })

  test("undefined without a user turn", () => {
    expect(buildTurnJsonl([{ role: "assistant", parts: [textPart("a")] }], "x")).toBeUndefined()
  })
})
