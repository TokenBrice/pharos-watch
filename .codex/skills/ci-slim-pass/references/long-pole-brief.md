# Long-pole test doctor (read-only)

PR test shards are duration-balanced from the nightly `test-timings` artifact (`.github/workflows/nightly-validation.yml`, merged by `scripts/maintenance/build-test-timings.ts`). It records per-file assertion durations only — module import is excluded, and CI runners are slower than the profiling host, so artifact or local seconds are not CI seconds. A single slow file can set a shard's floor.

For each file in your group (the orchestrator supplies the slowest files, optionally with their slowest cases):

1. Find the concrete cost driver(s) with file:line evidence: child processes (`spawnSync`/`execFile`/`tsx`/`node`/`npx`/`git`), workerd/wrangler, full-registry evaluation or full-catalog compile, migration replay, real timers/sleeps/polling (`setTimeout`, long `waitFor`, retry backoff without fake timers), large fixture generation, repeated heavy setup in `beforeEach`, network-shaped retry loops, Zod parsing of multi-MB JSON, esbuild bundling, ESLint/TypeScript program creation.
2. Propose the cheapest change that keeps the same assertions and contract: in-process call instead of spawn, fake timers or injected zero delays, `beforeAll`/shared fixture, a smaller synthetic fixture with the same branch coverage, a representative subset on the PR tier with the full sweep nightly, or a move to the nightly tier — name the cheap PR-tier guard that remains. Say whether it touches a protected class (fail-closed gates, R1–R8, security/auth, API/persistence contracts, money/supply arithmetic) and keep those on the PR tier unless an equal-strength cheaper check exists.
3. Estimate the CI seconds saved per run of that file.

Return markdown: one section per file (path, measured duration, cost driver with evidence, proposal, estimate, tier: PR-keep / PR-speedup / nightly), max ~180 words per file. No code dumps.
