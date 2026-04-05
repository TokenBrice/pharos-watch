# Treasury Stable Exposure Remediation Plan

**Date:** 2026-04-04
**Status:** Proposed
**Depends on:** `agents/audits/2026-04-04-treasury-stable-exposure-review.md`

## Goal

Remediate every finding from the treasury stable exposure review so the feature becomes:

- mathematically honest
- explicit about partial coverage
- debuggable across daily runs
- expandable without shipping misleading rankings

The implementation should fix correctness and trustworthiness first, then improve observability, then broaden coverage.

## Non-goals

These are explicitly out of scope for the remediation pass:

- introducing a new treasury-specific score or methodology
- full non-EVM treasury support
- intraday treasury history
- replacing Sim as the primary treasury provider
- trying to exactly replicate DefiLlama treasury totals

## Research-locked decisions

### 1. Honesty outranks breadth

Do not expand the reviewed treasury registry until the current launch set stops publishing impossible or overstated ratios.

### 2. Treasury-relative metrics must be nullable

If the denominator cannot be defended, `% of treasury` must become `null` for that row instead of guessing, clipping, or allowing `>100%`.

### 3. Preserve both raw direct balances and the effective denominator

The feature currently conflates "direct wallet balances" and "treasury denominator". The remediation must split them.

Implementation decision:

- keep a raw direct-balance total
- compute a separate effective treasury denominator for treasury-relative metrics
- expose denominator quality/status in the response

### 4. Never silently drop derived stable exposure again

Derived stable legs that cannot be mapped to a Pharos stablecoin must still affect coverage and partiality reporting.

### 5. Invalid rows should still be inspectable, but not rankable by invalid metrics

If a row is partial or invalid:

- keep raw amounts visible
- suppress treasury-relative percentages
- suppress positive treasury-share badges
- exclude the row from treasury-relative summary counts

### 6. Add durable run history before broader expansion

The current cache-only snapshot is too opaque. Daily per-entity history must be written to D1 before the launch set grows materially.

## Target end state

After remediation, each treasury row should answer these questions explicitly:

- what is the raw direct wallet balance?
- what denominator was actually used for `% of treasury`?
- did DeFi-position supplementation affect the row?
- was any derived stable exposure unmapped or skipped?
- is the row safe to compare on treasury-relative metrics?

## Target API contract changes

### Entity-level shape

Revise `TreasuryStableExposureEntity` so it can distinguish the raw direct balance from the treasury-relative denominator.

Recommended contract:

```ts
interface TreasuryStableExposureEntity {
  protocolId: string;
  slug: string;
  name: string;
  category: string | null;
  source: "defillama-github";
  adapterFile: string | null;
  chains: string[];

  directWalletUsd: number;        // flat wallet balances only
  treasuryUsd: number | null;     // effective denominator used for treasury-relative percentages
  stablecoinSleeveUsd: number;
  trackedStableUsd: number;
  decentralizedStableUsd: number;

  decentralizedStablePctOfTreasury: number | null;
  decentralizedStablePctOfStableSleeve: number | null;
  weightedSafetyScore: number | null;
  weightedSafetyGrade: ReportCardGrade | null;

  governanceBuckets: { ... };
  holdings: TreasuryStableExposureHolding[];
  coverage: TreasuryStableExposureCoverage;
}
```

### Coverage additions

Add denominator and supplementation diagnostics:

```ts
interface TreasuryStableExposureCoverage {
  extractionMode: TreasurySeedExtractionMode;
  ownerCount: number;
  ownerChainCount: number;

  denominatorStatus:
    | "direct-only"
    | "adjusted-with-defi"
    | "partial"
    | "invalid";

  directWalletUsd: number;
  defiPositionUsd: number;
  consumedDirectBalanceUsd: number;

  trackedStableUsd: number;
  stablecoinSleeveUsd: number;
  untrackedStableUsd: number;
  derivedUntrackedStableUsd: number;
  ratedTrackedStableUsd: number;

  trackedStablePctOfTreasury: number | null;
  trackedStablePctOfStableSleeve: number | null;
  ratedTrackedStablePct: number | null;

  untrackedStableCount: number;
  derivedUntrackedStableCount: number;
  skippedDerivedPositionCount: number;

  notes: string[];
}
```

### Contract semantics

- `directWalletUsd` is the flat wallet-balance total from the balances endpoint.
- `treasuryUsd` is the denominator actually used for treasury-relative percentages.
- `treasuryUsd` is `null` when the denominator is partial or invalid.
- `denominatorStatus` is the row-level gate for treasury-relative ranking and badges.

## Invariants to enforce

These invariants must hold before a row is published as treasury-comparable:

1. `treasuryUsd == null` if denominator status is `partial` or `invalid`.
2. `decentralizedStablePctOfTreasury == null` when `treasuryUsd == null`.
3. `trackedStablePctOfTreasury == null` when `treasuryUsd == null`.
4. No holding `pctOfTreasury` may be non-null when `treasuryUsd == null`.
5. If `treasuryUsd != null`, then:
   - `stablecoinSleeveUsd <= treasuryUsd + 0.01`
   - `trackedStableUsd <= stablecoinSleeveUsd + 0.01`
   - every holding `pctOfTreasury <= 100`
6. Rows that violate any invariant must be downgraded to `denominatorStatus = "invalid"` and treasury-relative percentages must be nulled.

## Implementation workstreams

## Workstream 1: Shared normalization and invariant model

### Files

- `shared/types/treasury-stable-exposure.ts`
- `shared/lib/treasury-stable-exposure.ts`
- `shared/lib/__tests__/treasury-stable-exposure.test.ts`

### Changes

1. Split direct wallet totals from effective treasury denominator.
2. Add `denominatorStatus` and the new coverage fields.
3. Filter rounded-zero holdings out of the final holdings array.
4. Centralize invariant evaluation in shared normalization so the worker and API both use the same logic.

### Required behavior

- If no DeFi-position supplement is used, `treasuryUsd = directWalletUsd` and `denominatorStatus = "direct-only"`.
- If DeFi positions are used and every contributing position has a defensible total value, compute:
  - `treasuryUsd = directWalletUsd - consumedDirectBalanceUsd + defiPositionUsd`
  - `denominatorStatus = "adjusted-with-defi"`
- If any stable sleeve contribution depends on a DeFi position whose total value is missing or ambiguous, set:
  - `treasuryUsd = null`
  - `denominatorStatus = "partial"`
- If computed totals still violate the invariants, set:
  - `treasuryUsd = null`
  - `denominatorStatus = "invalid"`

### Tests

Add unit tests for:

- direct-only row with valid treasury-relative percentages
- adjusted-with-defi row where wrapper consumption and position totals reconcile correctly
- partial denominator row where stable sleeve can be computed but treasury-relative metrics become `null`
- invalid row where sleeve exceeds denominator and percentages are nulled
- rounded-zero holdings are filtered from `holdings`

## Workstream 2: Sim position parsing and derived-coverage honesty

### Files

- `worker/src/lib/sim-balances.ts`
- `worker/src/lib/__tests__/sim-balances.test.ts`

### Changes

Replace the current "tracked stable balances only" extractor with a richer derived-position model.

Recommended internal types:

```ts
interface SimDerivedStableLeg {
  chainId: number;
  tokenAddress: string;
  usdValue: number;
  trackedStablecoinId: string | null;
  consumedBalanceKeys?: string[];
}

interface SimDerivedTreasuryPosition {
  positionUsd: number | null;
  stableLegs: SimDerivedStableLeg[];
  consumedBalanceKeys: string[];
  classification: "underlying" | "loan" | "asset" | "lp-range" | "unknown";
  warnings: string[];
}
```

### Required behavior

1. For each DeFi position, capture both:
   - total position value usable for the treasury denominator
   - stable-leg breakdown usable for the stable sleeve
2. Preserve consumed wrapper keys separately from stable-leg mapping.
3. If the provider indicates a stable-like leg that cannot be resolved to a tracked Pharos stablecoin, count it toward:
   - `coverage.derivedUntrackedStableUsd`
   - `coverage.derivedUntrackedStableCount`
4. If the provider response is insufficient to determine whether a derived leg is stable, record a warning and count the position toward `skippedDerivedPositionCount`.
5. If a position contributes to the stable sleeve but has no defensible total `positionUsd`, the entity must become `partial`.

### Stable classification fallback order

Use this order when classifying derived legs:

1. explicit provider stable classification if present in the response
2. shared Pharos stable contract registry match
3. broader local stable registry match if available in shared data
4. otherwise classify as unknown and mark the row partial instead of silently dropping

### Tests

Add tests for:

- tracked wrapper unwrap with consumed balance keys
- LP position with one tracked stable leg and a full `positionUsd`
- derived stable leg that is stable but untracked
- derived position with stable sleeve contribution but missing `positionUsd`
- unknown derived position producing warnings and partiality counters

## Workstream 3: Worker sync, cache-write guardrails, and history persistence

### Files

- `worker/src/cron/sync-treasury-stable-exposure.ts`
- `worker/src/cron/__tests__/sync-treasury-stable-exposure.test.ts`
- `worker/src/lib/cron-logger.ts` or a dedicated treasury persistence helper if that is cleaner
- `worker/migrations/*` for new history table

### Changes

1. Update the sync job to consume the richer derived-position model.
2. Reject "publishable" status for rows whose invariants fail.
3. Persist daily entity snapshots to D1 in addition to cache.

### D1 history table

Add an additive migration for a small daily history table.

Recommended schema:

```sql
CREATE TABLE treasury_stable_exposure_history (
  snapshot_at INTEGER NOT NULL,
  protocol_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  denominator_status TEXT NOT NULL,
  direct_wallet_usd REAL NOT NULL,
  treasury_usd REAL,
  stablecoin_sleeve_usd REAL NOT NULL,
  tracked_stable_usd REAL NOT NULL,
  decentralized_stable_usd REAL NOT NULL,
  coverage_json TEXT NOT NULL,
  holdings_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_at, slug)
);

CREATE INDEX idx_treasury_history_slug_snapshot
  ON treasury_stable_exposure_history (slug, snapshot_at DESC);
```

This migration is backward-compatible and additive, which matches the repo’s D1 rollout rules.

### Sync write behavior

Within each successful run:

1. build entity rows
2. compute and apply invariant downgrades
3. sort rows with invalid/partial treasury-relative rows excluded from treasury-relative tiebreaks
4. write the cache snapshot
5. insert per-entity history rows for the same `snapshot_at`

### Cron metadata improvements

Extend the cron run metadata with:

- `partialEntityCount`
- `invalidEntityCount`
- `supplementedEntityCount`
- `historyRowsWritten`

### Tests

Add cron tests for:

- partial and invalid entities are still written, but treasury-relative percentages are nulled
- history rows are written on success
- metadata counts reflect partial/invalid rows

## Workstream 4: API contract enforcement

### Files

- `worker/src/api/treasury-stable-exposure.ts`
- `worker/src/api/__tests__/treasury-stable-exposure.test.ts`

### Changes

1. Update the schema to the new contract.
2. Add invariant validation on cache read, not just structural schema validation.
3. Fail closed on impossible cached payloads.

### Required behavior

- schema-invalid cached payload -> `503`
- structurally valid but invariant-broken cached payload -> `503`
- cold-start empty payload remains `200`

Recommended shared helper:

- `validateTreasuryStableExposureSnapshot(...)`

That helper should perform:

- schema parse
- row invariant checks
- top-level coverage consistency checks

## Workstream 5: Frontend honesty and coverage UX

### Files

- `src/components/treasury-stable-exposure-table.tsx`
- `src/components/__tests__/treasury-stable-exposure-table.test.tsx`
- `src/app/portfolio/client.tsx`

### Changes

1. Stop treating all rows as equally comparable.
2. Distinguish treasury-comparable rows from sleeve-only rows.
3. Make partiality and invalidity visible in the collapsed row.

### UI behavior

#### Summary copy

Replace the current top summary with split counts:

- `X` entities with treasury-comparable denominators
- `Y` entities with stable-sleeve-only / partial coverage

Do not count partial/invalid rows toward:

- `5%+` treasury-share badges
- the "at least 5% versus treasury value" summary line

#### Row badges

Add a visible status chip:

- `Treasury-comparable`
- `Partial denominator`
- `Invalid denominator`

#### Column semantics

Update labels so the user can tell what they are seeing:

- `DeFi Stable $` -> keep
- `% Treasury` -> show `N/A` when denominator is partial/invalid
- `Tracked Sleeve` -> keep
- coverage column should include denominator quality, not only tracked sleeve percentage

#### Expansion panel

Show both:

- `Direct wallet total`
- `Effective treasury denominator` or `N/A`

Also show:

- `DeFi position value included in denominator`
- `Untracked derived stable`
- `Skipped derived positions`

#### Row ordering

Default sort should remain dollar-denominated, but invalid/partial rows should not receive favorable treasury-relative tiebreak treatment.

### Tests

Add UI tests for:

- partial row hides treasury-relative badge and shows status chip
- invalid row renders `N/A` for treasury-relative percentages
- summary counts exclude partial/invalid rows from the `5%+` tally
- zero-dollar holdings do not render

## Workstream 6: Docs and contract sync

### Files

- `docs/api-reference.md`
- `docs/portfolio-page.md`
- `docs/architecture.md`
- `docs/worker-infrastructure.md`
- `docs/worker-and-api-limits.md`
- `docs/about-page.md` if treasury feature copy changes materially

### Required doc updates

#### `docs/api-reference.md`

Update:

- new entity fields
- `treasuryUsd` nullable semantics
- `directWalletUsd`
- `denominatorStatus`
- conditions under which `% of treasury` is null

#### `docs/portfolio-page.md`

Update:

- the table is not a single-confidence leaderboard
- treasury-comparable vs sleeve-only rows
- coverage and denominator disclosure

#### `docs/architecture.md`

Update:

- the daily treasury pipeline now writes both cache and history
- the endpoint contract changed

#### `docs/worker-infrastructure.md` and `docs/worker-and-api-limits.md`

Update:

- daily history persistence
- any changed cron metadata or write-path notes

#### Methodology docs

Do not touch methodology docs unless the implementation accidentally introduces a new scoring surface. This remediation should remain descriptive.

## Workstream 7: Registry expansion after honesty hardening

### Files

- `scripts/build-treasury-seeds.ts`
- `shared/data/treasury-seeds.json`
- supporting treasury research notes under `agents/`

### Execution order

Do this only after Workstreams 1-6 are merged and observed in production.

### Phase 1 expansion

Promote the existing reviewed `Aave` seed first.

Why:

- already present in the manifest
- already reviewed
- biggest held-out launch candidate

### Phase 2 expansion

Add the next parseable reviewed adapters in small batches.

Batch rule:

- no more than `10` additional owner-chain tuples per batch until the new history table shows stable daily runs

### Promotion criteria for each new batch

Require all of the following for three consecutive daily runs:

- `invalidEntityCount = 0`
- no new unexpected provider warnings
- cron duration remains within the documented daily budget
- no treasury-comparable row publishes `null` percentages unexpectedly unless explicitly accepted in notes

### Seed manifest rules

Keep explicit status values in the registry:

- `static-seeded`
- `custom-reviewed`
- `dynamic-unresolved`
- `missing`

Do not silently expand by parsing every static adapter at once.

## Recommended PR split

### PR 1: Honesty contract

Includes:

- Workstreams 1, 2, 4, and the minimum frontend changes from 5

Outcome:

- no impossible percentages
- partial/invalid rows clearly marked
- API/docs updated

### PR 2: History and observability

Includes:

- Workstream 3
- any admin/debug read path if needed after D1 history lands

Outcome:

- daily entity snapshots are queryable in D1
- cron metadata tells us how many rows are partial/invalid

### PR 3: Coverage expansion

Includes:

- Workstream 7

Outcome:

- broader launch set only after the base contract is trustworthy

## Validation plan

### Targeted tests

- `shared/lib/__tests__/treasury-stable-exposure.test.ts`
- `worker/src/lib/__tests__/sim-balances.test.ts`
- `worker/src/cron/__tests__/sync-treasury-stable-exposure.test.ts`
- `worker/src/api/__tests__/treasury-stable-exposure.test.ts`
- `src/components/__tests__/treasury-stable-exposure-table.test.tsx`

### Full repo validation before merge

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

If the migration/history PR adds new SQL or deploy-surface changes, keep the merge gate requirement unchanged and ensure the migration remains additive.

## Acceptance criteria

The remediation is complete only when all of the following are true:

1. No live row can publish `>100%` treasury-relative percentages.
2. Rows with incomplete denominators publish `null` treasury-relative metrics and a visible partial/invalid status.
3. Derived stable exposure is never silently dropped without affecting coverage metadata.
4. Zero-dollar holdings no longer render.
5. Daily per-entity treasury snapshots are persisted to D1.
6. Docs match the shipped API and UI semantics.
7. The next seed expansion can proceed from observed history instead of guesswork.
