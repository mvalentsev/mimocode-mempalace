# Changelog

Notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

## [0.2.2] — 2026-07-20

### Fixed

- **The version gate read whatever dotted triple came first in `mempalace --version`.** A dependency warning (`A NumPy version >=1.22.4 is required`) or a wrapper's banner (`Python 3.11.9`) printed ahead of the real line decided the verdict, and in both directions: a perfectly good 3.6.0 was refused with `plugin disabled: ... is older than 3.6.0` — naming a version that is not older, which sends the reader down the wrong path — while a 3.5.0 sailed through as `ready`. The version is now read next to the product name, falling back to the last triple in the output, and output with no version at all says exactly that instead of blaming the version.
- **A transcript restored with an old timestamp stayed invisible to the sweep.** 0.2.1 compared mtimes against the journal, so a transcript arriving with an mtime older than the directory's last run was never filed: a restore from backup (`tar -x`, `cp -p` and `rsync -a` all preserve mtime), an `exportsDir` synced between machines, or a clock stepped backwards. The journal now also records how many transcripts a directory held, and a changed count — or a stamp from the future — re-sweeps it. Journals written by 0.2.1 keep working and gain the count at their next mine.

### Added

- Tests for the two invariants the 0.2.1 fix rested on but never covered: a transcript written while a mine is in flight is swept by the next start, and a two-digit minor (3.10.0) counts as newer than 3.6.0. Both are mutation-confirmed — breaking the code makes them fail.

## [0.2.1] — 2026-07-20

### Fixed

- **The startup sweep re-mined directories it had already filed.** Any directory holding a `*.jsonl` counted as pending, and transcripts stay on disk by default (`cleanupAfterMine: false`), so every start queued one `mempalace mine` per wing whether or not anything new had landed. Against a real 25 MB palace a single such no-op run costs 17.7 s, so an exports directory with two dozen wings spent minutes mining nothing on every start — and the session's first `search`, competing with that serialized queue, timed out (`search failed (code=143 timedOut=true)`), sending the opening request to the model without memories. A directory is now swept only when it holds a transcript newer than its own last successful mine. The timestamps live in `.mine-state.json` at the root of `exportsDir`; delete that file and the next start re-mines everything. The first start after this upgrade still sweeps every wing once — that pass is what writes the journal.
- `capture: false` now stops the startup sweep as well. The option reads as "completed turns are not saved", but the sweep still shelled out to `mempalace mine` and wrote to the palace.

## [0.2.0] — 2026-07-20

### Changed

- **Minimum supported versions are now MemPalace 3.6.0 and MiMoCode 0.1.6.** The version gate refuses anything older (`plugin disabled: MemPalace 3.5.0 is older than 3.6.0; upgrade mempalace`), and the number in that message now comes from the constant instead of a second hardcoded copy. MemPalace 3.6.0 is the release where `mine --mode convos` — the exact call this plugin makes — also derives graph hallways from the entities in the mined exchanges (they appear once an entity pair recurs across two drawers, and `mempalace hallways` lists them), and where transcripts keep the timestamp they were authored at. MiMoCode 0.1.6 is the host the plugin is developed and tested against; `@mimo-ai/plugin` moves to 0.1.6 with it.
- Docs caught up with what 3.6.0 actually reports: the MCP server now exposes 36 tools, not 35 (the `toolCount=` line in Troubleshooting), and the demo terminal shows `MemPalace 3.6.0`. Setup also notes that MiMoCode merges `mimocode.json` and `mimocode.jsonc` from the same directory, so an existing `.jsonc` config is where the keys belong.

### Added

- A test for the gate itself: below the minimum the plugin logs `plugin disabled` and `session.post` writes no transcript at all; at the minimum it logs `ready:` and captures the turn.
- The MCP section describes the half of the knowledge graph that fills itself: from 3.6.0 the plugin's own `mine --mode convos` links recurring paths, symbols and identifiers into hallways, listed by `mempalace hallways` or `mempalace_mempalace_list_hallways`.

## [0.1.3] — 2026-07-14

Documentation release; no code changes. This is also the release that brings the reworked README to the npm package page.

### Changed

- Quick start now leads the README: the one-line agent install sits right under the demo, ahead of How it works; the manual Setup is four steps with one `YOU` substitution and the fine print folded away.
- The Options table opens with a compass line: Setup used `palace` and `log`, everything else tunes a default.
- Corrections: the MCP block is wired in Setup step 3 (the Active memory section said step 2), and CONTRIBUTING no longer pins a unit-test count that drifts with every PR.

### Added

- A light-theme counterpart to the demo terminal (`demo-light.svg`), themed through `<picture>` like the rest of the visuals.
- Image assets slimmed by ImgBot — minified SVG, recompressed PNG; rendered pixels verified identical.

## [0.1.2] — 2026-07-14

Documentation release; no code changes.

### Changed

- Setup is a single end-to-end quick start: the MemPalace MCP server is wired in the same config step, `init`'s offer to mine the empty palace is marked skippable, and a final step verifies both the plugin log and the MCP tools.
- Troubleshooting is grouped by symptom — the plugin, the MCP server, the palace and the CLI — and walks MiMoCode's own log (`service=plugin` / `service=mcp`), including the `MIMOCODE_HOME` and `MIMOCODE_PURE` environment overrides and the harmless resources/prompts probe noise.

### Added

- README: a recall card showing the exact `# Long-term memory (MemPalace)` block as it lands in the system prompt, a feature grid up top, and MiMoCode/MemPalace version badges.
- npm keywords now match the repository topics.

## [0.1.1] — 2026-07-14

### Added

- Startup warning when the palace's `chroma.sqlite3` is a symlink. The palace is the whole directory (ChromaDB keeps vectors in segment folders next to the database file), so a symlinked database splits documents from vectors and searches fail with `Error finding id`; the plugin now logs `palace warning: ...` when it detects this.

## [0.1.0] — 2026-07-14

First public release.

### Added

- **Capture**: every completed top-level turn is written as a transcript file via `session.post` and filed into the palace by a debounced, serialized `mempalace mine` run. Failed turns and subagent slices (checkpoint writers, reviewers, title generators) are skipped.
- **Recall**: `experimental.chat.system.transform` appends a `# Long-term memory (MemPalace)` section to the system prompt — identity file plus the top `mempalace search` hits for the message remembered from `chat.message`. Search results (including failures) are cached per query for two minutes, so one turn costs one search.
- **Wings**: exchanges are scoped per project directory (`wing: "auto"`), pinnable to one wing, or unscoped; `searchScope: "wing" | "palace"` controls whether recall stays in the project or spans all of them.
- **Backfill**: one-shot import of past MiMoCode sessions from `mimocode.db` (opened read-only; WAL-safe next to a live MiMoCode), scoped to per-project wings, skipping already-captured sessions, with a `.backfill-done.json` marker; `backfill: true` imports everything, a number imports the N most recent.
- **Capture modes**: `exchange` (question + final answer) or `turn` (intermediate assistant replies of the tool loop as well); optional `cleanupAfterMine`.
- **Startup sweep**: exchanges a fast-exiting session left unmined are mined on the next plugin start, including foreign-wing leftovers.
- **Version gate**: on MemPalace older than 3.3.5 the plugin logs `plugin disabled` and neither reads nor writes; with no `mempalace` binary at all it logs once and stays a no-op.
- **Options**: `palace`, `bin`, `wing`, `searchScope`, `captureMode`, `cleanupAfterMine`, `capture`, `inject`, `identityFile`, `injectResults`, `injectMaxChars`, `searchTimeoutMs`, `mineDebounceMs`, `mineTimeoutMs`, `mineAgent`, `backfill`, `mimoDb`, `exportsDir`, `agents`, `log`.

[0.2.2]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.2.2
[0.2.1]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.2.1
[0.2.0]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.2.0
[0.1.3]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.1.3
[0.1.2]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.1.2
[0.1.1]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.1.1
[0.1.0]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.1.0
