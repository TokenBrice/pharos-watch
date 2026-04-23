# Validate Runtime Optimization - 2026-04-23

## Context

Latest reviewed Deploy to Cloudflare run: `24859700483` for `c3a1a1e`, completed successfully on April 23, 2026 with total duration `9m 49s`.

Observed validate timings:

- `validate / validate`: `3m 53s`
- `validate / validate-lts`: `4m 18s`
- `validate:prebuild`: about `24s` inside the Node 25 validate job
- post-prebuild validation: about `2m 59s`
- full Vitest lane: `177.56s`, the longest Node 25 validate step
- critical coverage lane: `28.06s`

## Subagent Findings

- The remaining success-path bottleneck is `npm test` in post-prebuild validation.
- `npm test` reruns the same 24 critical test files that `npm run coverage:critical` runs with coverage.
- Dropping critical coverage would weaken the gate because `scripts/check-critical-coverage.mjs` needs `coverage/lcov.info` and enforces file-level threshold and ratchet checks.
- Keeping one critical test list avoids drift between the critical coverage lane and any non-critical test exclusion list.
- Capping `validate:prebuild` at 8 concurrent `run-p` tasks keeps almost all success-path speed while avoiding unbounded process fan-out.
- `--continue-on-error` should not be the default for prebuild because it extends failed runs; keep it opt-in for diagnosis.

## Implemented

- Added `scripts/lib/critical-test-files.mjs` as the single source for critical test files.
- Replaced the deploy/merge-gate postbuild bare full-test command with `npm run test:noncritical`.
- Kept `npm run coverage:critical` as the owner of critical test files and coverage ratchets.
- Added `scripts/run-noncritical-tests.mjs` and `scripts/run-critical-coverage.mjs` wrappers that call the local Vitest binary directly.
- Added `scripts/lib/local-bin.mjs` and switched `validate:prebuild` to the local `run-p` binary.
- Kept `validate:prebuild` capped at 8 parallel tasks and fail-fast by default, with `VALIDATE_PREBUILD_CONTINUE_ON_ERROR=1` available for collecting all guardrail failures.

## Expected Runtime Impact

- Success path: avoids rerunning 24 critical test files in the long bare Vitest lane. Local probe from review showed the non-critical list excludes all 24 critical files.
- Failure path: prebuild no longer keeps launching queued guardrail tasks after the first failure unless explicitly requested.
- Validation surface is preserved: non-critical tests plus critical coverage still cover the same deploy test surface, while Pages build/SEO and worker typechecks remain conditional on deploy surface flags.

## Known Blocker Outside This Patch

`npm run validate:prebuild` is currently blocked by unrelated doc-source-path issues in `docs/superpowers/plans/2026-04-23-peg-diversity-icon-map.md` and `docs/superpowers/specs/2026-04-23-peg-diversity-icon-map-design.md`, which reference missing source paths. This is unrelated to the validation runner changes.
