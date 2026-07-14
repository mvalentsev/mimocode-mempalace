# Changelog

Notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

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

[0.1.3]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.1.3
[0.1.2]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.1.2
[0.1.1]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.1.1
[0.1.0]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.1.0
