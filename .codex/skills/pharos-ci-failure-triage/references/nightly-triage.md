# Nightly red triage

`.github/workflows/nightly-validation.yml` owns the job list; its final `nightly-red` job names every job it needs. [Scheduled validation](../../../../docs/testing.md#scheduled-validation) owns the issue lifecycle and [Nightly test tier](../../../../docs/testing.md#nightly-test-tier) the tier rules. The workflow file wins over this page.

## Collect

- Read every `full-static` leaf from its "Report mandatory static outcomes" step, then every job `nightly-red` needs. Leaves run independently, so one red leaf often has co-failures; fixing the first and re-running wastes a night.
- A cancelled run neither opens nor closes the issue. Compare the run's head SHA with `main` before reproducing; a later merge may already carry the fix.

## Reproduce Nightly-Only Leaves

These never run in the PR gate, so a green PR proves nothing about them:

| Leaf | Local reproduction |
| --- | --- |
| Typed lint | `npm run lint:typed` |
| Test typing | `npm run typecheck:tests` |
| Corpus budget (metrics half) | `npm run check:test-corpus-budget -- --metrics-only`; debt admitted by the owner override surfaces here. Trim or retire tests, or ask the owner; never raise a ceiling. |
| Sensitive-page copy | `npm run check:sensitive-page-copy` |
| Full tests, nightly tier | `npx vitest run <file>` for a `*.nightly.test.ts(x)` file or `nightly`-tagged case; the PR runner filters both out. |
| Shared-state leak | `npm test -- --project worker-shared --sequence.shuffle --sequence.seed=<run id>` then `npm test -- --project worker-shared --isolate`. Red shuffled and green isolated is leaked state, not a regression: fix the leak or enrol the file in `WORKER_SHARED_ISOLATED_OVERRIDES` (`scripts/lib/critical-ownership.mts`). The non-isolated `node` project leaks the same way (`npm test -- --project node --isolate` to confirm); `ISOLATED_NODE_TESTS` in that file is its exception list. |
| Test-plan parity | `npm run check:test-plan-parity -- --commits=5` |
| V9 resource | `npm run test:v9-resource` |
| Lighthouse | Read the retained `lighthouse-*` artifact first; `npm run check:pages-artifact` replays it and needs release data. Ratcheted routes and floors are in [Performance guardrails](../../../../docs/testing.md#performance-guardrails). |

A red leaf is an incident to fix, never a reason to demote it to another tier or loosen its floor.

## Close

Never close `ci:nightly-red` by hand. Comment the fix PR and merged SHA on the issue; the next green `main` run, scheduled or `workflow_dispatch`, closes it. Dispatch one manually when waiting a night would hide a second failure.
