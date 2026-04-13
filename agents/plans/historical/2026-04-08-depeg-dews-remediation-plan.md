# Depeg Tracker + DEWS Remediation Plan

Date: 2026-04-08
Related audit: [agents/audits/2026-04-08-depeg-dews-audit.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-04-08-depeg-dews-audit.md)
Repo: `/Users/ahirice/Documents/git/stablecoin-dashboard`

## Objective

Remediate every finding from the depeg tracker / DEWS audit with an implementation program optimized for sub-agent execution, while preserving the existing product contract unless a behavior change is required to fix data correctness.

Primary success criteria:

1. No remaining known Medium-or-higher correctness issue in the depeg / DEWS path.
2. Direction semantics, source trust semantics, and pending-incident semantics are centralized enough that future changes do not reintroduce drift.
3. The final review pass on the implementation returns fewer than 1 Medium issue.

## Scope

This plan covers all six findings from the audit:

1. Direction-agnostic pending confirmation
2. Write-once pending incident snapshots
3. DEWS divergence trusting thin DEX rows
4. Contradictory `recovery_price` persistence when native quotes veto primary recovery
5. Duplicated trust policy across live detection, confirmation, DEWS, and surfaced copy
6. Drifted docs/comments and methodology copy

## Constraints And Guardrails

- Keep fixes root-cause-driven. No “log and move on” patches where the state model is wrong.
- New D1 migrations must be backward-compatible. Do not require coordinated downtime.
- Public API shape should stay stable unless a new field is clearly necessary. Prefer internal semantics fixes over response-shape churn.
- Any depeg / DEWS methodology change must update:
  - [docs/depeg-detection.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/depeg-detection.md)
  - [docs/dews.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/dews.md)
  - [docs/depeg-dews-timeline.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/depeg-dews-timeline.md)
  - [src/app/methodology/page.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/methodology/page.tsx)
  - [src/app/methodology/sections/monitoring/pegscore-dews-section.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/methodology/sections/monitoring/pegscore-dews-section.tsx)
- Before final push, the repo still needs the standard validation gate:
  - `npm run test:merge-gate`

## Delivery Strategy

Use a staged program with one blocking core lane and two downstream parallel lanes.

Execution model:

1. Land a shared depeg-signal and trust-policy contract with characterization tests.
2. Land the pending-incident + confirmation fixes on top of that contract.
3. Align DEWS divergence trust to the fixed trust model with an explicit production floor.
4. Run a one-time persisted-data repair / prune tranche so already-stored bad data does not survive the rollout.
5. Update docs / methodology / surfaced copy to the verified contract.
6. Run an explicit review loop after each wave.
7. Do not start a lane whose write scope overlaps an in-flight lane.

## Sub-Agent Lane Allocation

### Lane A: Core Depeg Signal + Pending Incident Model

Ownership:

- `worker/src/lib/depeg-helpers.ts`
- new shared helper module(s) under `worker/src/lib/`
- `worker/src/cron/detect-depegs.ts`
- `worker/src/cron/confirm-pending-depegs.ts`
- `worker/src/api/peg-summary.ts`
- `worker/src/lib/peg-analytics.ts`
- `worker/migrations/*`
- depeg worker tests under `worker/src/cron/__tests__/` and `worker/src/lib/__tests__/`

Why this is one lane:

- Findings 1, 2, 4, and most of 5 touch the same invariants and the same files.
- Splitting this across concurrent workers would create merge conflicts and semantic drift.

### Lane B: DEWS Trust Alignment

Ownership:

- `worker/src/cron/dews/source-state.ts`
- `worker/src/cron/dews/scoring.ts`
- `worker/src/lib/dews.ts`
- `worker/src/cron/compute-dews.ts`
- DEWS tests under `worker/src/cron/__tests__/compute-dews.test.ts` and `worker/src/lib/__tests__/dews.test.ts`

Why this can run in parallel after Lane A stabilizes:

- It consumes the trust model, but its write scope is mostly independent once the shared contract is defined.

### Lane C: Docs, Methodology, And Surfaced Copy

Ownership:

- `docs/depeg-detection.md`
- `docs/dews.md`
- `docs/depeg-dews-timeline.md`
- `src/app/methodology/page.tsx`
- `src/app/depeg/page.tsx`
- `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx`
- any small adjacent methodology route helpers if needed

Why this is separate:

- It should not block the core worker fixes.
- It depends on the final semantics, so it should start after Lane A behavior is settled and Lane B semantics are known.

### Lane D: Review / Validation

Ownership:

- No long-lived code ownership
- Review comments, verification notes, and follow-up tickets in `/agents/`

Why this stays separate:

- Reviewers should not be writing into the same files as the implementation lanes.

## Workstream Graph

### Wave 0: Baseline And Characterization

Owner: Lead or a small worker before any semantic refactor

Goals:

- Lock in current behavior where it is intentionally correct.
- Add failing tests for every audited bug before the fix, where practical.
- Clear or at least document the existing unrelated lint blocker so the final gate is not ambiguous.

Files:

- `worker/src/cron/__tests__/detect-depegs.test.ts`
- `worker/src/cron/__tests__/confirm-pending-depegs.test.ts`
- `worker/src/cron/__tests__/compute-dews.test.ts`
- optionally `worker/src/lib/__tests__/depeg-helpers.test.ts`

Required new tests:

- New direct unit coverage for the canonical directional helper module (`worker/src/lib/__tests__/depeg-signals.test.ts` if that module name lands).
- Pending confirmation rejects opposite-direction corroboration from:
  - native quote
  - off-chain source
  - DEX median
  - pool challenger
  - CEX ticker
- Pending row refreshes severity when the same directional move worsens.
- Pending row flips direction safely instead of preserving stale direction.
- Native-quote recovery does not persist a contradictory recovery price.
- DEWS divergence ignores fresh-but-thin DEX rows once the new gate is introduced.
- Legacy `depeg_pending` rows created before the migration still confirm, expire, and dedupe safely when the new worker reads them with all additive columns unset.

Baseline commands:

```bash
npm run typecheck
cd worker && npx tsc --noEmit
npm test -- worker/src/cron/__tests__/detect-depegs.test.ts worker/src/cron/__tests__/confirm-pending-depegs.test.ts worker/src/cron/__tests__/compute-dews.test.ts
npm run lint
```

Note:

- `npm run lint` is currently failing on an unrelated warning in `worker/src/cron/blacklist/__tests__/balance-providers.test.ts`. Either fix that first in a tiny housekeeping change or record it explicitly before the depeg work begins so merge-gate failures are not misattributed.

Exit criteria:

- Every audited bug has an executable regression target.
- The team has a clean baseline or a written baseline exception.

### Wave 1: Shared Depeg Signal And Trust Contract

Owner: Lane A

Purpose:

- Remove direction / threshold / trust drift by centralizing the building blocks used by both live detection and pending confirmation.

Implementation:

1. Introduce pure helper modules, tentatively `worker/src/lib/depeg-signals.ts` and `worker/src/lib/depeg-trust-policy.ts`, that own:
   - directional peg-signal derivation: `{ bps, absBps, direction }`
   - same-direction / opposite-direction comparison helpers
   - threshold crossing helpers
   - source-trust classification helpers
   - aggregate-TVL floor evaluation helpers
   - secondary confirmation evaluation helpers that compose direction + trust
2. Keep `depeg-helpers.ts` focused on D1 and raw trust-tier loading; do not bury more policy into it.
3. Refactor `detect-depegs.ts` and `confirm-pending-depegs.ts` to use the new pure helpers for all directional and trust reasoning.
4. Publish the trust-policy helper as the only allowed source for the live depeg trust floor so downstream lanes can import it instead of copying current thresholds into new code.
5. Audit `peg-summary.ts` and `peg-analytics.ts` for any duplicated peg-state interpretation and route those read paths through the shared contract where applicable, so public read surfaces do not become a second policy fork.

Write scope:

- new `worker/src/lib/depeg-signals.ts`
- new `worker/src/lib/depeg-trust-policy.ts`
- `worker/src/cron/detect-depegs.ts`
- `worker/src/cron/confirm-pending-depegs.ts`
- `worker/src/api/peg-summary.ts`
- `worker/src/lib/peg-analytics.ts`
- focused unit tests for the new helper:
  - `worker/src/lib/__tests__/depeg-signals.test.ts`
  - `worker/src/lib/__tests__/depeg-trust-policy.test.ts`
- read-path regression tests:
  - `worker/src/api/__tests__/peg-summary.test.ts`
  - `worker/src/lib/__tests__/peg-analytics.test.ts`

Behavioral target:

- No intended runtime change yet beyond making the current rules explicit and reusable.
- If a helper extraction exposes an existing bug, fix it in the same lane instead of re-encoding the buggy behavior.

Validation:

```bash
npm test -- worker/src/lib/__tests__/depeg-signals.test.ts worker/src/lib/__tests__/depeg-trust-policy.test.ts worker/src/lib/__tests__/depeg-helpers.test.ts worker/src/lib/__tests__/peg-analytics.test.ts worker/src/api/__tests__/peg-summary.test.ts worker/src/cron/__tests__/detect-depegs.test.ts worker/src/cron/__tests__/confirm-pending-depegs.test.ts
cd worker && npx tsc --noEmit
```

Exit criteria:

- There is one reusable, tested contract for directional peg signals and source trust policy.
- Both live detection and confirmation consume it.
- Lane B has a published trust-policy helper/API to import, so DEWS work does not re-encode trust thresholds.
- Read-path consumers (`peg-summary.ts` and `peg-analytics.ts`) are test-backed against the new shared contract.
- The worker typecheck passes before Wave 1 is handed off downstream.

### Wave 2: Pending Incident Model + Direction-Aware Confirmation

Owner: Lane A

Purpose:

- Fix Findings 1, 2, and 4 completely.

Implementation Part A: Pending schema and state model

1. Add a backward-compatible migration for `depeg_pending` with nullable fields such as:
   - `last_seen_bps`
   - `last_seen_at`
   - `last_price`
   - `peak_seen_bps`
   - `peak_price`
   - optional `updated_at`
2. Keep the existing `first_seen_*` columns so rollout remains compatible with rows created by the old worker.
3. Teach detection to upsert pending rows rather than `DO NOTHING`.
4. Pending upsert semantics:
   - same direction:
     - preserve `first_seen_at`
     - refresh `last_seen_*`
     - update `peak_seen_*` if severity worsens
   - opposite direction:
     - retire the prior pending incident and replace it atomically, or rewrite the row as a new incident with fresh `first_seen_*`
     - do not preserve stale direction

Implementation Part B: Confirmation semantics

1. Evaluate every corroborating source with direction-aware helpers.
2. Promotion rule:
   - corroboration only counts when the source agrees on both threshold crossing and direction
3. Rejection rule:
   - opposite-direction corroboration is contradiction, not support
4. Event creation should use the freshest trustworthy pending state:
   - peak = max of confirmed current state and stored pending peak
   - direction = current pending direction, not stale `first_seen` direction from an earlier incident

Implementation Part C: Native-quote recovery persistence

1. When native quotes veto the primary recovery/continuation path, do not write a contradictory `recovery_price`.
2. Preferred minimal fix:
   - close with `recovery_price = NULL` when the closing authority is not the stored USD price
3. Optional follow-up if product value is high:
   - add internal recovery provenance metadata, but do not expand public API shape in this tranche unless necessary
4. Add explicit compatibility handling for legacy rows:
   - reads must fall back cleanly when additive columns are `NULL`
   - the rollout proof must cover pre-migration rows surviving into the new worker version

Files:

- migration file under `worker/migrations/`
- `worker/migrations/MANIFEST.md` if required by repo conventions
- `worker/src/cron/detect-depegs.ts`
- `worker/src/cron/confirm-pending-depegs.ts`
- any new helper/repository module for pending rows
- tests in:
  - `worker/src/cron/__tests__/detect-depegs.test.ts`
  - `worker/src/cron/__tests__/confirm-pending-depegs.test.ts`

Validation:

```bash
npm test -- worker/src/cron/__tests__/detect-depegs.test.ts worker/src/cron/__tests__/confirm-pending-depegs.test.ts
npm run check:migrations
cd worker && npx tsc --noEmit
```

Additional rollout proof:

- Add at least one targeted fixture representing a pre-migration `depeg_pending` row with only legacy columns populated.
- Validate confirm / expire / replacement behavior against that legacy fixture.

Exit criteria:

- No pending promotion can succeed on opposite-side corroboration.
- Pending rows refresh while waiting for confirmation.
- Direction flips are represented as new incidents, not stale mutations.
- Native-quote recovery no longer persists contradictory terminal prices.
- The `depeg_pending` migration passes the repo migration contract check before the tranche is considered complete.

### Wave 3: DEWS Divergence Trust Alignment

Owner: Lane B

Dependencies:

- Start only after Wave 1 exit criteria are met and Lane A has published the shared trust-policy helper/API.
- Lane B must import that shared trust-policy contract for the live depeg floor; do not start Wave 3 against copied thresholds or ad hoc trust checks.
- It does not need to wait for Wave 2 completion unless Wave 2 changes the shared trust-policy API again.

Purpose:

- Fix Finding 3 and the DEWS-related portion of Finding 5.

Implementation:

1. Expand DEWS source loading so the DEX divergence input carries trust metadata, not just raw price:
   - `dex_price_usd`
   - `source_total_tvl`
   - `updated_at`
2. Apply a deliberate DEWS trust floor before feeding DEX into `diverg`.
3. Use the live depeg trust floor, not the UI floor, for the DEWS divergence gate:
   - require the same aggregate-TVL minimum used by depeg-confirmation trust
   - keep the stricter threshold until there is new evidence and a separate audited relaxation plan
4. Consume the shared trust-policy helper from Lane A for that gate rather than re-encoding the trust floor locally in DEWS modules.
5. Keep the rule explicit in code and docs. Do not rely on the implicit storage floor from `dex_prices`.
6. Update comments in `compute-dews.ts` to reflect the true schedule and trust model.

Files:

- `worker/src/cron/dews/source-state.ts`
- `worker/src/cron/dews/contracts.ts`
- `worker/src/cron/dews/scoring.ts`
- `worker/src/lib/dews.ts`
- `worker/src/cron/compute-dews.ts`
- DEWS tests

Validation:

```bash
npm test -- worker/src/cron/__tests__/compute-dews.test.ts worker/src/lib/__tests__/dews.test.ts
cd worker && npx tsc --noEmit
```

Exit criteria:

- Thin but fresh DEX rows no longer influence DEWS divergence unless they pass the explicit live depeg trust floor.
- DEWS uses the shared trust-policy contract from Lane A rather than a duplicated local threshold implementation.
- DEWS comments and metadata describe the actual cadence and gating.
- The worker typecheck passes before Wave 3 is handed off to repair or docs lanes.

### Wave 4: Persisted Data Repair And Backfill

Owner: Lead with support from Lanes A and B

Dependencies:

- Start only after Waves 2 and 3 land so repair logic matches the new write semantics.

Purpose:

- Repair or remove already-persisted bad data so the rollout fixes production history, not just future writes.

Implementation Part A: `depeg_events` repair

1. Identify existing ended events whose `recovery_price` contradicts the closing semantics under the fixed rules.
2. Use the existing admin repair surface where possible:
   - `worker/src/api/audit-depeg-history.ts`
   - `worker/src/api/backfill-depegs.ts`
   - `worker/src/api/backfill-depegs-window.ts`
3. If current tools are insufficient, add a narrow one-time repair script or admin path for:
   - nulling contradictory `recovery_price` values
   - replaying affected event windows deterministically
4. Any new depeg-history repair surface must ship with a safety harness:
   - explicit target scoping by coin and/or bounded time window
   - dry-run / preview mode that reports the candidate mutation set before writes
   - post-run summary that reports exactly which rows were updated, deleted, or replayed

Implementation Part B: DEWS repair

1. Force-refresh current `stress_signals` immediately after the fixed DEWS cron lands so current scores self-heal without waiting for organic expiry.
2. Assess whether historical `stress_signal_history` rows can be deterministically recomputed from retained raw inputs.
3. If deterministic recompute is possible:
   - prefer extending or reusing `worker/src/api/backfill-dews.ts` if it can rebuild the affected window under the new trust floor
   - otherwise add a bounded admin repair script / endpoint and rebuild the affected window
4. If deterministic recompute is not possible because historical DEX trust inputs were not retained:
   - prune the unverifiable DEWS history window instead of continuing to serve known-bad derived data
   - document the reset boundary in methodology/timeline copy
5. Any new DEWS repair or prune surface must ship with the same safety harness:
   - explicit target scoping by date window and, where relevant, stablecoin selection
   - dry-run / preview mode that reports the exact recompute or prune set before writes
   - post-run summary with affected-row counts and resulting history boundary

Files / surfaces:

- `worker/src/api/audit-depeg-history.ts`
- `worker/src/api/backfill-depegs.ts`
- `worker/src/api/backfill-depegs-window.ts`
- `worker/src/api/backfill-dews.ts`
- `worker/src/api/stress-signals.ts`
- any new one-time repair script under `worker/scripts/` if required
- any admin repair surface added for DEWS history

Validation:

```bash
npm test -- worker/src/api/__tests__/audit-depeg-history.test.ts worker/src/api/__tests__/backfill-depegs.test.ts worker/src/api/__tests__/backfill-depegs-dry-run.test.ts worker/src/api/__tests__/backfill-dews.test.ts worker/src/api/__tests__/stress-signals.test.ts worker/src/api/__tests__/depeg-history-repair.test.ts worker/src/api/__tests__/dews-history-repair.test.ts
```

Required Wave 4 repair proofs:

- If Wave 4 adds a new historically mutating script instead of an API route, add an equivalent dedicated test under `worker/scripts/__tests__/` and substitute it into the Wave 4 gate; do not merge an untested mutation surface.
- Add dry-run / preview coverage for any new repair or prune surface, proving it enumerates a bounded mutation set before writes.
- Add bounded-target coverage proving the repair path cannot mutate outside the requested coin/window scope.
- Add a DEWS repair dry-run or bounded-window test proving the repair path recomputes history with the new trust floor when retained inputs are sufficient.
- Add a DEWS prune-path test proving unverifiable historical windows are removed cleanly and do not remain queryable through `stress-signals`.
- Add a current-state refresh assertion proving the post-rollout DEWS repair immediately updates present `stress_signals` rows instead of waiting for the next natural cron cycle.

Repair exit criteria:

- Contradictory persisted `recovery_price` rows are repaired or removed.
- Current DEWS rows are refreshed under the new trust floor.
- Historical DEWS rows are either recomputed from authoritative retained inputs or pruned where trustworthy recompute is impossible.
- Every historically mutating repair path is previewable, target-bounded, and auditable from its own output.
- The chosen production repair/prune run has an archived dry-run summary, an executed bounded mutation summary, and a recorded boundary note available for Wave 5 docs.

### Wave 5: Methodology, Docs, And Surfaced Copy Sync

Owner: Lane C

Dependencies:

- Wait until Waves 2, 3, and 4 are done so the written contract and any repair boundary language match final behavior.

Purpose:

- Fix Finding 6 and the doc/copy portion of Finding 5.

Implementation:

1. Update public `/depeg` FAQ copy:
   - Peg Score minimum history should match the implementation
   - depeg confirmation wording should match the real source set and direction-aware rules
2. Update methodology surface:
   - `docs/depeg-detection.md`
   - `docs/dews.md`
   - `docs/depeg-dews-timeline.md`
   - `src/app/methodology/page.tsx`
   - `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx`
3. Ensure docs explicitly call out:
   - pending incidents are refreshed, not write-once
   - confirmation requires same-direction corroboration
   - DEWS divergence trusts only gated DEX rows
   - any repair / prune boundary introduced by Wave 4
4. If the methodology version changes, update the relevant version/timeline source:
   - likely `shared/lib/depeg-dews-version.ts`

Validation:

```bash
npm test -- src/app/methodology/page.test.tsx src/app/depeg/page.test.tsx src/lib/__tests__/methodology-version.test.ts
npm run lint
```

Required content-level assertions:

- `/depeg` FAQ / JSON-LD answers assert the corrected Peg Score minimum-history claim
- `/depeg` FAQ / JSON-LD answers assert same-direction confirmation wording
- methodology shell copy in `src/app/methodology/page.tsx` stays in sync with the detailed monitoring section and links to the repaired DEWS/depeg contract
- methodology page copy asserts the final DEWS divergence gate and any Wave 4 repair boundary wording

Exit criteria:

- Public copy, methodology docs, and version/timeline metadata match the shipped behavior.

### Wave 6: End-To-End Validation And Review Loop

Owner: Lead + Lane D reviewers

Purpose:

- Force the implementation through explicit review/fix iterations until no reviewer can still identify a Medium-or-higher issue.

Validation suite:

```bash
npm test -- worker/src/cron/__tests__/detect-depegs.test.ts worker/src/cron/__tests__/confirm-pending-depegs.test.ts worker/src/cron/__tests__/compute-dews.test.ts worker/src/api/__tests__/depeg-events.test.ts worker/src/api/__tests__/peg-summary.test.ts worker/src/api/__tests__/stress-signals.test.ts src/hooks/__tests__/use-depeg-events.test.tsx src/components/__tests__/dews-summary.test.ts src/__tests__/depeg-tracker-sort.test.ts
npm run typecheck
cd worker && npx tsc --noEmit
npm run lint
npm run test:merge-gate
```

Review loop:

1. Spawn a data-correctness reviewer:
   focus on incident lifecycle, direction semantics, trust gating, and persistence integrity
2. Spawn a maintainability reviewer:
   focus on policy centralization, state-model clarity, and test coverage gaps
3. Optional third reviewer:
   focus on docs/methodology sync and rollout safety
4. Aggregate findings by severity.
5. If any reviewer returns a Medium-or-higher issue:
   - create a fix tranche immediately
   - re-run the relevant targeted tests
   - run another review round
6. Stop only when the combined review result is:
   - Critical: 0
   - High: 0
   - Medium: 0

Exit criteria:

- Review result is fewer than 1 Medium issue.
- Final gate is green.

## Recommended Sub-Agent Execution Order

### Tranche 1

- Worker A1: Wave 0 + Wave 1
- Reviewer R1: review Wave 1 output for correctness

### Tranche 2

- Worker A2: Wave 2 on top of A1
- Reviewer R2: review pending-incident semantics and migration safety

### Tranche 3

- Worker B1: Wave 3
- Worker C1: prepare doc notes and file map while B1 is in flight, but do not finalize writes yet
- Reviewer R3: review Wave 3 for shared trust-policy reuse and DEWS trust-gate correctness before Wave 4 starts

### Tranche 4

- Worker A3: Wave 4 depeg-event repair slice
- Worker B2: Wave 4 DEWS repair / prune slice
- These can run in parallel once Waves 2 and 3 are done
- Reviewer R4: review Wave 4 for bounded repair scope, dry-run output, and prune/recompute correctness before docs integrate the rollout

### Tranche 5

- Lead: run the approved Wave 4 production repair/prune tranche
- Required sequence:
  - execute dry-run / preview against the intended bounded window
  - inspect and record the candidate mutation set in `/agents/`
  - execute the bounded repair/prune write
  - archive the post-run summary and resulting repair boundary for docs/version updates

### Tranche 6

- Worker C1 final write pass: Wave 5
- Lead integrates repair + docs
- Reviewer R5 and R6 run the final Wave 6 review loop

## Known Decisions To Make Before Implementation Starts

1. Pending schema shape:
   - minimal new columns vs a cleaner incident table abstraction
   - recommendation: minimal additive migration now
2. Native recovery persistence:
   - `recovery_price = NULL` minimal fix vs provenance field
   - recommendation: minimal fix now, provenance only if reviewers still see ambiguity
3. DEWS trust floor:
   - UI floor vs live depeg floor
   - recommendation: use the live depeg floor in this remediation tranche

## Final Deliverables

- Remediated worker logic for depeg detection / confirmation / DEWS
- Backward-compatible migration for pending incidents if required
- Updated tests covering the new invariants
- Updated methodology docs and timeline/version metadata
- Final review notes in `/agents/` showing zero Medium-or-higher residual issues
