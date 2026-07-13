# mimocode-mempalace

Long-term memory for [MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code), backed by [MemPalace](https://github.com/MemPalace/mempalace).

MiMoCode ships a solid file-based project memory (MEMORY.md, checkpoints, FTS5 search). This plugin adds the other half: a semantic memory that spans all your sessions and projects. Every completed turn is saved into a MemPalace "palace", and on each new request the most relevant past exchanges are retrieved by meaning, not just keywords, and placed into the system prompt. The model doesn't have to remember to search; the plugin does it for it.

Ask "which port does the staging gateway use?" in a later session — after you discussed it once and forgot — and the answer is already in context.

## How it works

Write side:

1. `session.post` fires when a top-level turn finishes (it fires for completed and failed turns alike; only completed ones are saved).
2. The plugin writes the user question and the final answer as a small transcript file.
3. A debounced, serialized `mempalace mine` run files it into the palace. Runs never overlap, so the palace index stays healthy.
4. Exchanges are scoped into a wing named after your project directory, so search results stay project-relevant by default.

Read side:

1. `chat.message` remembers the text you typed.
2. `experimental.chat.system.transform` runs `mempalace search` with that text and appends a `# Long-term memory (MemPalace)` section to the system prompt: your identity file (optional) plus the top matching memories.
3. Results are cached per query for two minutes, so the multi-step tool loop of a single turn costs one search, not five.

Subagent slices (checkpoint writers, reviewers, title generators) are not captured, only the main loop. If mempalace is missing or the palace is unreachable, the plugin logs what happened and stays out of the way; your session works as if it were not installed.

## Requirements

- MiMoCode 0.1.5 or later
- MemPalace 3.3.5 or later — on anything older the plugin logs `plugin disabled` and neither reads nor writes

```bash
uv tool install "mempalace>=3.3.5"
```

## Setup

1. Create a palace (once):

```bash
mkdir -p ~/mimo-memory && mempalace init ~/mimo-memory --yes
```

2. Clone this repository and point `~/.config/mimocode/mimocode.json` (or a project's `.mimocode/mimocode.json`) at the checkout, using the absolute path as the plugin name:

```json
{
  "plugin": [
    ["/home/you/src/mimocode-mempalace", { "palace": "~/mimo-memory" }]
  ]
}
```

Options live right next to the plugin name, in the same file. No side-channel config files. (MiMoCode installs plugins named by bare package name from the public npm registry; this package is not published there yet, so use the checkout path.)

3. Restart MiMoCode. The very first start can take a while as MiMoCode sets the plugin up; after that the plugin is ready within a few seconds of startup.

## Options

| Option | Default | Meaning |
|---|---|---|
| `palace` | `~/.local/share/mimocode-mempalace/palace` | Palace directory (create it with `mempalace init`) |
| `bin` | `mempalace` | mempalace executable, if not on PATH |
| `wing` | `"auto"` | `"auto"` scopes memories per project directory name; a string pins one wing for everything; `false` drops per-project scoping — exchanges land in a shared `unsorted` wing and search is palace-wide |
| `searchScope` | `"wing"` | `"wing"` keeps recall inside the current project; `"palace"` searches across all projects ("how did I solve this in that other repo?") |
| `captureMode` | `"exchange"` | `"exchange"` saves question + final answer; `"turn"` also keeps the intermediate assistant replies of the turn (tool-loop reasoning) |
| `cleanupAfterMine` | `false` | Delete exchange transcripts once they are mined; by default they stay as a plain-text journal |
| `capture` | `true` | Save completed turns |
| `inject` | `true` | Retrieve and inject memories |
| `identityFile` | `~/.local/share/mimocode-mempalace/identity.md` | Markdown prepended to every injected block; missing file means no identity section; `false` disables |
| `injectResults` | `5` | Search results per injection |
| `injectMaxChars` | `6000` | Cap on the injected block size |
| `searchTimeoutMs` | `10000` | Search budget per query; on timeout the turn simply runs without memories |
| `mineDebounceMs` | `3000` | Quiet window before captured exchanges are mined in one batch |
| `mineTimeoutMs` | `120000` | Mine run budget |
| `mineAgent` | `"mimocode"` | Agent name mempalace records on every mined drawer |
| `backfill` | `false` | Import past MiMoCode sessions once: `true` for all, a number for the N most recent (see below) |
| `mimoDb` | `~/.local/share/mimocode/mimocode.db` | MiMoCode's SQLite database, read by `backfill` |
| `exportsDir` | `~/.local/share/mimocode-mempalace/exchanges` | Where exchange transcripts are kept |
| `agents` | `["main"]` | Agent slices to capture |
| `log` | `false` | `true` logs to `~/.local/share/mimocode-mempalace/plugin.log`, a string sets a custom path |

## Import your past sessions

Everything above only covers turns completed while the plugin is running. MiMoCode also keeps your whole history in a SQLite database, and the plugin can file it into the palace once:

```json
{
  "plugin": [
    ["mimocode-mempalace", { "palace": "~/mimo-memory", "backfill": 50 }]
  ]
}
```

On the next start the plugin reads the database (read-only; a live MiMoCode is fine, the db is in WAL mode), exports your past top-level sessions as transcripts — each scoped to the wing of the project it belonged to — and mines them. Subagent slices and hook-injected turns are filtered out, and sessions the plugin has already captured are skipped. `true` imports everything; a number imports the N most recent sessions.

Backfill runs once: it drops a `.backfill-done.json` marker next to the exchange transcripts and skips itself afterwards. Delete the marker to run it again. Best switched on right when you install the plugin.

## Active memory: MCP and the knowledge graph

The plugin covers the passive loop: capture and inject, no model discipline required. For active memory, where the model digs deeper on its own, wire the MemPalace MCP server into MiMoCode as well. Both halves share the same palace.

Add to `mimocode.json` next to the plugin entry:

```json
{
  "mcp": {
    "mempalace": {
      "type": "local",
      "command": ["mempalace-mcp", "--palace", "/home/you/mimo-memory"],
      "enabled": true
    }
  }
}
```

Use an absolute path in `command`: the args array is spawned without a shell, so `~` isn't expanded there (plugin options do expand it).

MiMoCode prefixes every tool with the server name from the config, so with the entry above the model sees `mempalace_mempalace_search`, `mempalace_mempalace_kg_query`, `mempalace_mempalace_kg_add` and friends. The injected block answers most questions by itself; MCP lets the model follow up when the injected excerpt is not enough, and record durable facts into the knowledge graph.

To make the model actually use the graph, add a rules file (`AGENTS.md` in `~/.config/mimocode/` or your project):

```markdown
## Memory protocol

Relevant memories already arrive in the system prompt under "Long-term memory
(MemPalace)"; you don't need to search for what's already there.

- When an injected memory is truncated or you need more context around it,
  call `mempalace_mempalace_search` with a focused query.
- After a decision, a fixed bug, or a stated preference, record one fact with
  `mempalace_mempalace_kg_add` (subject "user" or the project name, object
  under 128 chars). Prefer quality over quantity; skip facts you are not
  sure about.
- Query `mempalace_mempalace_kg_query` for entity "user" when personalization
  matters.
```

## Notes

- Everything is local: exchanges, the palace, the search. Nothing leaves your machine beyond what your model provider already sees in the prompt.
- Exchange transcripts stay in `exportsDir` after mining. `mempalace mine` is incremental and skips already-filed files; the leftovers double as a plain-text journal of your sessions. Turn on `cleanupAfterMine` if you prefer them gone.
- A session that exits quickly can outrun the debounced mine. The next plugin start notices pending exchange files and mines them, so nothing is lost.
- The injected block tells the model to trust current code over old memories when they conflict.
- Vanilla OpenCode isn't a target right now: the capture path is built on MiMoCode's `session.post` hook. For OpenCode, look at [opencode-mempalace-persistence](https://github.com/geco/opencode-mempalace-persistence).

## Troubleshooting

Set `"log": true` in the plugin options and read `~/.local/share/mimocode-mempalace/plugin.log`:

- `ready: MemPalace X.Y.Z, palace=..., wing=...` means the plugin found everything.
- `mempalace unavailable` means the binary isn't on the PATH MiMoCode runs with; set `bin` to an absolute path.
- `palace is empty until the first exchange is mined` is normal on a fresh palace; it goes away after your first completed turn.
- `skip <session>: agent "..." not in [main]` shows the subagent filter doing its job.
- `search failed (code=143 timedOut=true)` under load: on a small machine a mine running in parallel can push a search past `searchTimeoutMs`; that turn just runs without memories. Raise `searchTimeoutMs` if it keeps happening.
- `backfill: exported N session(s) ...` reports the one-time history import; `backfill skipped: ...` names the reason (missing or unreadable database, unexpected schema).

## Development

```bash
bun install
bun test            # unit suite; the e2e file auto-skips without mempalace on PATH
bun run typecheck
```

## License

MIT
