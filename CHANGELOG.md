# Changelog

Notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

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

[0.1.1]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.1.1
[0.1.0]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.1.0
