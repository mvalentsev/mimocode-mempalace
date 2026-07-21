# Changelog

Notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

## [0.3.2] — 2026-07-21

Three long-standing rough edges, each pinned by a test that fails when the fix is reverted. Nothing else changes.

### Fixed

- **The search cache evicted by insertion order, not use.** A query re-issued on every step of a long turn was dropped as the "oldest" entry while one asked once and never again survived, so the memory most in demand was the one paying for a fresh search. The cache is least-recently-used now: a hit moves its entry to the recent end, and only a genuinely cold entry is evicted when the cache is full.
- **The two spellings of an accented project name split its wing.** A filesystem may hand back "café" as one code point (NFC) or as "e" plus a combining accent (NFD); untouched, the two slugged to different wings — and since the accent is a letter in one form and a combining mark in the other, one path kept a digest and the other did not. The name is normalized to NFC before slugging, so both spellings share one wing. One-time move: on a filesystem that stores names decomposed (NFD, e.g. legacy macOS or some network volumes), an auto-wing mixing such an accent with other non-ASCII text (`café-项目`) lands in a different wing than it did in 0.3.1; its earlier exchanges stay on disk and remain reachable with `searchScope: "palace"`, or by re-mining that directory.
- **`injectMaxChars` had no upper bound.** `num` rejected junk and non-positive values but passed any positive one, so `injectMaxChars: 1e9` would paste the entire search result into the system prompt on every step. It is clamped to 100,000 characters; a large-but-deliberate value below that is still honored.

## [0.3.1] — 2026-07-20

A review of what 0.3.0 shipped found that two of its headline fixes did not hold and two more were regressions. Those come first.

### Fixed

- **0.3.0 dropped real memories.** Its extractor skipped past the *last* line containing "Results for:", and mempalace prints retrieved text indented, so any memory that quoted that phrase pushed the cut past `[1]` and the whole block was discarded — logged as `search returned no results`, which reads as an empty palace. Against the live palace a query that returns 5268 characters of memories returned nothing at all. The header is now identified by the rule lines that frame it, which memories do not reproduce, and a memory quoting a rule line is covered by a test.
- **The 0.3.0 echo fix did not cover multi-line questions.** A question written as a numbered list (`[1] fix the crash` / `[2] ship it`) still had its own lines injected as "verbatim excerpts from past sessions", because the echo spans several lines and only the first was skipped. Discarding everything through the closing rule line covers it.
- **`run()` kept the host's event loop alive for its whole budget.** Racing against `Bun.sleep` leaves an uncancellable timer, and 0.3.0 removed the `clearTimeout` that 0.2.2 had: a 6 ms command with an 8 s budget kept the process up for 8.05 s — up to `mineTimeoutMs` (2 minutes by default) after every mine. The deadline is a real, cleared timer again.
- **`cleanupAfterMine` deleted transcripts mempalace never filed.** The 0.3.0 gate summed `Files processed` + `Files skipped`, but `Files processed` counts files *visited*: a transcript too short to chunk is counted there and never enters the palace. Verified against the live binary — `Files processed: 2`, `Drawers filed: 1` — so the gate could not fail, and the docs promised it would. Cleanup now removes only the files a run names in its `+ [ i/n] name` lines; anything else stays on disk, where a later mine can still pick it up.
- **A truncated emoji could poison a transcript for good.** A stream cut mid-character leaves an unpaired surrogate; `JSON.stringify` escapes it into valid JSON that is not valid UTF-8, so the miner either skips that file on every run from then on or dies on it. Lone surrogates are now stripped as the transcript is built.
- **`injectResults: 2.5` silently disabled memory.** Only `> 0` was checked, so a non-integer reached the CLI as `--results 2.5` and argparse exited 2 on *every* search for the life of the process. Counts that reach the CLI are floored, and absurd magnitudes fall back to the default.
- **The identity file had no size limit.** `injectMaxChars` bounds the search results only, so a 2 MB `identity.md` went into the system prompt whole, on every step of every turn — 2,000,032 characters, and the provider-side errors that follow point nowhere near this plugin. It is capped at 4000 characters now, with a line in the log when it truncates.
- **An identity file created after the plugin started was never picked up.** The first read was memoized including its failure, so the usual order — install the plugin, then write `identity.md` — needed a restart nobody mentions. A missing file is no longer remembered as missing.
- **A failing backend cost the search budget on every step of a turn.** 0.3.0 stopped caching failures entirely, so an agentic turn paid `searchTimeoutMs` again for each step. Failures now cache for three seconds: long enough to spare the rest of the turn, short enough that the next one retries.
- **Projects whose names only partly survive the slug still shared a wing.** `проект-v2` and `задача-v2` both became `v2`. The digest is now appended whenever any letter or digit is lost, not only when nothing at all survives. Wings that move this way are called out in the log, with the old wing named, since memories filed under it stay there.
- **backfill wrote its done-marker after partial failures**, which made a transient write error permanent: those sessions were never imported again. The marker is written only when every session lands.

## [0.3.0] — 2026-07-20

Two adversarial passes over the code this release cycle had not touched — recall and write paths — turned up the defects below. Every one is pinned by a test that fails when the fix is reverted.

### Fixed

- **A question containing `[1]` could come back as somebody's memory.** `extractResults` sliced from the first `[1]` anywhere in the output, and mempalace echoes the query above its results, so asking about `argv[1]` or `worker[1]` injected a fragment of the current question under "verbatim excerpts from past sessions" — even when the search matched nothing. The marker must now open its own line, after the echoed header.
- **`run()` had no hard timeout despite promising one.** A child that exits cleanly while a grandchild holds the pipe, or a child that ignores SIGTERM, blocked the call forever: a 500 ms budget measured 8 s. When it happens to the `--version` probe, the availability promise never settles and `system.transform` and `session.post` — which await it — stall for the rest of the session with an empty log. The wait now races the deadline, escalates to `SIGKILL`, and bounds the pipe drain.
- **Projects whose names are entirely non-Latin shared one wing.** `slugifyWing` dropped every non-`[a-z0-9_-]` character, so a Cyrillic and a CJK project both became `unsorted` and read each other's memories out of the same wing. Such names now get a `w-<digest>` wing of their own; Latin names keep the wing they always had.
- **A failed search was cached for two minutes, across every session.** One locked backend or one timeout silenced memory process-wide until the TTL expired, and the retry logged nothing. Completed searches still cache (a genuine miss included) so one turn costs one spawn; failures do not.
- **A completed turn with no text in its final message was dropped silently.** It is now logged, and in `captureMode: "turn"` the trajectory is saved instead of thrown away.
- **`backfill` froze the host.** The whole history was parsed synchronously on MiMoCode's event loop — ~12 s on a week-old database, 1.7 s even at `backfill: 50` — with the UI and every other plugin dead meanwhile. The scan and the export now yield between sessions. A wing that cannot be written no longer aborts the import and leaves no marker (which repeated the freeze on every start and skipped every session after it); failures are counted, logged, and the marker is written.
- **`flush()` returned while a scheduled mine was still pending**, so a mine queued during shutdown was left for the next startup sweep.
- **`cleanupAfterMine` deleted transcripts on exit code alone.** mempalace exits 0 while skipping files it cannot chunk, so those were deleted without ever entering the palace. Cleanup now requires the run's own tally to account for every transcript, and says so when it does not.
- A turn carrying no text of its own no longer reuses the previous question's memories.

### Changed

- **The log is on by default.** Every failure above is invisible without it, and `"log": false` still turns it off. A search that returns nothing usable, and the host's session-less transform call, now leave a line too.
- A timed-out search names its budget and the option to raise.

### Added

- An [Updating](README.md#updating) section: MiMoCode resolves `mimocode-mempalace@latest` once and reuses the cached copy forever with no version check, so a new release does not reach an existing install until the cache entry is removed or the version is pinned in the config.

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

[0.3.1]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.3.1
[0.3.0]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.3.0
[0.2.2]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.2.2
[0.2.1]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.2.1
[0.2.0]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.2.0
[0.1.3]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.1.3
[0.1.2]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.1.2
[0.1.1]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.1.1
[0.1.0]: https://github.com/mvalentsev/mimocode-mempalace/releases/tag/v0.1.0
