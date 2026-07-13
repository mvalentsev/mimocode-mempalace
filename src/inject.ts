import type { Options } from "./config.ts"
import type { Logger } from "./log.ts"
import { extractResults, run, searchArgs } from "./mempalace.ts"

type PartLike = { type?: string; text?: string; synthetic?: boolean }

export type ChatMessageOutput = { parts?: PartLike[] }

const CACHE_TTL_MS = 120_000
const CACHE_MAX = 20
const SESSIONS_MAX = 100
const QUERY_MAX_CHARS = 600

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

export type Injector = {
  onChatMessage: (sessionID: string | undefined, output: ChatMessageOutput) => void
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
  const cache = new Map<string, { at: number; block: Promise<string> }>()

  const identity = (() => {
    let value: Promise<string> | undefined
    return () => {
      if (o.identityFile === false) return Promise.resolve("")
      value ??= Bun.file(o.identityFile)
        .text()
        .then((t) => t.trim())
        .catch(() => "")
      return value
    }
  })()

  let notedEmptyPalace = false

  const runSearch = async (query: string) => {
    const res = await run(o.bin, searchArgs(o, query), o.searchTimeoutMs)
    if (!res.ok) {
      // A palace nothing has been mined into yet is a normal state, not noise.
      if ((res.stdout + res.stderr).includes("has no chroma.sqlite3")) {
        if (!notedEmptyPalace) log("palace is empty until the first exchange is mined; search stays off")
        notedEmptyPalace = true
      } else {
        const detail = (res.stderr.trim() || res.stdout.trim()).slice(0, 300)
        log(`search failed (code=${res.code} timedOut=${res.timedOut}): ${detail}`)
      }
      return ""
    }
    return extractResults(res.stdout, o.injectMaxChars)
  }

  const searchBlock = (query: string): Promise<string> => {
    const hit = cache.get(query)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.block
    log(`search (cache miss): "${query.slice(0, 80)}${query.length > 80 ? "…" : ""}"`)
    // Failures cache as "" too: an empty or broken palace must not re-spawn a
    // search on every LLM step of the same turn.
    const block = runSearch(query)
    cache.set(query, { at: Date.now(), block })
    mapCap(cache, CACHE_MAX)
    return block
  }

  return {
    onChatMessage: (sessionID, output) => {
      if (!sessionID) return
      const text = (output.parts ?? [])
        .filter((p) => p.type === "text" && !p.synthetic && typeof p.text === "string" && p.text.trim())
        .map((p) => p.text!.trim())
        .join("\n")
      if (!text) return
      lastUserText.delete(sessionID)
      lastUserText.set(sessionID, trimQuery(text))
      mapCap(lastUserText, SESSIONS_MAX)
    },
    onSystemTransform: async (sessionID, output) => {
      const sections: string[] = []
      const who = await identity()
      if (who) sections.push(who)

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
