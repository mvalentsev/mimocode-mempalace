# Contributing

Thanks for taking the time. The bar is simple: small, verified changes.

## Setup

```bash
bun install
bun test            # unit suite, runs against stubs and temp dirs
bun run typecheck
```

The e2e file (`test/e2e.test.ts`) skips itself unless `mempalace` is on PATH. To run the full cycle — capture, mine, recall against a real palace:

```bash
uv tool install "mempalace>=3.6.0"
bun test test/e2e.test.ts
```

The first e2e run is slow (it warms the embedder); later runs are much faster.

## Ground rules

- **Zero runtime dependencies is a feature.** The plugin ships as plain TypeScript sources that MiMoCode loads directly; a PR that adds a runtime dependency needs a very strong case.
- **The README states only verified behavior.** If you change what the plugin does, change the README in the same PR — and make sure the new wording is something a test or a live MiMoCode run actually shows.
- **Tests accompany behavior changes.** Unit tests stub the `mempalace` binary (see `test/miner.test.ts` for the pattern), so most behavior is testable without installing anything.
- **Conventional commits**: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`.

## Reporting bugs

Set `"log": true` in the plugin options, reproduce once, and attach the relevant `plugin.log` lines to the issue — they usually pinpoint the problem. Palace, mining, and search internals belong upstream in [MemPalace](https://github.com/MemPalace/mempalace/issues); host-side hook behavior belongs in [MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code/issues).
