# mimocode-mempalace

Long-term memory for [MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code), backed by [MemPalace](https://github.com/MemPalace/mempalace).

MiMoCode ships a solid file-based project memory (MEMORY.md, checkpoints, FTS5 search). This plugin adds the other half: a semantic memory that spans all your sessions and projects. Every completed turn is saved into a MemPalace "palace", and on each new request the most relevant past exchanges are retrieved by meaning, not just keywords, and placed into the system prompt. The model doesn't have to remember to search; the plugin does it for it.

Ask "which port does the staging gateway use?" three weeks after you discussed it once, in a different session, and the answer is already in context.

## How it works

Write side:

1. `session.post` fires when a top-level turn finishes (it fires reliably, even on errors; only completed turns are saved).
2. The plugin writes the user question and the final answer as a small transcript file.
3. A debounced, serialized `mempalace mine` run files it into the palace. Runs never overlap, so the palace index stays healthy.
4. Exchanges are scoped into a wing named after your project directory, so search results stay project-relevant by default.

Read side:

1. `chat.message` remembers the text you typed.
2. `experimental.chat.system.transform` runs `mempalace search` with that text and appends a `# Long-term memory (MemPalace)` section to the system prompt: your identity file (optional) plus the top matching memories.
3. Results are cached per query for two minutes, so the multi-step tool loop of a single turn costs one search, not five.

Subagent slices (checkpoint writers, reviewers, title generators) are not captured, only the main loop. If mempalace is missing or the palace is unreachable, the plugin logs once and stays out of the way; your session works as if it were not installed.

## Requirements

- MiMoCode 0.1.5 or later
- MemPalace 3.3.5 or later (earlier releases have an HNSW corruption bug in `repair`; the plugin refuses to write through them)

```bash
uv tool install "mempalace>=3.3.5"
# or: pipx install "mempalace>=3.3.5"
```

## Setup

1. Create a palace (once):

```bash
mkdir -p ~/mimo-memory && mempalace init ~/mimo-memory --yes
```

2. Add the plugin to `~/.config/mimocode/mimocode.json` (or a project's `.mimocode/mimocode.json`):

```json
{
  "plugin": [
    ["mimocode-mempalace", { "palace": "~/mimo-memory" }]
  ]
}
```

Options live right next to the plugin name, in the same file. No side-channel config files.

3. Restart MiMoCode. The first start is slower while MiMoCode installs the plugin; later starts are instant.

To try it from a checkout instead of npm, use the absolute repo path as the plugin name:

```json
{
  "plugin": [
    ["/home/you/src/mimocode-mempalace", { "palace": "~/mimo-memory" }]
  ]
}
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `palace` | `~/.local/share/mimocode-mempalace/palace` | Palace directory (create it with `mempalace init`) |
| `bin` | `mempalace` | mempalace executable, if not on PATH |
| `wing` | `"auto"` | `"auto"` scopes memories per project directory name; a string pins one wing for everything; `false` disables wing scoping |
| `capture` | `true` | Save completed turns |
| `inject` | `true` | Retrieve and inject memories |
| `identityFile` | `~/.local/share/mimocode-mempalace/identity.md` | Markdown prepended to every injected block; missing file means no identity section; `false` disables |
| `injectResults` | `5` | Search results per injection |
| `injectMaxChars` | `6000` | Cap on the injected block size |
| `searchTimeoutMs` | `10000` | Search budget per query; on timeout the turn simply runs without memories |
| `mineDebounceMs` | `3000` | Quiet window before captured exchanges are mined in one batch |
| `mineTimeoutMs` | `120000` | Mine run budget |
| `exportsDir` | `~/.local/share/mimocode-mempalace/exchanges` | Where exchange transcripts are kept |
| `agents` | `["main"]` | Agent slices to capture |
| `log` | `false` | `true` logs to `~/.local/share/mimocode-mempalace/plugin.log`, a string sets a custom path |

## Notes

- Everything is local: exchanges, the palace, the search. Nothing leaves your machine beyond what your model provider already sees in the prompt.
- Exchange transcripts stay in `exportsDir` after mining. `mempalace mine` is incremental and skips already-filed files; the leftovers double as a plain-text journal of your sessions. Delete them whenever you like.
- A session that exits quickly can outrun the debounced mine. The next plugin start notices pending exchange files and mines them, so nothing is lost.
- The injected block tells the model to trust current code over old memories when they conflict.
- Vanilla OpenCode isn't a target right now: the capture path relies on MiMoCode's `session.post` hook, which upstream doesn't have. For OpenCode, look at [opencode-mempalace-persistence](https://github.com/geco/opencode-mempalace-persistence).

## Troubleshooting

Set `"log": true` in the plugin options and read `~/.local/share/mimocode-mempalace/plugin.log`:

- `ready: MemPalace X.Y.Z, palace=..., wing=...` means the plugin found everything.
- `mempalace unavailable` means the binary isn't on the PATH MiMoCode runs with; set `bin` to an absolute path.
- `palace is empty until the first exchange is mined` is normal on a fresh palace; it goes away after your first completed turn.
- `skip <session>: agent "..." not in [main]` shows the subagent filter doing its job.

## Development

```bash
bun install
bun test            # unit suite; the e2e file auto-skips without mempalace on PATH
bun run typecheck
```

## License

MIT
