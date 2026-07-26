import type { Options } from "./config.ts"
import type { Logger } from "./log.ts"
import { extractResults, run, searchArgs } from "./mempalace.ts"

type PartLike = { type?: string; text?: string; synthetic?: boolean }

export type ChatMessageOutput = { parts?: PartLike[] }

const CACHE_TTL_MS = 120_000
/** A failure is worth remembering for the rest of the turn, not for minutes. */
const FAILURE_TTL_MS = 3_000
const CACHE_MAX = 20
const SESSIONS_MAX = 100
const QUERY_MAX_CHARS = 600
const IDENTITY_MAX_CHARS = 4000

/** A pasted wall of code makes a poor and slow embedding query; the head carries the intent. */
const trimQuery = (text: string) => {
  if (text.length <= QUERY_MAX_CHARS) return text
  const cut = text.slice(0, QUERY_MAX_CHARS)
  const lastSpace = cut.lastIndexOf(" ")
  return lastSpace > QUERY_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut
}

const mapCap = <K, V>(map: Map<K, V>, max: number) => {
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

export type ChatMessageInput = { sessionID?: string; agent?: string }

export type Injector = {
  onChatMessage: (input: ChatMessageInput, output: ChatMessageOutput) => void
  onSystemTransform: (sessionID: string | undefined, output: { system: string[] }) => Promise<void>
}

/**
 * chat.message fires when a user turn is accepted; system.transform fires on
 * every LLM step of the loop that follows. The session's last user text is the
 * search query, and a short-TTL cache keeps repeated steps of one turn from
 * re-running the same search.
 */
export function createInjector(o: Options, log: Logger): Injector {
  const lastUserText = new Map<string, string>()
  // The promise itself is cached: parallel LLM steps of one turn arriving
  // before the first search finishes must await it, not spawn their own.
  const cache = new Map<string, { at: number; ttl: number; block: Promise<string> }>()

  const identity = (() => {
    let value: Promise<string> | undefined
    return () => {
      if (o.identityFile === false) return Promise.resolve("")
      value ??= Bun.file(o.identityFile)
        .text()
        .then((t) => {
          const text = t.trim()
          // injectMaxChars bounds the search results; nothing bounded this, so
          // a stray large file went into every prompt of every step whole.
          if (text.length <= IDENTITY_MAX_CHARS) return text
          log(`identity file is ${text.length} chars; injecting the first ${IDENTITY_MAX_CHARS}`)
          return text.slice(0, IDENTITY_MAX_CHARS) + "\n[truncated]"
        })
        .catch(() => {
          // Do not memoize "not there": the file is usually written just after
          // the plugin is installed, and a restart should not be the price.
          value = undefined
          return ""
        })
      return value
    }
  })()

  let notedEmptyPalace = false
  let notedNoSession = false
  /** Agents skipped for injection, so the log says it once per agent, not per turn. */
  const notedAgents = new Set<string>()

  const runSearch = async (query: string): Promise<{ block: string; ok: boolean }> => {
    const res = await run(o.bin, searchArgs(o, query), o.searchTimeoutMs)
    if (!res.ok) {
      // A palace nothing has been mined into yet is a normal state, not noise.
      if ((res.stdout + res.stderr).includes("has no chroma.sqlite3")) {
        if (!notedEmptyPalace) log("palace is empty until the first exchange is mined; search stays off")
        notedEmptyPalace = true
      } else {
        const detail = (res.stderr.trim() || res.stdout.trim()).slice(0, 300)
        log(
          `search failed (code=${res.code} timedOut=${res.timedOut}` +
            `${res.timedOut ? `, budget ${o.searchTimeoutMs}ms - raise searchTimeoutMs` : ""}): ${detail}`,
        )
      }
      return { block: "", ok: false }
    }
    const block = extractResults(res.stdout, o.injectMaxChars)
    if (!block) log(`search returned no results (${res.stdout.trim().length} chars, no [1] marker)`)
    return { block, ok: true }
  }

  const searchBlock = (query: string): Promise<string> => {
    const hit = cache.get(query)
    if (hit && Date.now() - hit.at < hit.ttl) {
      // Reuse is use: re-insert so the entry mapCap evicts is the least-recently
      // used, not merely the oldest-inserted - a query asked on every step of a
      // long turn should outlive one asked once and forgotten.
      cache.delete(query)
      cache.set(query, hit)
      return hit.block
    }
    log(`search (cache miss): "${query.slice(0, 80)}${query.length > 80 ? "…" : ""}"`)
    // A completed search caches - including an honest miss - so the many LLM
    // steps of one turn cost one spawn. A failure gets a much shorter window:
    // long enough that a broken backend is not re-dialled on every step of the
    // turn (each attempt costs the full search budget), short enough that the
    // next turn tries again instead of staying blind for minutes.
    const attempt = runSearch(query)
    const entry = { at: Date.now(), ttl: CACHE_TTL_MS, block: Promise.resolve("") }
    entry.block = attempt.then((r) => {
      if (!r.ok) entry.ttl = FAILURE_TTL_MS
      return r.block
    })
    // Re-inserting an expired key moves it to the recent end too, so refreshing
    // it does not leave it near the eviction edge.
    cache.delete(query)
    cache.set(query, entry)
    mapCap(cache, CACHE_MAX)
    return entry.block
  }

  return {
    onChatMessage: ({ sessionID, agent }, output) => {
      if (!sessionID) return
      // The host prompts more than the loop the user is talking to: subagents,
      // and its own maintenance passes ("Auto Dream", "Auto Distill", run as
      // agents "dream" and "distill") whose job is to write its memory files.
      // Their task text is nobody's question, and answering it with excerpts of
      // past sessions both costs a search and invites those excerpts into the
      // host's own memory. Only the agents this plugin follows are answered;
      // a host that names no agent keeps the old behavior.
      if (agent !== undefined && !o.agents.includes(agent)) {
        if (!notedAgents.has(agent)) {
          log(`not injecting into agent "${agent}" turns (agents: [${o.agents.join(", ")}])`)
          notedAgents.add(agent)
        }
        return
      }
      const text = (output.parts ?? [])
        .filter((p) => p.type === "text" && !p.synthetic && typeof p.text === "string" && p.text.trim())
        .map((p) => p.text!.trim())
        .join("\n")
      // A turn that carries no text of its own (a dropped file, an image) must
      // not inherit the previous question: its memories would answer something
      // the user is no longer asking.
      if (!text) {
        lastUserText.delete(sessionID)
        return
      }
      lastUserText.delete(sessionID)
      lastUserText.set(sessionID, trimQuery(text))
      mapCap(lastUserText, SESSIONS_MAX)
    },
    onSystemTransform: async (sessionID, output) => {
      const sections: string[] = []
      const who = await identity()
      if (who) sections.push(who)

      if (!sessionID && !notedNoSession) {
        // MiMoCode triggers this hook from a second, session-less call site
        // (Agent.generate); there is nothing to search for there.
        log("system transform without a sessionID: nothing to search for")
        notedNoSession = true
      }
      const query = sessionID ? lastUserText.get(sessionID) : undefined
      if (query) {
        const block = await searchBlock(query)
        if (block) {
          sections.push(
            "Relevant long-term memories retrieved for the current request (verbatim excerpts from past sessions; trust recent code over old memories when they conflict):\n\n" +
              block,
          )
        }
      }

      if (!sections.length) return
      const block = `# Long-term memory (MemPalace)\n\n${sections.join("\n\n")}`
      output.system.push(block)
      log(`injected ${block.length} chars into system (session ${sessionID})`)
    },
  }
}
