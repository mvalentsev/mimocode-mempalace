import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile } from "node:fs/promises"
import os from "os"
import path from "path"
import {
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
  const miner: Miner = { schedule: () => calls.push("schedule"), flush: async () => {} }
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
    const capture = createCapture(o, spy.miner, () => {})
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
    expect(s.spy.calls).toEqual(["schedule"])
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
