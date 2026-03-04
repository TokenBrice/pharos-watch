# Flow Intensity Signed Baseline Migration (0-Centered) — Execution Runbook

> Status: Execution-ready  
> Date: March 4, 2026  
> Scope: Mint/Burn Flow scoring, API contract, frontend presentation, docs, tests

## Goal

Move Mint/Burn Flow Intensity from midpoint semantics (`0..100` with neutral `50`) to explicit signed semantics:

- `-100 .. 0` => burn pressure
- `0` => neutral baseline
- `0 .. 100` => mint pressure

This runbook is designed to be self-sufficient after context reset.

---

## Decision Lock (No Open Choices)

These decisions are locked for implementation:

1. `coins[].flowIntensity` becomes canonical signed value (`-100..100`).
2. `gauge.score` also becomes signed (`-100..100`) for semantic consistency.
3. Band labels stay the same (`CRISIS`..`SURGE`) but thresholds are remapped around zero.
4. `flightIntensity` remains unchanged (`0..100`).
5. API cache key prefix for flows is bumped from `mint-burn-flows:v1` to `mint-burn-flows:v2`.
6. Methodology version bumps from `v4.1` to `v4.2`.

---

## Context Snapshot (As of March 4, 2026)

Current state in codebase:

1. Backend formula in [`worker/src/lib/mint-burn-scoring.ts`](worker/src/lib/mint-burn-scoring.ts):
- `intensity = clamp(0, 100, 50 + z * 25)`

2. Frontend already applies midpoint-to-signed conversion in [`src/lib/flow-intensity.ts`](src/lib/flow-intensity.ts):
- `(intensity - 50) * 2`

3. Mixed semantics exist:
- Some screens show signed values, while API and docs still define midpoint `0..100`.

4. Public contract/docs still say:
- `flowIntensity` is `0..100`
- `gauge.score` is `0..100`

---

## Mathematical Mapping

New canonical formula:

- `denominator = max(baselineDailyAbs * 0.3, 1_000_000)`
- `z = (currentDailyNet - baselineDailyNet) / denominator`
- `intensity = clamp(-100, 100, z * 50)`

This is exactly equivalent to converting old output (`old`) via:

- `new = (old - 50) * 2`

Examples:

| Old Midpoint FIS | New Signed FIS |
|---|---|
| 0 | -100 |
| 15 | -70 |
| 30 | -40 |
| 45 | -10 |
| 50 | 0 |
| 55 | 10 |
| 70 | 40 |
| 85 | 70 |
| 100 | 100 |

Signed band map:

| Band | Signed Range |
|---|---|
| `CRISIS` | `[-100, -70)` |
| `STRESS` | `[-70, -40)` |
| `CAUTIOUS` | `[-40, -10)` |
| `NEUTRAL` | `[-10, 10)` |
| `HEALTHY` | `[10, 40)` |
| `CONFIDENT` | `[40, 70)` |
| `SURGE` | `[70, 100]` |

---

## Contract Change Summary

Endpoint: `GET /api/mint-burn-flows`

Breaking contract changes:

1. `gauge.score` range changes from `0..100` to `-100..100`.
2. `coins[].flowIntensity` range changes from `0..100` to `-100..100`.

Unchanged fields:

1. `gauge.band` labels
2. `gauge.flightToQuality`
3. `gauge.flightIntensity (0..100)`
4. `netFlow*` USD metrics

---

## Pre-Implementation Checklist

Run from repo root:

```bash
git status --short
npm run lint
npm test -- worker/src/lib/__tests__/mint-burn-scoring.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts
npm test -- src/lib/__tests__/critical-invariants.test.ts
```

Note: repo may be dirty. Do not revert unrelated user changes.

---

## File-by-File Implementation Tasks

## Phase 1: Backend Scoring + API

1. Update [`worker/src/lib/mint-burn-scoring.ts`](worker/src/lib/mint-burn-scoring.ts)
- Change FIS formula to signed domain.
- Clamp `[-100,100]`.
- Replace gauge band thresholds with signed map.
- Update code comments to signed semantics.

2. Update [`worker/src/api/mint-burn-flows.ts`](worker/src/api/mint-burn-flows.ts)
- Ensure emitted `flowIntensity` is signed canonical value.
- Ensure emitted `gauge.score` is signed canonical value.
- Bump `FLOW_CACHE_PREFIX` from `mint-burn-flows:v1` to `mint-burn-flows:v2`.
- Keep all non-FIS fields unchanged.

3. Update backend tests:
- [`worker/src/lib/__tests__/mint-burn-scoring.test.ts`](worker/src/lib/__tests__/mint-burn-scoring.test.ts)
- [`worker/src/api/__tests__/mint-burn-flows.test.ts`](worker/src/api/__tests__/mint-burn-flows.test.ts)

Required assertion updates:

1. Neutral FIS expectation `50 -> 0`.
2. Clamp tests `0/100 -> -100/100`.
3. Band tests for signed ranges.
4. Any fixture literal using `flowIntensity: 50` neutral -> `0` neutral.
5. Cache-fallback test keys should match `v2` prefix.

4. Update smoke checks:
- [`scripts/smoke-api.mjs`](scripts/smoke-api.mjs)

Changes:

1. `/api/mint-burn-flows` gauge range assertion: `[-100,100]`.
2. Add coin sample `flowIntensity` range assertion when non-null: `[-100,100]`.

Phase 1 verification:

```bash
npm test -- worker/src/lib/__tests__/mint-burn-scoring.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts
node scripts/smoke-api.mjs --base https://api.pharos.watch
```

---

## Phase 2: Frontend Semantics Unification

5. Refactor signed helper logic:
- [`src/lib/flow-intensity.ts`](src/lib/flow-intensity.ts)

Action:

1. Remove midpoint conversion behavior.
2. Keep only signed display/magnitude utilities, or replace with direct display helper.

6. Update components that currently convert midpoint values:

- [`src/components/flow-table.tsx`](src/components/flow-table.tsx)
- [`src/components/flow-summary-card.tsx`](src/components/flow-summary-card.tsx)
- [`src/components/flow-brrr-overview.tsx`](src/components/flow-brrr-overview.tsx)

Required changes:

1. Use API values as already-signed.
2. Remove double-conversion calls.
3. Rework threshold logic currently assuming `0..100`.
4. Map lever position in overview: `leverPct = (score + 100) / 2` (clamped to `0..100`).
5. Ensure sorting behavior for null values in table remains sensible with signed numbers.

7. Update gauge visuals:

- [`src/components/flow-gauge.tsx`](src/components/flow-gauge.tsx)
- [`src/components/flow-gauge-mini.tsx`](src/components/flow-gauge-mini.tsx)

Required changes:

1. Needle/angle mapping for `-100..100`.
2. Arc segments and tick marks for signed thresholds.
3. Min/max labels become `-100` and `100`.
4. Mini gauge shows explicit sign for positive values (`+` prefix).

8. Update runtime schemas/docs in types:
- [`src/lib/types.ts`](src/lib/types.ts)

Changes:

1. Update comments for signed ranges.
2. Optional strict bounds in Zod schema for `gauge.score` and `flowIntensity`.

Phase 2 verification:

```bash
npm run lint
npm test -- src/lib/__tests__/critical-invariants.test.ts
```

Manual UI checks:

1. `/flows` page: gauge, table, BRRR overview all agree on sign semantics.
2. `/stablecoin/:id` page flow summary card matches table values.
3. No value appears double-shifted (for example neutral showing `-100` or `+100`).

---

## Phase 3: Documentation + Versioning

9. Update FAQ and page metadata copy:
- [`src/app/flows/layout.tsx`](src/app/flows/layout.tsx)

10. Update methodology content:
- [`src/app/methodology/page.tsx`](src/app/methodology/page.tsx)

Must update:

1. Formula text.
2. Range text (`-100..100`).
3. Pipeline labels (neutral at `0`, not `50`).
4. Band table thresholds.
5. Worked example output values.

11. Update API and feature docs:

- [`docs/api-reference.md`](docs/api-reference.md)
- [`docs/mint-burn-flows.md`](docs/mint-burn-flows.md)

12. Version bump and changelog:

- [`src/lib/mint-burn-flow-version.ts`](src/lib/mint-burn-flow-version.ts)
- [`src/lib/__tests__/mint-burn-flow-version.test.ts`](src/lib/__tests__/mint-burn-flow-version.test.ts)
- [`docs/mint-burn-flows-timeline.md`](docs/mint-burn-flows-timeline.md)

Required content for `v4.2` entry:

1. FIS moved from midpoint `0..100` to signed `-100..100`.
2. Gauge score moved to signed domain.
3. Band thresholds remapped around `0`.
4. Frontend conversion shim removed.

13. Update sitemap edit dates:
- [`src/app/sitemap.ts`](src/app/sitemap.ts)

Set last-edited for:

1. `/flows/`
2. `/methodology/`
3. `/methodology/mint-burn-flow-changelog/`

Phase 3 verification:

```bash
npm run lint
npm test -- src/lib/__tests__/mint-burn-flow-version.test.ts
```

---

## Acceptance Criteria (Definition of Done)

All must be true:

1. `computeFlowIntensity` returns `0` when current net equals baseline net.
2. API emits signed values (`-100..100`) for `gauge.score` and `coins[].flowIntensity`.
3. Frontend renders signed API values without extra conversion.
4. Gauge geometry and banding match signed thresholds.
5. Smoke checks enforce signed range and pass.
6. Methodology/docs/changelog reflect signed semantics and formula.
7. Cache fallback keys are on `v2`; stale `v1` flow payloads are not reused.

---

## Rollout Plan

1. Ship backend and frontend in same release window.
2. Deploy docs and methodology updates with same release.
3. Announce API contract change for `/api/mint-burn-flows` in release notes.
4. Monitor `scripts/smoke-api.mjs` and `/flows` rendering immediately after deploy.

---

## Rollback Plan

If critical regression appears:

1. Revert FIS/gauge formula and band thresholds to midpoint logic.
2. Revert frontend to midpoint conversion helper behavior.
3. Revert smoke assertions to `0..100`.
4. Bump cache prefix again (`v3`) to isolate bad cached payloads.

---

## Risk Register

1. Double conversion bug if any old helper path remains.
2. Threshold drift in `flow-brrr-overview` because it embeds many score heuristics.
3. Partial docs drift (methodology updated but API reference not updated).
4. Contract consumers broken by signed range if they assumed non-negative values.

Mitigations:

1. Search for all uses of `getSignedFlowIntensityDisplay` and midpoint assumptions (`50`, `45-55`) before merge.
2. Keep smoke assertions strict.
3. Keep version/changelog entry in same PR.

---

## Grep Checklist for Final Review

Run before merge:

```bash
rg -n "50 \+ z|clamp\(0, 100|Flow Intensity Score \(0|45.?55|below 45|above 55|0 \(max burn\) · 50 \(neutral\) · 100 \(max mint\)" src worker docs -S
rg -n "toSignedFlowIntensity|getSignedFlowIntensityDisplay" src -S
rg -n "mint-burn-flows:v1" worker/src -S
```

Expected:

1. No stale midpoint formula references in Mint/Burn docs/code.
2. No stale conversion helper usage that would double-transform values.
3. No `v1` flow cache prefix remaining in active handler code.

---

## Files Expected to Change

Backend/API:

1. `worker/src/lib/mint-burn-scoring.ts`
2. `worker/src/api/mint-burn-flows.ts`
3. `worker/src/lib/__tests__/mint-burn-scoring.test.ts`
4. `worker/src/api/__tests__/mint-burn-flows.test.ts`
5. `scripts/smoke-api.mjs`

Frontend:

6. `src/lib/flow-intensity.ts`
7. `src/lib/types.ts`
8. `src/components/flow-table.tsx`
9. `src/components/flow-summary-card.tsx`
10. `src/components/flow-brrr-overview.tsx`
11. `src/components/flow-gauge.tsx`
12. `src/components/flow-gauge-mini.tsx`

Docs/versioning:

13. `src/app/flows/layout.tsx`
14. `src/app/methodology/page.tsx`
15. `docs/api-reference.md`
16. `docs/mint-burn-flows.md`
17. `src/lib/mint-burn-flow-version.ts`
18. `src/lib/__tests__/mint-burn-flow-version.test.ts`
19. `docs/mint-burn-flows-timeline.md`
20. `src/app/sitemap.ts`

