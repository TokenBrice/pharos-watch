---
name: ci-slim-pass
description: Run a CI and test-suite slim pass (baseline, verified backlog, area lanes, observed wave). Use monthly, when a lane stays over budget, or to recover corpus headroom. Not for failed runs or releases.
---

# Pharos CI Slim Pass

## Trigger And Exclusions

Use for the scheduled monthly pass, when the weekly lane report shows the same lane over budget two consecutive weeks with no planned fix, or when the test corpus budget has no headroom left. Not for a failed run (route to [pharos-ci-failure-triage](../pharos-ci-failure-triage/SKILL.md)), a release (route to [pharos-release-runner](../pharos-release-runner/SKILL.md)), or new CI topology and product narrowing — lane budgets, tiers, isolation and gate scope are owner decisions. Never trade a protected class for wall time; when unsure, keep the case and the lane.

## Classify The Operation

Select baseline refresh only, backlog production (phases 1–4), backlog application (phases 5–6), a full cycle (1–7), or a targeted trim: one over-budget lane or a corpus-headroom recovery, where phase 2 batches only that lane's or area's files and every later phase still applies. Record the tripping lane(s), weeks over budget, and the areas the backlog may touch. Phases are ordered, one CI run in flight, and the parent owns integration. Without delegation, run the finder, verifier and review roles sequentially and disclose that verification was not independent.

## Mandatory Core

- [CI Pipeline](../../../docs/testing.md#ci-pipeline), [Test-lane gate protocol](../../../docs/testing.md#test-lane-gate-protocol), [Test evidence rules](../../../docs/testing.md#test-evidence-rules), [Nightly test tier](../../../docs/testing.md#nightly-test-tier), [Test corpus budget](../../../docs/testing.md#test-corpus-budget) and [Anti-creep](../../../docs/testing.md#anti-creep) own selection, gate artifacts, retention, tiers and the budget ratchet.
- Executable owners, not copies: lane ids, timeouts and budgets in `scripts/lib/pr-lanes.mts`; selection in `scripts/lib/pr-test-plan.mts` and `scripts/lib/pr-test-selection.mts`; corpora and registries in `scripts/lib/critical-ownership.mts`, `scripts/lib/critical-test-files.mts`, `scripts/lib/critical-coverage.mjs`, `scripts/lib/provider-resilience-registry.mjs` and `docs/doc-ownership.json`; data-integrity rules R1–R8 in [ADR-28..35](../../../docs/architecture.md#adr-28).
- The [rubric](references/rubric.md) is the one copy of protected classes, action definitions, tier limits, project costs and retirement tooling that every phase brief applies; change a shared rule there, not in a brief.
- Evidence before proposal: measure the lane, re-verify each finding against the tree you will edit, and never record a saving that a later run has not shown. Reports and manifests are scratch (`agents/`); the durable outputs are code, docs and the budget.

## Branch Reads And Actions

1. **Baseline.** Start from the latest `ci:weekly-report` issue and its retained `ci-weekly-report-*` artifact: lane p50/p90 against budget, failure rate by lane, files over the per-file budget and the test/production byte ratio. Recompute from `gh run list --repo TokenBrice/pharos-watch` plus `gh api repos/TokenBrice/pharos-watch/actions/runs/<id>/jobs` only when that report is stale or the pass runs mid-week; bucket failures by each run's first actionable error (`npm run ci:census -- --since=<date>` adds cohort trends, never reproduction). Budgets sit beside each lane's `timeoutMinutes` in `scripts/lib/pr-lanes.mts`, with `PR_PREPARE_BUDGET_SECONDS` for the `prepare` job. Corpus metrics come from the Git index only (`npm run check:test-corpus-budget -- --metrics-only`). If nothing is over budget and the cadence has not fired, stop and say so. The slowest files also get a [long-pole review](references/long-pole-brief.md) — one long pole can set a shard floor.
2. **Finder fan-out.** Batch the in-scope `*.test.ts(x)` files by owning area so each reviewer sees complete module families; disjoint batches, never a shared file. Read-only, under the [finder brief](references/finder-brief.md), which carries the output shape.
3. **Adversarial verification.** One verifier per batch, independent of its finder, defaulting to REJECTED: CONFIRMED, PARTIAL with corrected scope, or REJECTED — [verifier brief](references/verifier-brief.md).
4. **Backlog.** Keep only CONFIRMED/PARTIAL, dedupe across batches to one row per file and action, and order DEPIN, MERGE, CONVERT/DELETE/TRIM, SPEEDUP, DEMOTE. Each row keeps the finder id, verdict, corrected scope and owning area so an area lane can consume it without re-reading the reports. Record rejected findings so the next cycle does not re-propose them without new evidence.
5. **Area lanes.** Disjoint write lanes apply the backlog under the [lane brief](references/lane-brief.md), partitioned by owning area (for example worker cron, worker lib/api, shared and scripts, `src`, `functions`). Create each lane checkout with `npm run agent:worktree` and land its reviewed delta with `npm run agent:land`.
6. **Review lanes.** An independent reviewer reads the commits, not only the lane reports; defects are closed by a fix lane, each with a case or row in the owning suite. Both roles are in the [review brief](references/review-brief.md).
7. **Landing and observation.** After a trim, `npm run test-corpus:update` lowers the corpus ceilings; commit it with the wave. One wave is one integration PR through the protected-main path, one CI run in flight; collect every failed leaf and fix all causal defects in one revision. After merge, observe the first nightly execution and the next weekly report before recording any wall-time or failure-rate improvement.

## Checks Owned By The Verifier

Authoring feedback is not readiness. Run every touched suite (`npx vitest run …`), `npm run check:critical-coverage-completeness`, `npm run check:test-tier`, `npm run check:provider-resilience`, `npm run check:test-corpus-budget -- --base=origin/main`, `npm run check:unused-code`, `npx vitest run scripts/__tests__/doc-ownership-registry.test.ts` when a test path changed, the typechecks the touched packages need, `npx eslint <changed files>`, `git diff --check`, plus `npm run check:doc-sync` and `npm run check:agent-skills` when docs or this skill changed; readiness follows [Pre-push readiness](../../../docs/testing.md#pre-push-readiness). Fail closed: select or run more, never less, and reject any deletion that loses the last PR-tier coverage of a protected class even when it is faster.

## Completion Evidence

Report the baseline table (lane p50/p90 against budget, last-finishing lane, failure causes, corpus metrics), backlog counts by action, per-item applied/skipped with reasons, deleted, merged and demoted files, every protected-behaviour deletion with its surviving path and exact test title, review findings and how each closed, commands with outcomes, PR/run evidence, and the post-merge observation window — pending is not success. Name unresolved owner decisions and the next cycle's top candidates.
