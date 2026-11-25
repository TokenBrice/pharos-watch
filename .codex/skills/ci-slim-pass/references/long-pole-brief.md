# Long-pole test doctor (read-only)

PR test shards are duration-balanced from the nightly `test-timings` artifact (`.github/workflows/nightly-validation.yml`, merged by `scripts/maintenance/build-test-timings.ts`). It carries two maps: `wallFiles` is each file's wall cost (setup, import/collect and run) and drives shard balancing in `scripts/lib/pr-test-plan.mts`; `files` is assertion time only and drives the weekly over-budget table. Sort by `wallFiles` when present. CI runners are slower than a profiling host, so artifact or local seconds are not CI seconds. A single slow file can set a shard's floor.

For each file in your group (the orchestrator supplies the slowest files, optionally with their slowest cases):

1. Find the concrete cost driver(s) with file:line evidence: child processes (`spawnSync`/`execFile`/`tsx`/`node`/`npx`/`git`), workerd/wrangler, full-registry evaluation or full-catalog compile, migration replay, real timers/sleeps/polling (`setTimeout`, long `waitFor`, retry backoff without fake timers), large fixture generation, repeated heavy setup in `beforeEach`, network-shaped retry loops, Zod parsing of multi-MB JSON, esbuild bundling, ESLint/TypeScript program creation, or a heavy module graph that only `wallFiles` shows.
2. Propose the cheapest change that keeps the same assertions and contract: in-process call instead of spawn, fake timers or injected zero delays, `beforeAll`/shared fixture, a smaller synthetic fixture with the same branch coverage, a representative subset on the PR tier with the full sweep nightly, or a move to the nightly tier — name the PR-tier guard that remains. Apply the [rubric](rubric.md): say whether the file touches a protected class or sits in the nightly-tier safety net, and keep those on the PR tier.
3. Estimate the CI seconds saved per run of that file.

Return markdown: one section per file (path, measured duration, cost driver with evidence, proposal, estimate, tier: PR-keep / PR-speedup / nightly), max ~180 words per file. No code dumps.
