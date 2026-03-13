# Live Reserve Sync Hardening & Generalization — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Source audit:** `agents/audits/2026-03-12-live-reserve-sync-audit.md`

**Goal:** Resolve every issue identified in the audit by making the live-reserve pipeline operationally honest, properly visible in `/status`, generalizable across the researched source families, and explicitly scoped so the product no longer has an implicit “two truths” problem.

**Recommended scope decision:** In this remediation, keep live reserves as a **detail-page live overlay** with explicit fallback states. Do **not** make report cards, dependency map, compare copy, or portfolio analysis consume live reserve data yet. Instead, document clearly that those systems still rely on curated/static reserve metadata. This resolves the audit’s inconsistency issue now without coupling this hardening pass to scoring-methodology changes.

**Why this scope is recommended:**
- It fixes the current reliability and operator-trust issues first.
- It keeps the remediation bounded while the source model is still evolving.
- It avoids dragging report-card/methodology changes into the same release.
- It leaves room for a later “authoritative reserve graph” project once 3+ live source families are stable.

**Architecture target after this plan:**
- `reserve_composition` remains the table for the latest successful live snapshot.
- A new `reserve_sync_state` table records the last attempt, last success, current health, warnings, and last error for each live-enabled coin.
- `LiveReservesConfig` becomes structured enough to support API, scrape, indexer, and on-chain families without one-off hacks.
- Circuit breakers become **per-source/per-family**, not one global “live-reserves” breaker.
- The cron returns real statuses (`ok` / `degraded` / `error` / `skipped_locked`) instead of silently defaulting to `ok`.
- `/api/stablecoin-reserves/:id` becomes a **resolved presentation API** for configured coins: it returns the live snapshot when available and machine-readable fallback state when not.
- `/status` gets first-class reserve-sync health instead of inferring everything from cron freshness.
- The reserve endpoint probe becomes bootstrap-aware for environments where the daily sync has not succeeded yet.

**Out of scope for this remediation:**
- Historical reserve snapshots
- Solana/non-EVM adapter implementation beyond designing the config contract to support them
- Making live reserves authoritative inputs for PSI/report cards/dependency map/portfolio analysis

---

## Acceptance Criteria

- A fully failed `sync-live-reserves` run records `error` and shows red in `/status`.
- A partially successful run or a run with unknown inputs records `degraded` and exposes operator-facing metadata.
- If the circuit is open for one live source, unrelated sources are not blocked.
- `/status` includes a reserve-sync health block with counts for configured, fresh, stale, missing, and degraded live-reserve coins.
- The public reserve canary does not create false incidents before the first successful sync.
- A live-enabled detail page never silently falls back without telling the user whether it is showing:
  - a live snapshot
  - a stale live snapshot
  - a curated fallback because live data is unavailable
- Docs clearly state that live reserves currently power the detail-page overlay only.
- `npm run build`, `cd worker && npx tsc --noEmit`, `npm run lint`, and focused reserve/status tests pass.

---

## Reference Files

| Purpose | File |
|---|---|
| Audit source | `agents/audits/2026-03-12-live-reserve-sync-audit.md` |
| Source-shape research | `agents/research/real-time-reserve-update-sources.md` |
| Shared types | `shared/types/index.ts` |
| Static reserve helpers | `shared/lib/reserve-templates.ts` |
| Stablecoin metadata | `shared/lib/stablecoins.ts` |
| API path registry | `shared/lib/api-endpoints.ts` |
| Cron registry | `shared/lib/cron-jobs.ts` |
| Existing live cron | `worker/src/cron/sync-live-reserves.ts` |
| Adapter registry | `worker/src/cron/reserve-adapters/index.ts` |
| Current InfiniFi adapter | `worker/src/cron/reserve-adapters/infinifi.ts` |
| Circuit breaker | `worker/src/lib/circuit-breaker.ts` |
| Cron logging | `worker/src/lib/db.ts` |
| Health endpoint | `worker/src/api/health.ts` |
| Status endpoint | `worker/src/api/status.ts` |
| Status self-check | `worker/src/cron/status-self-check.ts` |
| Reserve API | `worker/src/api/stablecoin-reserves.ts` |
| Router | `worker/src/router.ts` |
| Reserve hook | `src/hooks/use-stablecoin-reserves.ts` |
| Detail view model | `src/lib/stablecoin-detail-view-model.ts` |
| Detail UI | `src/components/stablecoin-detail/overview-section.tsx` |
| Status cron summaries | `src/components/status/cron-metadata-summary.ts` |
| Status page | `src/app/status/client.tsx` |
| About page | `src/app/about/page.tsx` |
| API docs | `docs/api-reference.md` |
| Worker docs | `docs/worker-infrastructure.md` |
| Status docs | `docs/status-dashboard.md` |
| About-page docs | `docs/about-page.md` |
| Architecture docs | `docs/architecture.md` |
| Data-flow docs | `docs/data-flow-map.md` |
| Report-card docs | `docs/report-cards.md` |
| Dependency docs | `docs/dependency-map.md` |

---

## Chunk 0: Scope Freeze And Naming Cleanup

**Objective:** Resolve the audit’s “authoritative vs overlay” ambiguity before implementation starts.

**Files:**
- Modify: `agents/audits/2026-03-12-live-reserve-sync-audit.md` (optional reference note only if needed)
- Modify: `docs/api-reference.md`
- Modify: `docs/report-cards.md`
- Modify: `docs/dependency-map.md`
- Modify: `src/components/stablecoin-detail/overview-section.tsx` (copy only, later chunk)

- [ ] **Step 1: Freeze the remediation scope in code/docs terms**

Adopt this explicit statement across docs and API comments:

> “Live reserve sync currently powers the stablecoin detail-page reserve card only. Risk scoring, dependency mapping, compare copy, and portfolio analysis still use curated reserve metadata.”

- [ ] **Step 2: Ensure naming is consistent**

Use the following terminology consistently:
- `live snapshot` = successful synced reserve data from D1
- `curated fallback` = `meta.reserves`
- `template fallback` = classification-derived reserve template
- `sync state` = operational metadata about attempts, warnings, failures, and freshness

- [ ] **Step 3: Add a short note to this plan header if scope changes**

If the user later wants authoritative live reserves, that should be a follow-up implementation plan, not an in-flight expansion of this remediation.

---

## Chunk 1: Data Model And Shared Contract Hardening

**Objective:** Give the feature a durable schema and type system that can support multiple source families and explicit fallback states.

### Task 1: Add `reserve_sync_state` table

**Files:**
- Create: `worker/migrations/0065_reserve_sync_state.sql`

- [ ] **Step 1: Create migration**

```sql
CREATE TABLE IF NOT EXISTS reserve_sync_state (
  stablecoin_id     TEXT NOT NULL PRIMARY KEY,
  adapter_key       TEXT NOT NULL,
  breaker_key       TEXT NOT NULL,
  last_attempted_at INTEGER,
  last_success_at   INTEGER,
  last_status       TEXT NOT NULL,  -- ok | degraded | error | skipped
  warning_count     INTEGER NOT NULL DEFAULT 0,
  warnings          TEXT,           -- JSON array of warnings / unknown inputs
  last_error        TEXT,
  metadata          TEXT NOT NULL DEFAULT '{}'
);
```

- [ ] **Step 2: Add migration verification commands**

```bash
cd worker
npx wrangler d1 execute stablecoin-db --remote --file migrations/0065_reserve_sync_state.sql
npx wrangler d1 execute stablecoin-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name='reserve_sync_state';"
```

Expected: `reserve_sync_state` exists.

### Task 2: Extend live-reserve config and result types

**Files:**
- Modify: `shared/types/index.ts`
- Modify: `shared/lib/reserve-templates.ts`
- Optional create: `shared/lib/live-reserve-types.ts` if the type block gets too large

- [ ] **Step 1: Replace the current minimal `LiveReservesConfig` with a structured contract**

Recommended shape:

```ts
export type LiveReserveSemantics =
  | "collateral-mix"
  | "protocol-reserve"
  | "attestation-mix"
  | "single-asset";

export type LiveReserveInput =
  | { kind: "http-json"; url: string }
  | { kind: "http-html"; url: string }
  | { kind: "indexer"; url: string }
  | { kind: "onchain-evm"; chain: string; rpcMode: "etherscan-proxy" | "alchemy" | "public-rpc" };

export interface LiveReservesConfig {
  adapter: string;
  version: number;
  semantics: LiveReserveSemantics;
  displayUrl?: string;
  breakerScope?: string; // e.g. "infinifi", "liquity-v2-family"
  inputs: {
    primary: LiveReserveInput;
    fallbacks?: LiveReserveInput[];
  };
  params?: Record<string, unknown>; // adapter-specific validated payload
}
```

- [ ] **Step 2: Add a machine-readable reserve presentation/result type**

Recommended addition:

```ts
export type ReservePresentationMode =
  | "live"
  | "live-stale"
  | "curated-fallback"
  | "template-fallback"
  | "unavailable";

export interface ReserveSyncStateView {
  enabled: boolean;
  status: "ok" | "degraded" | "error" | "skipped";
  stale: boolean;
  bootstrap: boolean;
  lastAttemptedAt?: number;
  lastSuccessAt?: number;
  warnings?: string[];
}

export interface ReserveResult {
  reserves: ReserveSlice[];
  estimated: boolean;
  mode: ReservePresentationMode;
  liveAt?: number;
  source?: string;
  displayUrl?: string;
  sync?: ReserveSyncStateView;
}
```

- [ ] **Step 3: Keep static fallback helpers separate from live presentation logic**

Do **not** overload `getReserves()` with live fetch concerns. Instead:
- keep `getReserves(coin)` as the static fallback resolver
- add a separate helper for merging `live snapshot + sync state + static fallback`

### Task 3: Add reserve-sync health types to the shared API contract

**Files:**
- Modify: `shared/types/index.ts`

- [ ] **Step 1: Add a `reserveComposition` block to `StatusResponse`**

Suggested fields:

```ts
reserveComposition: {
  configuredCoins: number;
  freshCoins: number;
  staleCoins: number;
  missingCoins: number;
  degradedCoins: number;
  lastSuccessAt: number | null;
  oldestFreshAgeSec: number | null;
};
```

- [ ] **Step 2: Add schema validation**

Update the Zod schema for the new block so `/status` stays contract-validated on the frontend.

---

## Chunk 2: Worker Persistence And Resolution Layer

**Objective:** Centralize D1 reads/writes so the cron, API, and `/status` all read the same operational truth.

### Task 4: Create live-reserve storage helpers

**Files:**
- Create: `worker/src/lib/live-reserves-store.ts`
- Create: `worker/src/lib/__tests__/live-reserves-store.test.ts`

- [ ] **Step 1: Move `reserve_composition` SQL into a dedicated store module**

Suggested functions:
- `upsertReserveComposition()`
- `upsertReserveSyncState()`
- `getReserveComposition(stablecoinId)`
- `getReserveSyncState(stablecoinId)`
- `listReserveSyncStatesForConfiguredCoins()`
- `computeReserveSyncOverview(now)`

- [ ] **Step 2: Keep operational writes separate**

Write rules:
- update `reserve_sync_state` on **every attempt**
- update `reserve_composition` only on successful live snapshot writes

- [ ] **Step 3: Add resilience tests**

Test:
- successful upsert path
- degraded state with warnings
- failed state with no composition row
- old composition row + failed new attempt

### Task 5: Add a shared worker-side reserve presentation resolver

**Files:**
- Create: `worker/src/lib/reserve-presentation.ts`
- Optional create shared helper: `shared/lib/reserve-presentation.ts`

- [ ] **Step 1: Implement one place that derives presentation mode**

Inputs:
- `StablecoinMeta`
- latest live composition row, if any
- latest sync state row, if any
- current time

Output:
- `ReserveResult`

- [ ] **Step 2: Encode explicit fallback rules**

Recommended precedence:
1. Fresh live snapshot => `mode: "live"`
2. Stale live snapshot with no newer success => `mode: "live-stale"`
3. No usable live snapshot but `meta.reserves` exists => `mode: "curated-fallback"`
4. No curated reserves but template exists => `mode: "template-fallback"`
5. Otherwise => `mode: "unavailable"`

- [ ] **Step 3: Make bootstrap explicit**

If a coin has `liveReservesConfig` but no successful sync yet:
- `sync.bootstrap = true`
- presentation mode falls back to curated/template
- API returns `200`, not `404`, for configured coins

---

## Chunk 3: Adapter Contract Generalization

**Objective:** Make the adapter layer genuinely reusable across API, scrape, indexer, and on-chain reserve families.

### Task 6: Refactor adapter registry to accept full config

**Files:**
- Modify: `worker/src/cron/reserve-adapters/index.ts`
- Optional create: `worker/src/cron/reserve-adapters/types.ts`

- [ ] **Step 1: Replace the current `(url, signal, ctx)` contract**

Recommended contract:

```ts
export interface LiveReserveAdapterContext {
  etherscanApiKey?: string;
  alchemyApiKey?: string;
}

export interface LiveReserveWarning {
  code: string;   // e.g. "unknown-position", "heuristic-risk", "fallback-input-used"
  message: string;
  severity: "info" | "warning";
}

export interface AdapterResult {
  slices: ReserveSlice[];
  warnings?: LiveReserveWarning[];
  metadata?: Record<string, unknown>;
}

type AdapterFn = (
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: LiveReserveAdapterContext,
) => Promise<AdapterResult>;
```

- [ ] **Step 2: Support per-adapter config validation**

Each adapter should export:
- a config validator (prefer `zod`)
- the adapter function
- optional `adapterVersion`

- [ ] **Step 3: Add a slice normalizer**

Create a shared helper in the adapter layer that:
- rejects negative or NaN percentages
- drops zero-value slices
- rounds and normalizes total to 100
- rejects empty result sets unless the adapter explicitly declares them valid

### Task 7: Refactor the InfiniFi adapter to the new contract

**Files:**
- Modify: `worker/src/cron/reserve-adapters/infinifi.ts`
- Modify: `worker/src/cron/reserve-adapters/__tests__/infinifi.test.ts`

- [ ] **Step 1: Move unknown farm handling to warnings**

Instead of raw `unknownFarms: string[]`, return warnings like:
- `unknown-position:farm-name`
- `heuristic-risk-applied:farm-name`

- [ ] **Step 2: Validate config and payload**

Add:
- config schema for InfiniFi
- payload schema or at least defensive shape validation

- [ ] **Step 3: Make warnings operator-useful**

Include stablecoin-specific metadata such as:
- farm count
- unknown farm count
- liquid vs illiquid share

### Task 8: Add an adapter-family pattern for future sources

**Files:**
- Optional create: `worker/src/cron/reserve-adapters/families/`
- Optional create: `worker/src/cron/reserve-adapters/README.md`

- [ ] **Step 1: Create a small README or code comment block**

Document the intended reusable families:
- JSON API
- HTML scrape
- indexer-backed
- Liquity-v1/v2 style on-chain

- [ ] **Step 2: Add one “family template” stub**

Create a thin skeleton file for a future `liquity-family` adapter to prove the new config contract is generalizable even before adding a second live source.

---

## Chunk 4: Cron Truthfulness, Per-Source Circuits, And Progress

**Objective:** Make `sync-live-reserves` report its real health and stop treating all live sources as one failure domain.

### Task 9: Move from one global breaker to per-source/family breakers

**Files:**
- Modify: `worker/src/lib/constants.ts`
- Modify: `worker/src/lib/circuit-breaker.ts`
- Modify: `worker/src/cron/sync-live-reserves.ts`
- Modify: `worker/src/api/health.ts`

- [ ] **Step 1: Stop using the single `CIRCUIT_SOURCE.LIVE_RESERVES` bucket**

Use derived keys such as:
- `live-reserves:infinifi`
- `live-reserves:liquity-v2-family`
- or `live-reserves:${coin.id}` for one-off sources

- [ ] **Step 2: Compute breaker key from config**

Recommended rule:
- use `config.breakerScope` when provided
- otherwise default to `config.adapter`

- [ ] **Step 3: Record circuit outcomes per processed coin**

Inside the coin loop:
- call `shouldAttemptFetch(db, breakerKey)`
- if blocked, mark that coin `skipped`
- after adapter execution, call `recordOutcomeSafe(db, breakerKey, success)`

### Task 10: Make cron status explicit and operator-meaningful

**Files:**
- Modify: `worker/src/cron/sync-live-reserves.ts`
- Modify: `worker/src/cron/__tests__/sync-live-reserves.test.ts`

- [ ] **Step 1: Classify the overall run**

Recommended rules:
- `error` when every configured coin fails or is skipped due to blocker state
- `degraded` when any coin fails, any warning exists, or any breaker is open/skipped
- `ok` only when all configured coins sync cleanly with no warnings

- [ ] **Step 2: Return structured cron metadata**

Include:
- `configured`
- `synced`
- `failed`
- `skipped`
- `warningCount`
- `coinsWithWarnings`
- `coinsWithErrors`
- `breakerKeys`
- `structureVersion`

- [ ] **Step 3: Add progress reporting**

Use `reportProgress()` to expose:
- stage: `load-config`, `sync-coin`, `persist`, `finalize`
- itemsDone/itemsTotal
- message with current coin id
- metadata summary for long-running future expansions

### Task 11: Persist sync state on every path

**Files:**
- Modify: `worker/src/cron/sync-live-reserves.ts`
- Modify: `worker/src/lib/live-reserves-store.ts`

- [ ] **Step 1: Success path**

Write:
- composition row
- sync state row with `ok`

- [ ] **Step 2: Warning/degraded path**

Write:
- composition row if slices are usable
- sync state row with `degraded`

- [ ] **Step 3: Failure/skip path**

Write:
- sync state row with `error` or `skipped`
- do **not** overwrite the last known good composition row

---

## Chunk 5: Reserve API Contract And Frontend Fallback Honesty

**Objective:** Ensure the detail page never silently hides live-reserve failure modes.

### Task 12: Redesign `GET /api/stablecoin-reserves/:id`

**Files:**
- Modify: `worker/src/api/stablecoin-reserves.ts`
- Modify: `worker/src/router.ts`
- Modify: `docs/api-reference.md`
- Modify: `worker/src/api/__tests__/stablecoin-reserves.test.ts`

- [ ] **Step 1: Change API semantics for configured coins**

New rule:
- unknown stablecoin id => `404`
- known coin without `liveReservesConfig` => `404`
- known configured coin => always `200`, with resolved reserve presentation + sync state

- [ ] **Step 2: Return a resolved payload**

Suggested response shape:

```ts
{
  stablecoinId: string;
  mode: "live" | "live-stale" | "curated-fallback" | "template-fallback" | "unavailable";
  reserves: ReserveSlice[];
  estimated: boolean;
  liveAt?: number;
  source?: string;
  displayUrl?: string;
  sync: {
    enabled: true;
    status: "ok" | "degraded" | "error" | "skipped";
    stale: boolean;
    bootstrap: boolean;
    lastAttemptedAt?: number;
    lastSuccessAt?: number;
    warnings?: string[];
  };
}
```

- [ ] **Step 3: Keep cache policy conservative**

Retain a slow cache, but avoid hiding stale sync state forever:
- `public, s-maxage=3600, max-age=300` is acceptable
- if needed, lower `s-maxage` once more live sources exist

### Task 13: Update the client hook and detail view model

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/hooks/use-stablecoin-reserves.ts`
- Modify: `src/hooks/use-stablecoin-detail-view-model.ts`
- Modify: `src/lib/stablecoin-detail-view-model.ts`

- [ ] **Step 1: Stop converting reserve-state absence into silent `null`**

The hook should distinguish:
- no live feature for this coin
- configured but bootstrap/no success yet
- configured with live snapshot
- configured with live error/fallback

- [ ] **Step 2: Pass the resolved payload through the view model**

Avoid rebuilding the mode client-side from partial data. Let the worker provide the resolved state; the client only decides whether to render.

- [ ] **Step 3: Preserve static fallback for non-live coins**

Coins without `liveReservesConfig` should continue to use `getReserves(coin)` locally with no API fetch.

### Task 14: Update the reserve card UI to show explicit modes

**Files:**
- Modify: `src/components/stablecoin-detail/overview-section.tsx`
- Optional create: `src/components/stablecoin-detail/reserve-status-badge.tsx`

- [ ] **Step 1: Render explicit status copy**

Recommended copy cases:
- `live`: “Updated Mar 12, 08:03 UTC”
- `live-stale`: “Live snapshot stale; showing last successful sync from …”
- `curated-fallback`: “Live sync unavailable; showing curated reserve baseline”
- `template-fallback`: “Live sync unavailable; showing estimated classification template”
- `unavailable`: “Reserve composition unavailable”

- [ ] **Step 2: Surface warnings non-alarmingly**

If warnings exist, show a small note like:
- “Operator note: source contained unmapped positions; fallback risk heuristics applied”

- [ ] **Step 3: Add focused UI tests if the area already has coverage**

At minimum, add view-model tests for mode selection and fallback labeling.

---

## Chunk 6: `/status` Coverage And Probe Hardening

**Objective:** Make the reserve-sync job properly covered in `/status` beyond “the cron ran recently”.

### Task 15: Add reserve-sync health computation to `/api/status`

**Files:**
- Modify: `worker/src/api/status.ts`
- Modify: `shared/types/index.ts`
- Modify: `worker/src/api/__tests__/status.test.ts`

- [ ] **Step 1: Compute reserve-sync overview from D1**

Use:
- `TRACKED_STABLECOINS.filter(c => c.liveReservesConfig)`
- `reserve_sync_state`
- `reserve_composition`

- [ ] **Step 2: Add explicit freshness rules**

Recommended defaults for a daily job:
- `fresh` if `last_success_at <= 2 * 86400`
- `stale` if older than that
- `missing` if configured but no success row
- `degraded` if latest sync state is `degraded` even when a fresh snapshot exists

- [ ] **Step 3: Include the new block in response + tests**

Test:
- all fresh
- missing bootstrap row
- fresh but degraded due to warnings
- stale old snapshot
- complete failure

### Task 16: Add a reserve-sync status widget to the page

**Files:**
- Create: `src/components/status/reserve-sync-health.tsx`
- Modify: `src/app/status/client.tsx`
- Optional create: `src/components/status/__tests__/reserve-sync-health.test.tsx`

- [ ] **Step 1: Add a small operator widget**

Show:
- configured count
- fresh / degraded / stale / missing counts
- last successful sync

- [ ] **Step 2: Place it in the Pipeline or Reliability lane**

Recommended placement: `Pipeline`, next to dataset freshness / price-source health.

### Task 17: Add a cron metadata summary for `sync-live-reserves`

**Files:**
- Modify: `src/components/status/cron-metadata-summary.ts`
- Modify: `src/components/__tests__/cron-card.test.tsx` if needed

- [ ] **Step 1: Add a summarizer function**

Render concise lines such as:
- `synced 1/1, failed 0`
- `warnings 2 across iusd-infinifi`
- `skipped 1 due to open circuit`

- [ ] **Step 2: Keep raw metadata in the details block**

The summary should be short, but the full metadata should remain inspectable via the existing `Run metadata` expander.

### Task 18: Make the reserve canary probe bootstrap-aware

**Files:**
- Modify: `shared/lib/api-endpoints.ts`
- Modify: `worker/src/cron/status-self-check.ts`
- Modify: `worker/src/cron/__tests__/status-self-check.test.ts`
- Modify: `worker/src/api/__tests__/router-contract.test.ts`

- [ ] **Step 1: Add probe bootstrap metadata to the endpoint definition**

Recommended addition:

```ts
bootstrapProbe?: {
  kind: "live-reserves-success";
  stablecoinId: "iusd-infinifi";
}
```

- [ ] **Step 2: Extend `isBootstrapCacheMiss()` into a generic bootstrap check**

It should handle:
- cache bootstrap (`503`)
- live-reserve bootstrap (`configured coin has no successful sync yet`)

- [ ] **Step 3: Update router contract expectations**

If the reserve API now returns `200` for configured coins regardless of bootstrap state, tighten the test expectation accordingly.

---

## Chunk 7: Documentation And Source-Copy Updates

**Objective:** Eliminate documentation drift and make the feature’s scope explicit to both operators and users.

### Task 19: Update technical docs

**Files:**
- Modify: `docs/api-reference.md`
- Modify: `docs/worker-infrastructure.md`
- Modify: `docs/status-dashboard.md`
- Modify: `docs/architecture.md`
- Modify: `docs/data-flow-map.md`

- [ ] **Step 1: API docs**

Document:
- new reserve API response contract
- bootstrap vs live vs fallback semantics

- [ ] **Step 2: Worker docs**

Document:
- `reserve_sync_state`
- per-source circuit breakers
- cron status semantics

- [ ] **Step 3: Status docs**

Document:
- reserve-sync widget
- bootstrap-aware probe behavior
- cron metadata summary behavior

### Task 20: Update user-facing product/source docs

**Files:**
- Modify: `docs/about-page.md`
- Modify: `src/app/about/page.tsx`
- Modify: `docs/report-cards.md`
- Modify: `docs/dependency-map.md`

- [ ] **Step 1: About page**

Add protocol/issuer reserve APIs and live reserve composition syncing to the source list and FAQ.

- [ ] **Step 2: Clarify current scope**

Add an explicit note to report-card/dependency docs that curated reserve metadata remains the source for those systems in the current release.

- [ ] **Step 3: Update any inline comments/docstrings that still imply live reserves are generic/authoritative**

This includes comments in the reserve hook and detail view model.

---

## Chunk 8: Testing And Verification

**Objective:** Prove the hardened system works and stays maintainable.

### Task 21: Expand unit/integration coverage

**Files:**
- Modify: `worker/src/cron/__tests__/sync-live-reserves.test.ts`
- Modify: `worker/src/cron/reserve-adapters/__tests__/infinifi.test.ts`
- Modify: `worker/src/api/__tests__/stablecoin-reserves.test.ts`
- Modify: `worker/src/api/__tests__/status.test.ts`
- Modify: `worker/src/cron/__tests__/status-self-check.test.ts`
- Add frontend tests where helpful

- [ ] **Step 1: Cron tests**

Add cases for:
- total failure => `error`
- partial success => `degraded`
- warning-only run => `degraded`
- open circuit skip => `degraded` or `skipped` as designed
- sync-state row written on every path

- [ ] **Step 2: Adapter tests**

Add cases for:
- malformed payload
- zero/negative or NaN slice input rejection
- warning generation for unknown farms

- [ ] **Step 3: API tests**

Add cases for:
- configured coin bootstrap response
- stale live snapshot response
- live snapshot with warnings
- non-configured coin 404

- [ ] **Step 4: Status tests**

Add cases for:
- reserve health counts in `/api/status`
- live reserve cron metadata summary
- bootstrap-aware reserve probe

### Task 22: Run full verification

- [ ] **Step 1: Frontend + shared**

```bash
npm run build
npm run lint
npm test
```

- [ ] **Step 2: Worker**

```bash
cd worker
npx tsc --noEmit
```

- [ ] **Step 3: Focused reserve/status reruns**

```bash
npm test -- \
  worker/src/cron/__tests__/sync-live-reserves.test.ts \
  worker/src/api/__tests__/stablecoin-reserves.test.ts \
  worker/src/api/__tests__/status.test.ts \
  worker/src/cron/__tests__/status-self-check.test.ts \
  worker/src/cron/reserve-adapters/__tests__/infinifi.test.ts
```

Expected: all pass.

---

## Implementation Order

1. Chunk 0: scope freeze
2. Chunk 1: schema + shared contract
3. Chunk 2: store + presentation resolver
4. Chunk 3: adapter contract
5. Chunk 4: cron truthfulness + per-source circuits
6. Chunk 5: reserve API + detail page fallback honesty
7. Chunk 6: `/status` coverage + probes
8. Chunk 7: docs
9. Chunk 8: verification

---

## Risk Notes

- **Biggest compatibility risk:** changing the reserve API from “404 when no live row exists” to “200 with fallback state for configured coins.” Mitigate with explicit tests and doc updates.
- **Biggest operational risk:** introducing `reserve_sync_state` but forgetting to write it on skipped/error paths. Mitigate with dedicated store tests and cron tests.
- **Biggest design risk:** letting `params: Record<string, unknown>` become an untyped dumping ground. Mitigate by requiring adapter-level `zod` validation.
- **Biggest scope-creep risk:** expanding into live-authoritative report-card/dependency logic inside this remediation. Do not do that here.

---

## Follow-Up Project (Separate, Not Part Of This Remediation)

If later desired, create a separate plan for:

- making live reserves authoritative for dependency derivation
- updating report-card collateral scoring to prefer live reserve snapshots when fresh
- exposing aggregated live-reserve datasets for compare/portfolio/dependency map surfaces
- updating `/methodology` if scoring logic changes
