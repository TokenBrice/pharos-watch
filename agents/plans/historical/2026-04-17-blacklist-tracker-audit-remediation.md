# Blacklist Tracker Audit — Remediation + Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the blacklist tracker into a healthy, maintainable foundation by fixing one genuine sync bug (Gnosis BRZ stalled on dRPC block-range cap), cleaning up ~23k stale data rows (legacy `derived` amounts + mixed-case cursors), correcting an event-family mis-reuse across FDUSD/EURI/U, splitting three hot modules, adding SQL-side summary aggregation for scalability, hardening the frontend for non-USD coin display, then expanding coverage to 10 new high-value stablecoins drawn from the top-40 uncovered list.

**Architecture:** Surgical, phase-gated, backward-compatible. The worker cron (`worker/src/cron/sync-blacklist.ts` → `worker/src/cron/blacklist/*.ts`) stays organized around the `CONTRACT_CONFIGS` registry; we split WLFI-specific destroy events out of the shared `USD1_EVENT_FAMILY` so reuse no longer carries dead topics. The summary endpoint (`worker/src/api/blacklist-summary.ts`) drops its unbounded table scan in favour of SQL aggregation. Data cleanup runs as idempotent D1 migrations (0099–0103). Expansion adds 10 new `CONTRACT_CONFIG_SPECS` entries (6 reuse existing families, 4 introduce new families for TrueUSD / SocGen / Frax / Neutrl). No UI redesign; the frontend changes are additive (CSV headers, stat cards wired to new API fields, amount-status badge).

**Tech Stack:** TypeScript, Cloudflare Workers + D1, viem for ABI decoding + keccak, Next.js 16 static export, Vitest.

**Out of scope (deliberate):**
- Removing the legacy `amount` column (REAL precision migration) — current max 18-decimal value in prod is 258,662 RLUSD = ~2.6e5, safely within REAL precision; revisit only if we see precision-loss evidence.
- New methodology family for MNEE's `AccountBlacklisted` / `AccountDelisted` — already deferred in v3.9 changelog.
- RLUSD clawback tracking — needs tx-input classification, not a log event.
- D1 archival / table partitioning — table is 18k rows at ~95 MB, still small.
- Expansion tier 2 (candidates 11–25) — captured in the companion research doc; queue for a follow-up plan after tier 1 lands.
- Frontend redesign beyond the existing component shells.

**Companion research artefacts (do not modify):**
- `agents/plans/_audit-blacklist-no-events.md` — per-coin ABI + events verification for U / FDUSD / BRZ / EURI / USDQ / USDD / AID / TGBP / EURC / BUIDL.
- `agents/plans/_audit-blacklist-top25-candidates.md` — 25 expansion candidates with deployment blocks, topic hashes, and family-reuse classification.

**Phase sequencing constraint (strict):**
Phase 6 MUST run AFTER Phase 3. `BlacklistChartPointSchema` (`shared/types/market.ts:518-522`) builds chart keys from `BLACKLIST_STABLECOINS.map(...)`. Every symbol added in Phase 6 widens that schema. If the chart aggregator emits those keys before the schema is widened, `BlacklistResponseSchema.parse` in the frontend hook throws and the summary page goes blank. Ship the symbol-add and its schema regeneration (via rebuild / type refresh) in the same commit per Phase-6 task, and don't interleave Phase-6 tasks with Phase-3 handler changes.

**Migration commit-order note (SF-11):**
Migrations 0099–0103 are numbered in the order D1 will APPLY them (filename-sorted) but the plan's *commit* order is Phase-1 code → Phase-2 data → Phase-3 efficiency. Tasks 1.2 (0101), 1.6 (0103) appear in Phase-1 commits but land migration files in slots that are numerically higher than Phase-2's 0099/0100/0102. This is safe because D1 applies by filename; execution order is well-defined regardless of commit order. No action required, but reviewers should expect the commit graph to show numbers out of sequence. If preferred, consolidate all 5 migrations into one Phase-2 commit burst; a follow-up cleanup commit can rename them for chronology.

**Live-data baseline (production D1 snapshot 2026-04-17, used in task justifications):**
- 17,897 rows in `blacklist_events` (16,980 public + 917 EURC mirror-zero suppressed).
- 7,198 rows with `amount_source='derived'` (legacy; target for backfill).
- ~15,189 rows with `event_signature=NULL` (pre-v3.2 provenance backfill gap — same cohort as methodology_version='1.0').
- 188 rows `amount_status='permanently_unavailable'` (187 Tron + 1 orphan config_key).
- 5 duplicate mixed-case cursor rows in `blacklist_sync_state`.
- 54 configs total; 26 have at least one event; 28 are empty (confirmed expected per per-coin audit except Gnosis BRZ).
- `gnosis-0x0a06c8354a6cc1a07549a38701eac205942e3ac6` stuck at `last_block=33257602` (startBlock-1); 2 real on-chain events missed.

---

## File Structure

### Modified
- `worker/src/lib/blacklist-contracts.ts` — split `USD1_EVENT_FAMILY` into (a) shared `DUAL_INDEX_FREEZE_EVENT_FAMILY` (just `Freeze`+`Unfreeze`), (b) `WLFI_DESTROY_EVENT_FAMILY` adding the two destroy topics. Reassign FDUSD/EURI **and U** to the freeze-only family (per ABI audit, U's impl lacks destroy events too — keep only USD1 on the WLFI family). Add tier-1 `CONTRACT_CONFIG_SPECS` for expansion. Add minor-gap specs (Polygon USDQ, Arbitrum/Base AID, Base/BSC/Polygon TGBP).
- `shared/lib/classification.ts` — extend `BLACKLIST_CHART_COLORS` (exhaustive `Record<BlacklistStablecoin, string>`) with one hex entry per new symbol added in Phase 6. Without this the TS build fails TS2741 on every Phase-6 commit.
- `worker/src/cron/blacklist/evm-source.ts` — tighten `RPC_LOG_SCAN_WINDOWS.gnosis` to `{ alchemy: 9_000, fallback: 9_000 }`; drop rows whose block timestamps resolved-missing (currently silently accepted); cap decoded `address[]` payloads to a sane max.
- `worker/src/cron/blacklist/tron-source.ts` — remove `TRON_EVENT_NAME_MAP`; use `eventDef.eventType` directly; return `apiError` on TronGrid failures so sync-blacklist can pass it to the circuit breaker. Seed `maxBlock` with `lastTimestampMs` instead of 0.
- `worker/src/cron/blacklist/amount-recovery.ts` — when a row is suppressed as `circle_mirror_zero_balance`, set `amount_status='permanently_unavailable'` so it exits the backfill pool; add composite-index-friendly `WHERE event_type IN (…) AND amount_status IN (…)` predicate ordering.
- `worker/src/cron/blacklist/current-balance-cache.ts` — document (via comment) why destroy events skip the gold-override branch; add a helper so the `fetchBlacklistAssetPriceFromCache` call is made once per config pass instead of per-row inside post-fetch.
- `worker/src/cron/blacklist/post-fetch.ts` — delete the wrapper-only `post-fetch-counters.ts` module; inline the accumulator; replace the per-row filter-clone with a single pass.
- `worker/src/cron/sync-blacklist.ts` — remove import of `processRowsAndAccumulatePostFetchRows` after inlining; add Gnosis (evmChainId 100) to `EVM_BLOCK_TIME`; surface `apiError` on Tron branch.
- `worker/src/cron/blacklist/balance-providers.ts` — add `gnosis: "gnosis"` to `DRPC_NETWORK` so balance enrichment for Gnosis BRZ no longer skips the dRPC tier.
- `worker/src/lib/chain-registry.ts` — change the dRPC-chain loop to stamp `alchemyPrimary: true` when a drpcApiKey is present, so the caller picks the primary scan window (after the window-shrink this no longer regresses; it just keeps semantics explicit).
- `worker/src/api/blacklist-summary.ts` — stop the unbounded `SELECT … FROM blacklist_events` table scan; build the summary from three targeted SQL aggregates + the existing `blacklist_current_balances` snapshot loader. Add `perCoinBlacklistCounts` to the response.
- `worker/src/api/blacklist.ts` — no behaviour change; wire the `BLACKLIST_STABLECOINS` enum additions through.
- `shared/types/market.ts` — append the 10 new expansion symbols + the 3 minor-gap-related symbols to `BLACKLIST_STABLECOINS`; add `perCoinBlacklistCounts: Record<BlacklistStablecoin, number>` to `BlacklistSummaryStatsSchema`; remove unused `"legacy_migration"` from the `BlacklistAmountSource` union.
- `shared/lib/blacklist.ts` — extend `BLACKLIST_PRICE_ASSET_IDS` with new non-USD additions (e.g. EURCV, EURR, AEUR, VEUR if tier 1 adds them).
- `shared/lib/blacklist-tracker-version.ts` — add methodology version entries `v3.94` (remediation) and `v3.95` (expansion tier 1).
- `src/hooks/use-blacklist-events.ts` — pick up the new `perCoinBlacklistCounts` field; no API change.
- `src/components/blacklist-stats.tsx` — replace the hardcoded USDC/USDT/gold cards with a data-driven "Top blacklisted by coin" strip; keep the three existing cards behind a feature flag for launch-week rollback.
- `src/components/blacklist-table.tsx` — CSV export emits `Amount (Native)`, `Amount Unit`, `Amount (USD at event)`, and `Amount Status` columns; render an inline amount-status badge for non-resolved rows.
- `src/app/blacklist/view-model.test.tsx` — add test cases for clamped-page-beyond-total, zero-total range bounds, and filter-triggered page reset.
- `docs/blacklist-tracker.md` — update cron coverage list, env, known-gotchas, and v3.94/v3.95 entries.
- `docs/blacklist-tracker-timeline.md` — add v3.94/v3.95 rows.

### Created
- `worker/migrations/0099_blacklist_sync_state_dedup.sql` — delete the 5 duplicate mixed-case keys.
- `worker/migrations/0100_blacklist_reset_derived_amounts.sql` — reset the 7,198 `derived` rows to `recoverable_pending` so the backfill pass re-attempts them with a proper `amount_source`.
- `worker/migrations/0101_blacklist_gnosis_cursor_reseed.sql` — set Gnosis BRZ `last_block` to `33257602` (already there but force via `INSERT OR REPLACE` so the fix is deterministic) and document it.
- `worker/migrations/0102_blacklist_backfill_indexes.sql` — add composite indexes for the backfill query and the public API query.
- `worker/migrations/0103_blacklist_mirror_zero_permanently_unavailable.sql` — set `amount_status='permanently_unavailable'` on the 917 existing EURC mirror-zero rows so they match new code semantics.
- `worker/src/cron/blacklist/__tests__/post-fetch.test.ts` — covers the inlined accumulator path.
- `worker/src/cron/blacklist/__tests__/evm-source-gnosis.test.ts` — regression test for the Gnosis scan window.
- `worker/src/cron/blacklist/__tests__/tron-source-error-propagation.test.ts` — regression test that TronGrid HTTP errors now surface `apiError=true`.
- `worker/src/api/__tests__/blacklist-summary.test.ts` — new integration tests for SQL aggregation parity.
- `src/components/__tests__/blacklist-stats.test.tsx` — render test for the data-driven stats strip.

### Deleted
- `worker/src/cron/blacklist/post-fetch-counters.ts` — subsumed by inlined accumulator in `post-fetch.ts`.
- `worker/src/cron/blacklist/__tests__/post-fetch-counters.test.ts` (if any) — coverage migrates to `post-fetch.test.ts`.

---

## Phase 0 — Preparation & Baseline

### Task 0.1: Snapshot production baseline

**Why:** We're about to run backfill migrations that rewrite 7k+ rows; a D1 time-travel bookmark is the cheap rollback. The memory note on D1 reminds us: "Time Travel restore via `wrangler d1 time-travel restore`" is strongly preferred over SQL re-import.

**Files:** (ops only — no code changes)

- [ ] **Step 1: Capture time-travel bookmark**

```bash
cd worker
npx wrangler d1 time-travel info stablecoin-db
# copy the latest bookmark-id into this plan's PR description
```

- [ ] **Step 2: Export 3 diagnostic CSVs for diff'ing post-migration**

```bash
npx wrangler d1 execute stablecoin-db --remote \
  --command "SELECT stablecoin, chain_name, amount_source, COUNT(*) n FROM blacklist_events GROUP BY 1,2,3 ORDER BY 1,2,3" \
  --json > /tmp/blacklist-baseline-source.json

npx wrangler d1 execute stablecoin-db --remote \
  --command "SELECT config_key, last_block FROM blacklist_sync_state ORDER BY config_key" \
  --json > /tmp/blacklist-baseline-cursors.json

npx wrangler d1 execute stablecoin-db --remote \
  --command "SELECT amount_status, COUNT(*) n FROM blacklist_events GROUP BY 1" \
  --json > /tmp/blacklist-baseline-status.json
```

- [ ] **Step 3: Commit an ops-only commit with a link to the CSVs in the PR body**

No file changes; skip the commit if the user prefers baseline-in-PR-body only.

---

## Phase 1 — Worker Code Correctness

### Task 1.1: Fix Gnosis dRPC block-range cap (BLOCKER — 2 real events missed)

**Why:** `RPC_LOG_SCAN_WINDOWS.gnosis = { alchemy: 250_000, fallback: 50_000 }` but dRPC's free tier rejects any `eth_getLogs` range wider than **10,000 blocks**. Because Gnosis has no Alchemy endpoint in `ALCHEMY_CHAINS`, the worker uses dRPC (primary) + public RPC (fallback). Every run fails, `apiError=true`, the cursor never advances, and the 2 real BRZ `Blacklisted` events (Gnosis blocks 45229172 and 45229396) stay missed for ~12.5M blocks. Cursor snapshot confirms `last_block=33257602` (= startBlock-1).

**Files:**
- Modify: `worker/src/cron/blacklist/evm-source.ts:31-37`
- Modify: `worker/src/cron/blacklist/balance-providers.ts:19-27` (add gnosis to `DRPC_NETWORK`)
- Modify: `worker/src/cron/sync-blacklist.ts:38-46` (add Gnosis to `EVM_BLOCK_TIME`)
- Test: `worker/src/cron/blacklist/__tests__/evm-source-gnosis.test.ts`

- [ ] **Step 1: Export `RPC_LOG_SCAN_WINDOWS` and shrink Gnosis windows (code lands before the test so the import resolves)**

Edit `worker/src/cron/blacklist/evm-source.ts:31-37`:

```typescript
// Before:
const RPC_LOG_SCAN_WINDOWS: Record<string, { alchemy: number; fallback: number }> = {
  base: { alchemy: 500_000, fallback: 50_000 },
  optimism: { alchemy: 500_000, fallback: 50_000 },
  avalanche: { alchemy: 250_000, fallback: 2_000 },
  bsc: { alchemy: 250_000, fallback: 50_000 },
  gnosis: { alchemy: 250_000, fallback: 50_000 },
};

// After:
/** Per-chain `eth_getLogs` windows. Gnosis is capped at 9_000 because dRPC's free
 *  tier rejects any range > 10_000 blocks (verified 2026-04-17). */
export const RPC_LOG_SCAN_WINDOWS: Record<string, { alchemy: number; fallback: number }> = {
  base:      { alchemy: 500_000, fallback: 50_000 },
  optimism:  { alchemy: 500_000, fallback: 50_000 },
  avalanche: { alchemy: 250_000, fallback: 2_000 },
  bsc:       { alchemy: 250_000, fallback: 50_000 },
  gnosis:    { alchemy: 9_000,   fallback: 9_000 },
};
```

- [ ] **Step 2: Write regression test that reads the exported value**

Create `worker/src/cron/blacklist/__tests__/evm-source-gnosis.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { RPC_LOG_SCAN_WINDOWS } from "../evm-source";

// Regression guard: dRPC free tier rejects eth_getLogs ranges > 10_000 blocks with
// "ranges over 10000 blocks are not supported on freetier". Both windows for Gnosis
// must stay ≤ 10_000 so the sync can make forward progress.
describe("RPC_LOG_SCAN_WINDOWS.gnosis", () => {
  it("keeps both scan windows within dRPC free-tier cap", () => {
    expect(RPC_LOG_SCAN_WINDOWS.gnosis.alchemy).toBeLessThanOrEqual(10_000);
    expect(RPC_LOG_SCAN_WINDOWS.gnosis.fallback).toBeLessThanOrEqual(10_000);
  });
});
```

- [ ] **Step 3: Run the new test to confirm it passes**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/evm-source-gnosis.test.ts
```

Expected: 1 passed.

- [ ] **Step 4: Add Gnosis to `DRPC_NETWORK` so balance enrichment uses dRPC first**

Edit `worker/src/cron/blacklist/balance-providers.ts:19-27`:

```typescript
// Before:
const DRPC_NETWORK: Record<string, string> = {
  ethereum: "ethereum",
  arbitrum: "arbitrum",
  base: "base",
  optimism: "optimism",
  polygon: "polygon",
  avalanche: "avalanche",
  bsc: "bsc",
};

// After:
const DRPC_NETWORK: Record<string, string> = {
  ethereum: "ethereum",
  arbitrum: "arbitrum",
  base: "base",
  optimism: "optimism",
  polygon: "polygon",
  avalanche: "avalanche",
  bsc: "bsc",
  gnosis: "gnosis",
};
```

- [ ] **Step 5: Add Gnosis to `EVM_BLOCK_TIME` for correct safety-margin math**

Edit `worker/src/cron/sync-blacklist.ts:38-46`:

```typescript
// Before:
const EVM_BLOCK_TIME: Record<number, number> = {
  1: 12, // Ethereum
  42161: 0.25, // Arbitrum
  8453: 2, // Base
  10: 2, // Optimism
  137: 2, // Polygon
  43114: 2, // Avalanche
  56: 3, // BSC
};

// After:
const EVM_BLOCK_TIME: Record<number, number> = {
  1: 12,       // Ethereum
  42161: 0.25, // Arbitrum
  8453: 2,     // Base
  10: 2,       // Optimism
  137: 2,      // Polygon
  43114: 2,    // Avalanche
  56: 3,       // BSC
  100: 5,      // Gnosis
};
```

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/blacklist/evm-source.ts \
        worker/src/cron/blacklist/balance-providers.ts \
        worker/src/cron/sync-blacklist.ts \
        worker/src/cron/blacklist/__tests__/evm-source-gnosis.test.ts
git commit -m "fix(blacklist): cap Gnosis scan windows to dRPC free-tier limit

RPC_LOG_SCAN_WINDOWS.gnosis was 50k/250k blocks but dRPC's free tier
rejects any eth_getLogs range >10k blocks. Cursor for Gnosis BRZ has
been stuck at startBlock-1 for ~12.5M blocks and missed two on-chain
Blacklisted events. Cap both windows at 9_000. Also register Gnosis in
DRPC_NETWORK and EVM_BLOCK_TIME so balance enrichment + safety margin
work correctly."
```

---

### Task 1.2: Migration 0101 — trigger Gnosis BRZ backfill

**Why:** Even after the scan-window fix lands, the cron needs to actually re-scan from startBlock (33257603). The current cursor `last_block=33257602` is correct — `fromBlock = lastBlock + 1 = 33257603`. The migration is *documentary*: force the value to 33257602 so the state is deterministic post-fix, and add a comment explaining the intent.

**Files:**
- Create: `worker/migrations/0101_blacklist_gnosis_cursor_reseed.sql`
- Modify: `worker/migrations/MANIFEST.md` (append row)

- [ ] **Step 1: Create the migration**

```sql
-- rollout-safety: backward-compatible (cursor value already at this block)
-- 0101: After migration 0099 removes duplicate mixed-case sync_state rows and
-- Task 1.1 shrinks Gnosis scan windows to ≤9k blocks, ensure the Gnosis BRZ
-- cursor points at startBlock-1 so the next hourly sync picks up the 2 missed
-- events (Gnosis blocks 45229172 and 45229396).

INSERT INTO blacklist_sync_state (config_key, last_block)
VALUES ('gnosis-0x0a06c8354a6cc1a07549a38701eac205942e3ac6', 33257602)
ON CONFLICT(config_key) DO UPDATE SET last_block = MIN(
  blacklist_sync_state.last_block,
  excluded.last_block
);
```

- [ ] **Step 2: Append row to `worker/migrations/MANIFEST.md`**

| 0101     | `0101_blacklist_gnosis_cursor_reseed.sql`  | Reseed Gnosis BRZ cursor to startBlock-1 so next sync picks up previously-missed events |

- [ ] **Step 3: Apply locally and commit**

```bash
cd worker
npx wrangler d1 migrations apply stablecoin-db --local  # verify
git add worker/migrations/0101_blacklist_gnosis_cursor_reseed.sql worker/migrations/MANIFEST.md
git commit -m "chore(blacklist): migration 0101 reseed Gnosis BRZ cursor"
```

---

### Task 1.3: Split `USD1_EVENT_FAMILY` so FDUSD/EURI don't inherit WLFI destroys

**Why:** `USD1_EVENT_FAMILY` currently bundles `Freeze(address,address)` + `Unfreeze` *plus* two WLFI-specific destroy events (`FrozenAccountDrained`, `FrozenFundsReallocated`). FDUSD and EURI reuse this family — the extra topics never match their contracts, so today the only cost is a few wasted topic-hash iterations per run, but it is semantically wrong and a trap for future maintainers. U also reuses it; per the ABI audit U's implementation is byte-identical to FDUSD (only Freeze/Unfreeze) so it goes with the freeze-only family too.

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts` (lines 229-272 and 573-592)

- [ ] **Step 1: Extract the freeze-only family**

Edit `worker/src/lib/blacklist-contracts.ts:237`:

```typescript
// Before:
const USD1_EVENT_FAMILY = defineEventFamily("wlfi-freeze", [
  {
    signature: "Freeze(address,address)",
    topicHash: USD1_FREEZE_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
    addressTopicIndex: 2,
    tronResultKey: "account",
  },
  {
    signature: "Unfreeze(address,address)",
    topicHash: USD1_UNFREEZE_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
    addressTopicIndex: 2,
    tronResultKey: "account",
  },
  {
    signature: "FrozenAccountDrained(address,address,uint256)",
    // ... (4 fields)
  },
  {
    signature: "FrozenFundsReallocated(address,address,address,uint256)",
    // ... (4 fields)
  },
]);

// After — split into freeze-only + WLFI-additions:
const DUAL_INDEX_FREEZE_EVENT_FAMILY = defineEventFamily("dual-index-freeze", [
  {
    signature: "Freeze(address,address)",
    topicHash: USD1_FREEZE_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
    addressTopicIndex: 2,
    tronResultKey: "account",
  },
  {
    signature: "Unfreeze(address,address)",
    topicHash: USD1_UNFREEZE_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
    addressTopicIndex: 2,
    tronResultKey: "account",
  },
]);

/** WLFI-specific destroy events that live only on the USD1/U contracts, not on
 * shared dual-index-freeze implementations (FDUSD, EURI). */
const WLFI_FREEZE_DESTROY_EVENTS: readonly BlacklistEventDef[] = [
  {
    signature: "FrozenAccountDrained(address,address,uint256)",
    topicHash: WLFI_FROZEN_DRAINED_TOPIC,
    eventType: "destroy",
    hasAmount: true,
    addressTopicIndex: 2,
    amountDataIndex: 0,
    tronResultKey: "account",
  },
  {
    signature: "FrozenFundsReallocated(address,address,address,uint256)",
    topicHash: WLFI_FROZEN_REALLOCATED_TOPIC,
    eventType: "destroy",
    hasAmount: true,
    addressTopicIndex: 2,
    amountDataIndex: 0,
    tronResultKey: "account",
  },
];

const USD1_EVENT_FAMILY = defineEventFamily("wlfi-freeze-and-destroy", [
  ...DUAL_INDEX_FREEZE_EVENT_FAMILY.events,
  ...WLFI_FREEZE_DESTROY_EVENTS,
]);
```

- [ ] **Step 2: Reassign FDUSD, EURI, AND U to the freeze-only family**

Edit `worker/src/lib/blacklist-contracts.ts` — all three reuse `DUAL_INDEX_FREEZE_EVENT_FAMILY.events`. Per the ABI audit (`_audit-blacklist-no-events.md` §U), U's impl at `0xbef21313c69c009fd7d9510a8d3a481a32473dfc` defines only `Freeze(address,address)` + `Unfreeze(address,address)` — it shouldn't carry the WLFI destroy topics either. Only USD1 stays on the full WLFI family.

```typescript
// Before:
{ chain: ETHEREUM, stablecoinId: "fdusd-first-digital", stablecoin: "FDUSD", startBlock: 17_144_262, events: USD1_EVENT_FAMILY.events },
{ chain: BSC,      stablecoinId: "fdusd-first-digital", stablecoin: "FDUSD", startBlock: 27_850_220, events: USD1_EVENT_FAMILY.events },
{ chain: ARBITRUM, stablecoinId: "fdusd-first-digital", stablecoin: "FDUSD", startBlock: 336_278_229, events: USD1_EVENT_FAMILY.events },
{ chain: ETHEREUM, stablecoinId: "euri-banking-circle", stablecoin: "EURI", startBlock: 20_217_556, events: USD1_EVENT_FAMILY.events },
{ chain: BSC,      stablecoinId: "euri-banking-circle", stablecoin: "EURI", startBlock: 40_115_386, events: USD1_EVENT_FAMILY.events },
{ chain: ETHEREUM, stablecoinId: "u-united-stables",    startBlock: 24_030_193,  events: USD1_EVENT_FAMILY.events },
{ chain: BSC,      stablecoinId: "u-united-stables",    startBlock: 71_922_111,  events: USD1_EVENT_FAMILY.events },

// After:
{ chain: ETHEREUM, stablecoinId: "fdusd-first-digital", stablecoin: "FDUSD", startBlock: 17_144_262,  events: DUAL_INDEX_FREEZE_EVENT_FAMILY.events },
{ chain: BSC,      stablecoinId: "fdusd-first-digital", stablecoin: "FDUSD", startBlock: 27_850_220,  events: DUAL_INDEX_FREEZE_EVENT_FAMILY.events },
{ chain: ARBITRUM, stablecoinId: "fdusd-first-digital", stablecoin: "FDUSD", startBlock: 336_278_229, events: DUAL_INDEX_FREEZE_EVENT_FAMILY.events },
{ chain: ETHEREUM, stablecoinId: "euri-banking-circle", stablecoin: "EURI", startBlock: 20_217_556,  events: DUAL_INDEX_FREEZE_EVENT_FAMILY.events },
{ chain: BSC,      stablecoinId: "euri-banking-circle", stablecoin: "EURI", startBlock: 40_115_386,  events: DUAL_INDEX_FREEZE_EVENT_FAMILY.events },
{ chain: ETHEREUM, stablecoinId: "u-united-stables",    startBlock: 24_030_193,                      events: DUAL_INDEX_FREEZE_EVENT_FAMILY.events },
{ chain: BSC,      stablecoinId: "u-united-stables",    startBlock: 71_922_111,                      events: DUAL_INDEX_FREEZE_EVENT_FAMILY.events },

// USD1 only — the sole consumer of WLFI destroys:
{ chain: ETHEREUM, stablecoinId: "usd1-world-liberty-financial", startBlock: 21_720_503, events: USD1_EVENT_FAMILY.events },
{ chain: BSC,      stablecoinId: "usd1-world-liberty-financial", startBlock: 46_151_905, events: USD1_EVENT_FAMILY.events },
{ chain: TRON,     stablecoinId: "usd1-world-liberty-financial",                          events: USD1_EVENT_FAMILY.events },
```

Document the split with a code comment above `USD1_EVENT_FAMILY`:

```typescript
  // USD1 (WLFI) is the sole consumer of the full freeze+destroy family. FDUSD,
  // EURI, and U reuse only the freeze half (DUAL_INDEX_FREEZE_EVENT_FAMILY)
  // because their implementations don't emit FrozenAccountDrained or
  // FrozenFundsReallocated.
```

- [ ] **Step 3: Add a regression test asserting the split**

Add to `worker/src/cron/blacklist/__tests__/blacklist-contracts.test.ts` (create if absent):

```typescript
import { describe, expect, it } from "vitest";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";

describe("Dual-index freeze family split", () => {
  it("FDUSD, EURI, U have only the 2 freeze events — not WLFI destroys", () => {
    const splitCoins = ["FDUSD", "EURI", "U"] as const;
    const wlfiDestroyTopics = new Set([
      "FrozenAccountDrained(address,address,uint256)",
      "FrozenFundsReallocated(address,address,address,uint256)",
    ]);
    for (const coin of splitCoins) {
      const cfgs = CONTRACT_CONFIGS.filter((c) => c.stablecoin === coin);
      expect(cfgs.length).toBeGreaterThan(0);
      for (const cfg of cfgs) {
        for (const def of cfg.events) {
          expect(wlfiDestroyTopics.has(def.signature)).toBe(false);
        }
        // Exactly 2 events (Freeze + Unfreeze):
        expect(cfg.events.length).toBe(2);
      }
    }
  });

  it("USD1 still carries the full WLFI freeze+destroy family (4 events)", () => {
    const cfgs = CONTRACT_CONFIGS.filter((c) => c.stablecoin === "USD1");
    expect(cfgs.length).toBeGreaterThan(0);
    for (const cfg of cfgs) {
      expect(cfg.events.length).toBe(4);
      expect(cfg.events.some((e) => e.signature.startsWith("FrozenAccountDrained"))).toBe(true);
    }
  });
});
```

Also run the existing tests; anywhere a FDUSD/EURI test fixture passes `USD1_EVENT_FAMILY`, replace with `DUAL_INDEX_FREEZE_EVENT_FAMILY`.

```bash
cd worker && grep -rn "USD1_EVENT_FAMILY" src/cron/blacklist/__tests__/
```

- [ ] **Step 4: Type-check + test**

```bash
cd worker && npx tsc --noEmit
cd worker && npx vitest run src/cron/blacklist/__tests__/
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/blacklist-contracts.ts
git commit -m "refactor(blacklist): split dual-index-freeze family from WLFI destroys

FDUSD and EURI contracts do not emit FrozenAccountDrained or
FrozenFundsReallocated, so they should not inherit those topics via
USD1_EVENT_FAMILY. Introduce DUAL_INDEX_FREEZE_EVENT_FAMILY containing
just Freeze/Unfreeze; keep USD1 + U on the full family."
```

---

### Task 1.4: Derive Tron event-type from `eventDef`, drop `TRON_EVENT_NAME_MAP`

**Why:** `TRON_EVENT_NAME_MAP` in `tron-source.ts:33-39` hardcodes 5 event names → event types. Any new Tron-aware event (e.g. MNEE-on-Tron's `FundsConfiscated` in the future) silently fails to parse without a code change here. The `eventDef` we already matched via `getBlacklistEventBySignature()` already carries the correct `eventType`; we should just read it directly.

**Files:**
- Modify: `worker/src/cron/blacklist/tron-source.ts:33-50`

- [ ] **Step 1: Remove the map and simplify**

Edit `worker/src/cron/blacklist/tron-source.ts:33-50`:

```typescript
// Before:
const TRON_EVENT_NAME_MAP: Record<string, BlacklistEventType> = {
  AddedBlackList: "blacklist",
  RemovedBlackList: "unblacklist",
  DestroyedBlackFunds: "destroy",
  Freeze: "blacklist",
  Unfreeze: "unblacklist",
};

// ...

export function parseTronEvent(config: ContractEventConfig, evt: TronEventResult): BlacklistRow | null {
  const eventDef = getBlacklistEventBySignature(config, evt.event_name);
  const eventType = TRON_EVENT_NAME_MAP[evt.event_name];
  if (!eventDef || !eventType) return null;
  // ...

// After:
export function parseTronEvent(config: ContractEventConfig, evt: TronEventResult): BlacklistRow | null {
  const eventDef = getBlacklistEventBySignature(config, evt.event_name);
  if (!eventDef) return null;
  const eventType = eventDef.eventType;
  // ...
```

- [ ] **Step 2: Remove the now-unused `BlacklistEventType` import**

Check `tron-source.ts:1` — if the import is no longer used:

```typescript
// Remove: import type { BlacklistEventType } from "@shared/types/market";
```

- [ ] **Step 3: Update existing test, if any**

```bash
cd worker && grep -n "TRON_EVENT_NAME_MAP" src/cron/blacklist/__tests__/
```

Remove any test that asserts on the hardcoded map.

- [ ] **Step 4: Type-check + run Tron tests**

```bash
cd worker && npx tsc --noEmit
cd worker && npx vitest run src/cron/blacklist/__tests__/tron-source.test.ts
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/blacklist/tron-source.ts
git commit -m "refactor(blacklist): derive Tron event-type from eventDef

Drops the hardcoded 5-entry TRON_EVENT_NAME_MAP. The matching eventDef
already carries the canonical eventType, so no lookup table is needed.
Future Tron-aware event families will now register once in the config
registry and automatically parse."
```

---

### Task 1.5: Propagate TronGrid failures to the circuit breaker

**Why:** `fetchTronEventsIncremental` breaks out of its loop on any non-success response but never surfaces the failure. Sync-blacklist then passes `!result.apiError` (always `true`) to `recordOutcomeSafe(CIRCUIT_SOURCE.TRONGRID)`, so genuine outages register as healthy runs and the circuit breaker never opens. Memory rule: "fetchers must propagate failures to circuit breakers."

**Files:**
- Modify: `worker/src/cron/blacklist/tron-source.ts:97-166`
- Modify: `worker/src/cron/sync-blacklist.ts:214-258`
- Test: `worker/src/cron/blacklist/__tests__/tron-source-error-propagation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/src/cron/blacklist/__tests__/tron-source-error-propagation.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchTronEventsIncremental } from "../tron-source";
import { createBudget, createRateLimiter } from "../../../lib/evm-logs";

const configStub = {
  configKey: "tron-test",
  chain: { chainId: "tron", chainName: "Tron", evmChainId: null, explorerUrl: "https://tronscan.org", type: "tron" as const },
  stablecoinId: "usdt-tether",
  stablecoin: "USDT" as const,
  contractAddress: "TRX...",
  decimals: 6,
  events: [
    { signature: "AddedBlackList(address)", topicHash: "0x0", eventType: "blacklist" as const, hasAmount: false },
  ],
};

describe("fetchTronEventsIncremental error propagation", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it("returns apiError=true when TronGrid responds with HTTP 500", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("server error", { status: 500 }),
    );
    const result = await fetchTronEventsIncremental(
      configStub,
      null,
      0,
      Date.now() + 60_000,
      createRateLimiter(3),
      createBudget(100),
      undefined,
    );
    expect(result.apiError).toBe(true);
    expect(result.rows).toHaveLength(0);
  });

  it("returns apiError=true when TronGrid returns success=false", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, data: [] }), { status: 200 }),
    );
    const result = await fetchTronEventsIncremental(
      configStub,
      null,
      0,
      Date.now() + 60_000,
      createRateLimiter(3),
      createBudget(100),
      undefined,
    );
    expect(result.apiError).toBe(true);
  });

  it("returns apiError=false on success", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }),
    );
    const result = await fetchTronEventsIncremental(
      configStub,
      null,
      0,
      Date.now() + 60_000,
      createRateLimiter(3),
      createBudget(100),
      undefined,
    );
    expect(result.apiError).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/tron-source-error-propagation.test.ts
```

Expected: FAIL — current result has no `apiError` field.

- [ ] **Step 3: Extend the return type and record failures**

Edit `worker/src/cron/blacklist/tron-source.ts:97-166`:

```typescript
// Before signature:
export async function fetchTronEventsIncremental(
  config: ContractEventConfig,
  apiKey: string | null,
  lastTimestampMs: number,
  deadlineMs: number,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<{ rows: BlacklistRow[]; maxBlock: number; incomplete: boolean }> {

// After:
export async function fetchTronEventsIncremental(
  config: ContractEventConfig,
  apiKey: string | null,
  lastTimestampMs: number,
  deadlineMs: number,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<{ rows: BlacklistRow[]; maxBlock: number; incomplete: boolean; apiError: boolean }> {
  let apiError = false;
  // ...
```

Inside the existing loop, wherever we currently `break`, set `apiError = true`:

```typescript
// Inside the `while (url)` loop, where res was non-ok:
if (!res.ok) {
  await cancelResponseBodyQuietly(res);
  apiError = true;
  return null;
}

// Where parse fails:
if (!parsed.success) {
  console.warn("[blacklist] TronGrid response validation failed:", parsed.error.message);
  apiError = true;
  return null;
}

// After the rate-limited await:
if (!json?.success || !Array.isArray(json.data)) {
  apiError = true;
  break;
}
```

At the bottom:

```typescript
// Before: return { rows, maxBlock, incomplete };
return { rows, maxBlock: maxBlock || lastTimestampMs, incomplete, apiError };
```

Note the `maxBlock || lastTimestampMs` also fixes Task 1.8 (Tron maxBlock initial value); keep the two fixes together.

- [ ] **Step 4: Widen the local result-shape union in `sync-blacklist.ts`**

Edit `worker/src/cron/sync-blacklist.ts:204-212` (the local union typed `apiError?: boolean`). After Task 1.5 this field is no longer optional from the Tron branch. Change the local type so both branches agree:

```typescript
// Before:
let result: {
  rows: BlacklistRow[];
  maxBlock: number;
  apiError?: boolean;
  chainHead?: number | null;
  usedRpcLogs?: boolean;
  scannedToBlock?: number | null;
  incomplete?: boolean;
};

// After:
let result: {
  rows: BlacklistRow[];
  maxBlock: number;
  apiError: boolean;           // required on both branches now
  chainHead?: number | null;
  usedRpcLogs?: boolean;
  scannedToBlock?: number | null;
  incomplete?: boolean;
};
```

Without this change, `!result.apiError` evaluates to `true` whenever the Tron call didn't explicitly set the field — the plan's whole point of this task.

- [ ] **Step 5: Thread `apiError` through sync-blacklist.ts**

Edit `worker/src/cron/sync-blacklist.ts:214-258`. The call site already destructures `result.apiError` from the EVM branch; extend to Tron:

```typescript
// In the Tron branch, after `result = await fetchTronEventsIncremental(...)`:
await recordOutcomeSafe(db, CIRCUIT_SOURCE.TRONGRID, !result.apiError);
if (result.apiError) {
  apiErrors++;
  recordApiErrorConfig(configKey, config.stablecoin, config.chain.chainId, "trongrid-failed");
}
```

(The current line `await recordOutcomeSafe(db, CIRCUIT_SOURCE.TRONGRID, !result.apiError)` already exists at line 224 — the new field makes it actually fire when things break.)

**Fail-path taxonomy** (SF-2) — all six `fetchTronEventsIncremental` exit paths, mapped:

| Condition | apiError? |
|---|---|
| `throwIfAborted` throws | n/a (propagates) |
| `runtimeBudgetReached(deadlineMs)` true | **false** — sets `incomplete`, not a failure |
| `budgetExhausted(budget)` true | **false** — same |
| `!res.ok` (HTTP non-2xx) | **true** |
| `parsed.success === false` (Zod validation fail) | **true** |
| `!json?.success \|\| !Array.isArray(json.data)` | **true** |

- [ ] **Step 6: Re-run test — expect green**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/tron-source-error-propagation.test.ts
```

Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
git add worker/src/cron/blacklist/tron-source.ts \
        worker/src/cron/sync-blacklist.ts \
        worker/src/cron/blacklist/__tests__/tron-source-error-propagation.test.ts
git commit -m "fix(blacklist): propagate TronGrid failures to the circuit breaker

fetchTronEventsIncremental silently swallowed non-ok responses and
success=false payloads, which registered as healthy to the circuit
breaker. Return apiError explicitly and let sync-blacklist count it."
```

---

### Task 1.6: Cap EURC mirror-zero rows to `permanently_unavailable`

**Why:** The `shouldSuppressAsMirrorZero()` filter stamps `suppression_reason='circle_mirror_zero_balance'` on EURC blacklist/unblacklist rows whose event-time amount is 0. Today those rows still have `amount_status='resolved'` (because amount != null). If a future code path loosens the backfill WHERE clause, they could re-enter recovery. Belt-and-suspenders: mark them `permanently_unavailable` at insert time so the status itself excludes them. Also covers the 917 existing rows via migration.

**Files:**
- Modify: `worker/src/cron/blacklist/shared.ts:5-15`
- Modify: `worker/src/cron/blacklist/post-fetch.ts:105-109`
- Modify: `worker/src/cron/blacklist/amount-recovery.ts:412-445`
- Create: `worker/migrations/0103_blacklist_mirror_zero_permanently_unavailable.sql`

- [ ] **Step 1: Update insert-time stamping in `post-fetch.ts`**

Edit `worker/src/cron/blacklist/post-fetch.ts:105-109`:

```typescript
// Before:
  for (const row of newRows) {
    if (shouldSuppressAsMirrorZero(row.stablecoin, row.event_type, row.amount_native)) {
      row.suppression_reason = "circle_mirror_zero_balance";
    }
  }

// After:
  for (const row of newRows) {
    if (shouldSuppressAsMirrorZero(row.stablecoin, row.event_type, row.amount_native)) {
      row.suppression_reason = "circle_mirror_zero_balance";
      row.amount_status = "permanently_unavailable";
    }
  }
```

- [ ] **Step 2: Update backfill to match (refresh suppression_reason + status together)**

Edit `worker/src/cron/blacklist/amount-recovery.ts:412-445` (the `if (amount != null)` branch of `backfillAmounts`). The status write must be idempotent: once a row is `permanently_unavailable` we never walk it back.

```typescript
// Compute the target status as a local variable; bind it once. This avoids the
// CASE-WHEN trap where a later ELSE-branch write demotes a locked row.
const targetStatus = shouldSuppress ? "permanently_unavailable" : amountStatus;
stmts.push(
  db.prepare(
    `UPDATE blacklist_events
     SET amount = ?,
         amount_native = ?,
         amount_usd_at_event = ?,
         amount_source = ?,
         amount_status = CASE WHEN amount_status = 'permanently_unavailable' THEN amount_status ELSE ? END,
         suppression_reason = COALESCE(suppression_reason, ?),
         contract_address = COALESCE(contract_address, ?),
         config_key = COALESCE(config_key, ?),
         amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
         amount_last_attempted_at = ?,
         amount_last_error_class = ?,
         amount_last_provider = ?
     WHERE id = ?`,
  ).bind(
    amount,
    amount,
    computeBlacklistAmountUsdAtEvent(config.stablecoin, amount, assetPriceUsd),
    amountSource,
    targetStatus,
    shouldSuppress ? "circle_mirror_zero_balance" : null,
    config.contractAddress,
    config.configKey,
    attemptAt,
    lastErrorClass,
    lastProvider,
    row.id,
  ),
);
```

The `CASE WHEN amount_status = 'permanently_unavailable' THEN amount_status ELSE ? END` guard means we never downgrade a locked row, no matter what the caller binds.

- [ ] **Step 3: Create migration 0103 to retroactively stamp existing rows**

Create `worker/migrations/0103_blacklist_mirror_zero_permanently_unavailable.sql`:

```sql
-- rollout-safety: backward-compatible (status change only, does not alter suppression filter)
-- 0103: Align existing EURC mirror-zero rows with new code semantics so they
-- exit the recoverable-pending backfill pool.

UPDATE blacklist_events
SET amount_status = 'permanently_unavailable'
WHERE suppression_reason = 'circle_mirror_zero_balance'
  AND amount_status != 'permanently_unavailable';
```

- [ ] **Step 4: Add the row to `MANIFEST.md`**

| 0103     | `0103_blacklist_mirror_zero_permanently_unavailable.sql` | Stamp EURC mirror-zero rows as permanently_unavailable to exit backfill pool |

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/blacklist/post-fetch.ts \
        worker/src/cron/blacklist/amount-recovery.ts \
        worker/migrations/0103_blacklist_mirror_zero_permanently_unavailable.sql \
        worker/migrations/MANIFEST.md
git commit -m "fix(blacklist): lock EURC mirror-zero rows to permanently_unavailable

Set amount_status='permanently_unavailable' at insert time and backfill
for 917 existing rows. Belt-and-suspenders against a future backfill
query loosening and re-recovering zero-value mirror rows."
```

---

### Task 1.7: Cap `address[]` decoded payload size

**Why:** `decodeAddressArrayData()` lets viem decode an arbitrarily large array. A malformed or malicious batch `AccountsBlocked` / `AddedToDenyList` log could decode into tens of thousands of addresses, each becoming a D1 insert and a balance-fetch budget burn.

**Files:**
- Modify: `worker/src/cron/blacklist/evm-source.ts:70-81`

- [ ] **Step 1: Add size cap + warn**

```typescript
// Before:
function decodeAddressArrayData(data: string): string[] {
  try {
    const [addresses] = decodeAbiParameters(
      [{ type: "address[]" }],
      data as `0x${string}`,
    );
    return [...addresses].map((address) => address.toLowerCase());
  } catch (error) {
    console.warn("[blacklist] Failed to decode address[] event data:", error);
    return [];
  }
}

// After:
/** Maximum plausible size of an address[] batch event — well above any real
 * AccountsBlocked or AddedToDenyList batch we've observed (real batches are
 * small, typically <50 addresses). Guards against malformed or adversarial
 * decode explosions. */
const MAX_DECODED_ADDRESS_ARRAY = 500;

function decodeAddressArrayData(data: string): string[] {
  try {
    const [addresses] = decodeAbiParameters(
      [{ type: "address[]" }],
      data as `0x${string}`,
    );
    const result = [...addresses].map((a) => a.toLowerCase());
    if (result.length > MAX_DECODED_ADDRESS_ARRAY) {
      console.warn(
        `[blacklist] address[] event decoded ${result.length} entries; truncating to ${MAX_DECODED_ADDRESS_ARRAY}`,
      );
      return result.slice(0, MAX_DECODED_ADDRESS_ARRAY);
    }
    return result;
  } catch (error) {
    console.warn("[blacklist] Failed to decode address[] event data:", error);
    return [];
  }
}
```

- [ ] **Step 2: Add test covering oversize payload**

Add to existing `evm-source.test.ts`:

```typescript
it("caps decoded address[] event to MAX_DECODED_ADDRESS_ARRAY", () => {
  // Build an address[] log with 1000 entries
  const addresses = Array.from({ length: 1000 }, (_, i) =>
    "0x" + (i + 1).toString(16).padStart(40, "0"),
  );
  const encoded = encodeAbiParameters([{ type: "address[]" }], [addresses as `0x${string}`[]]);
  const rows = parseEvmLogs(USDTB_CONFIG, [{
    address: USDTB_CONFIG.contractAddress,
    topics: [USDTB_BLOCK_TOPIC],
    data: encoded,
    blockNumber: "0x1",
    timestamp: "0x0",
    transactionHash: "0xdead",
    logIndex: "0x0",
    timeStamp: "0x61000000",
  }]);
  expect(rows.length).toBe(500);
});
```

- [ ] **Step 3: Run tests**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/evm-source.test.ts
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/blacklist/evm-source.ts worker/src/cron/blacklist/__tests__/evm-source.test.ts
git commit -m "fix(blacklist): cap decoded address[] payload at 500 entries"
```

---

### Task 1.8: Tron maxBlock initialization + log timestamp-missing drops

**Why:** (a) Today `maxBlock=0` is misleading when no events are found. Seed it with the starting cursor so logs read cleanly. Combined with Task 1.5 to avoid touching the same file twice.
(b) `parseEvmLogs` already drops `NaN`-timestamp rows silently. Log the drop count so operators can see silent gaps.

**Note on `||` fallback:** A prior draft used `maxBlock || lastTimestampMs`. If `lastTimestampMs` is also 0 (brand-new config), the `||` coerces to 0 again — not the intended fix. Initialize the variable directly instead.

**Files:**
- Modify: `worker/src/cron/blacklist/tron-source.ts:106-107` (maxBlock init)
- Modify: `worker/src/cron/blacklist/evm-source.ts:159-186` (log drops in `parseEvmLogs`)

- [ ] **Step 1: Initialize Tron maxBlock to the starting cursor**

```typescript
// Before (line 106-107):
let maxBlock = 0;

// After:
let maxBlock = lastTimestampMs;
```

Remove the `|| lastTimestampMs` fallback that Task 1.5 Step 3 proposed in the return statement. Just return `maxBlock` — it's now correctly initialized.

- [ ] **Step 2: Count and log rows dropped for missing timestamps in `parseEvmLogs`**

```typescript
// Before the loop:
let droppedForTimestamp = 0;

// Replace:
if (isNaN(blockNumber) || isNaN(timestamp)) continue;

// With:
if (isNaN(blockNumber) || isNaN(timestamp)) {
  droppedForTimestamp++;
  continue;
}

// Before returning:
if (droppedForTimestamp > 0) {
  console.warn(
    `[blacklist] parseEvmLogs for ${config.configKey}: dropped ${droppedForTimestamp} log(s) due to missing block/timestamp`,
  );
}
return rows;
```

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/blacklist/tron-source.ts worker/src/cron/blacklist/evm-source.ts
git commit -m "chore(blacklist): init Tron maxBlock to cursor, log timestamp drops"
```

(Task 1.9, the `alchemyPrimary` dRPC flip, was dropped during review — Task 1.1's window-shrink already solves Gnosis, and Fantom/Celo aren't in `RPC_LOG_SCAN_WINDOWS` today, so the flag flip is a no-op that primes future misconfig. Revisit only if we add a new dRPC-primary chain to the scan-window list.)

---

## Phase 2 — Data Cleanup Migrations

### Task 2.1: Migration 0099 — dedup mixed-case cursor rows

**Why:** `blacklist_sync_state` has 5 duplicate rows where one is lowercase (current canonical form) and one is mixed-case (legacy). Current reads merge both; writes only hit lowercase. The mixed-case rows are dead and waste bytes.

Duplicates (from production snapshot 2026-04-17):
- `ethereum-0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c` (EURC, stale) ↔ `ethereum-0x1abaea1f7c830bd89acc67ec4af516284b1bc33c`
- `ethereum-0x45804880De22913dAFE09f4980848ECE6EcbAf78` (PAXG) ↔ lowercase variant
- `ethereum-0x68749665FF8D2d112Fa859AA293F07A622782F38` (XAUT) ↔ lowercase variant
- `optimism-0x01bFF41798a0BcF287b996046Ca68b395DbC1071` (USDT0) ↔ lowercase variant
- `tron-TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` (USDT Tron) ↔ lowercase variant

**Files:**
- Create: `worker/migrations/0099_blacklist_sync_state_dedup.sql`
- Modify: `worker/migrations/MANIFEST.md`

- [ ] **Step 1: Write the migration**

```sql
-- rollout-safety: backward-compatible (reads merge both cases already)
-- 0099: Delete legacy mixed-case sync_state rows. The canonical write path
-- lowercases config_key; any mixed-case row is unreachable by current code.

DELETE FROM blacklist_sync_state
WHERE config_key != LOWER(config_key)
  AND EXISTS (
    SELECT 1 FROM blacklist_sync_state b2
    WHERE b2.config_key = LOWER(blacklist_sync_state.config_key)
  );
```

- [ ] **Step 2: Append MANIFEST row**

| 0099     | `0099_blacklist_sync_state_dedup.sql`  | Delete legacy mixed-case `blacklist_sync_state` rows (keeps lowercase canonical keys) |

- [ ] **Step 3: Apply locally, verify count drops by 5**

```bash
cd worker
npx wrangler d1 execute stablecoin-db --local --command \
  "SELECT COUNT(*) FROM blacklist_sync_state WHERE config_key != LOWER(config_key);"
# expect 0
```

- [ ] **Step 4: Commit**

```bash
git add worker/migrations/0099_blacklist_sync_state_dedup.sql worker/migrations/MANIFEST.md
git commit -m "chore(blacklist): migration 0099 dedup mixed-case sync_state rows"
```

---

### Task 2.2: Migration 0100 — reset legacy `derived` (and `legacy_migration`) amounts

**Why:** 7,198 rows carry `amount_source='derived'` from pre-v3.2 data ingestion. The current backfill only resets rows where `amount_source='derived' AND amount_native=0 AND chain_id != 'tron'`, which leaves the bulk intact. These rows carry unreliable event-time USD values (the "derived" source means "read a current balance and used it as if it were event-time"). Reset them so the standard backfill re-attributes with a proper `historical_balance` or `current_balance_snapshot` source.

Also: the type `BlacklistAmountSource` includes `"legacy_migration"` but no production rows currently carry this value (verified via `SELECT DISTINCT amount_source FROM blacklist_events`). The plan removes `"legacy_migration"` from the union (see `shared/types/market.ts:449`). Pre-check that zero rows use it before the schema change; if non-zero, include them in the migration.

Breakdown (prod 2026-04-17):
- USDT Ethereum: 4,070
- USDT Tron: 961
- USDC Ethereum: 389, USDC Arbitrum: 344, USDC Optimism: 250, USDC Base: 234, USDC Polygon: 227, USDC Avalanche: 139
- EURC Ethereum: 280
- PAXG Ethereum: 259
- USDT Arbitrum: 37, Polygon: 4
- XAUT: 4

**Files:**
- Create: `worker/migrations/0100_blacklist_reset_derived_amounts.sql`
- Modify: `worker/migrations/MANIFEST.md`

**Precheck before drafting the migration:**

```bash
cd worker
npx wrangler d1 execute stablecoin-db --remote --command \
  "SELECT amount_source, COUNT(*) FROM blacklist_events WHERE amount_source IN ('derived','legacy_migration') GROUP BY amount_source;"
```

If `legacy_migration` returns > 0, extend the WHERE clause in Step 1 below to cover it too.

- [ ] **Step 1: Write the migration**

```sql
-- rollout-safety: backward-compatible (backfill will re-populate amounts)
-- 0100: Flush pre-v3.2 'derived' + orphan 'legacy_migration' rows into the
-- backfill pool so they receive a proper historical_balance or
-- current_balance_snapshot attribution. Tron rows go through
-- backfillTronFromLedger once marked recoverable_pending. Leaves
-- permanently_unavailable rows alone.

UPDATE blacklist_events
SET amount_native = NULL,
    amount_usd_at_event = NULL,
    amount = NULL,
    amount_source = 'unavailable',
    amount_status = 'recoverable_pending',
    amount_attempt_count = 0,
    amount_last_attempted_at = NULL,
    amount_last_error_class = NULL,
    amount_last_provider = NULL
WHERE amount_source IN ('derived', 'legacy_migration')
  AND amount_status != 'permanently_unavailable';
```

- [ ] **Step 2: Append MANIFEST row**

| 0100     | `0100_blacklist_reset_derived_amounts.sql`  | Reset 7,198 pre-v3.2 `derived` rows into the backfill pool for proper re-attribution |

- [ ] **Step 3: Rollout note — backfill batch size**

Default backfill batch is 50 rows/run with an hourly cron. 7,198 / 50 = ~144 runs, ~6 days. Acceptable. Document in the PR that the drain will take a week.

- [ ] **Step 4: Commit**

```bash
git add worker/migrations/0100_blacklist_reset_derived_amounts.sql worker/migrations/MANIFEST.md
git commit -m "chore(blacklist): migration 0100 reset legacy derived amounts"
```

---

### Task 2.3: Migration 0102 — composite indexes for backfill + API

**Why:** The backfill query filters `event_type IN (...) AND amount_status IN (...)` and orders by `timestamp DESC`. No index covers it. The public `/api/blacklist` query filters by `stablecoin`, `chain_name`, `event_type` and orders by `timestamp DESC`. Individual single-column indexes exist but no composite. At current scale (18k rows) it's fine; post-Task-2.2 backfill pass will bump this to repeated 7k-row scans on every hourly run.

**Files:**
- Create: `worker/migrations/0102_blacklist_backfill_indexes.sql`
- Modify: `worker/migrations/MANIFEST.md`

- [ ] **Step 1: Write the migration**

```sql
-- rollout-safety: backward-compatible (new indexes only)
-- 0102: Composite indexes for the hot paths:
--   backfill selector: event_type + amount_status + timestamp DESC
--   public API filter: stablecoin + chain_name + event_type + timestamp DESC

CREATE INDEX IF NOT EXISTS idx_blacklist_events_backfill
  ON blacklist_events(event_type, amount_status, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_blacklist_events_api_filter
  ON blacklist_events(stablecoin, chain_name, event_type, timestamp DESC);
```

- [ ] **Step 2: Verify with EXPLAIN QUERY PLAN**

```bash
cd worker
npx wrangler d1 execute stablecoin-db --local --command \
  "EXPLAIN QUERY PLAN SELECT id FROM blacklist_events WHERE event_type IN ('blacklist','destroy') AND amount_status IN ('recoverable_pending') ORDER BY timestamp DESC LIMIT 50;"
# expect 'USING INDEX idx_blacklist_events_backfill'
```

- [ ] **Step 3: Add automated index-usage test**

Create `worker/src/cron/blacklist/__tests__/index-usage.test.ts` so CI catches future query drift:

```typescript
import { describe, expect, it } from "vitest";
import { applyMigrations, createLocalD1 } from "./helpers/d1-harness"; // adapt to existing harness

describe("composite indexes for hot blacklist queries", () => {
  it("backfill SELECT uses idx_blacklist_events_backfill", async () => {
    const db = await createLocalD1();
    await applyMigrations(db);
    const plan = await db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT id FROM blacklist_events
       WHERE event_type IN ('blacklist','destroy')
         AND amount_status IN ('recoverable_pending')
       ORDER BY timestamp DESC LIMIT 50`,
    ).all();
    const planText = (plan.results ?? []).map((r: any) => r.detail ?? "").join("\n");
    expect(planText).toContain("idx_blacklist_events_backfill");
  });

  it("public API filter SELECT uses idx_blacklist_events_api_filter", async () => {
    const db = await createLocalD1();
    await applyMigrations(db);
    const plan = await db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT id FROM blacklist_events
       WHERE stablecoin = 'USDC' AND chain_name = 'Ethereum' AND event_type = 'blacklist'
       ORDER BY timestamp DESC LIMIT 50`,
    ).all();
    const planText = (plan.results ?? []).map((r: any) => r.detail ?? "").join("\n");
    expect(planText).toContain("idx_blacklist_events_api_filter");
  });
});
```

If `helpers/d1-harness.ts` doesn't exist, adapt to the project's existing mock-D1 pattern or skip this task's automation and rely on the manual `EXPLAIN QUERY PLAN` check above.

- [ ] **Step 4: Append MANIFEST row and commit**

| 0102     | `0102_blacklist_backfill_indexes.sql`  | Composite indexes for blacklist backfill + public API query paths |

```bash
git add worker/migrations/0102_blacklist_backfill_indexes.sql worker/migrations/MANIFEST.md worker/src/cron/blacklist/__tests__/index-usage.test.ts
git commit -m "chore(blacklist): migration 0102 composite indexes + EXPLAIN-QUERY-PLAN test"
```

---

## Phase 3 — Efficiency: Summary Endpoint & Small Cleanups

### Task 3.1: Replace unbounded `SELECT * FROM blacklist_events` in summary endpoint

**Why:** `handleBlacklistSummary` today does `SELECT ... FROM blacklist_events ORDER BY timestamp DESC` with no LIMIT. It loads all 17,897 rows (~5–10 MB) into Worker memory every cache-miss, then computes aggregates in JS. With realtime cache (s-maxage=60) that's at most once per edge per minute, but we've already outgrown it in memory footprint and it scales linearly with event count. Move the aggregation to SQL.

This is the one task that changes the summary API's internal shape meaningfully; keep the public response schema identical (tested via existing `src/hooks/use-blacklist-events.ts` + `BlacklistSummaryStatsSchema`).

**Files:**
- Modify: `worker/src/api/blacklist-summary.ts`
- Modify: `worker/src/api/__tests__/blacklist-summary.test.ts` (the file already exists; append SQL-aggregate-parity cases and update existing expectations if fields change)
- Modify: `shared/lib/blacklist-aggregates.ts` (expose a helper for chart bucketing from SQL row shapes)

**Response-contract notes for this task (from schema review):**
- `BlacklistSummaryStatsSchema` (`shared/types/market.ts:524-539`) currently requires `recentCount`, `recentCount24h`, `recoverableGapCount` — the new handler MUST compute and return all three.
- `frozenAddresses` semantics in `blacklist-aggregates.ts:60-81` is the **net** count (balance of blacklist vs unblacklist events per address), not distinct-ever-blacklisted. Preserve this — do not silently change it.
- Keep `perCoinBlacklistCounts` *required* (not `.optional()`) for consistency with the sibling fields (see SF-10).

- [ ] **Step 1: Add test cases to the existing `blacklist-summary.test.ts`**

The file uses `mockD1` with an array-shaped `MockTableConfig[]` signature (see `helpers/mock-d1.ts`). Match that shape exactly; the top-level is an array of `{ match: <SQL substring>, rows: [...] }`. Append to the existing `describe("handleBlacklistSummary", ...)`:

```typescript
import { makeBlacklistRow } from "./helpers/fixtures";

it("derives perCoinBlacklistCounts and preserves required stats", async () => {
  const db = mockD1([
    {
      match: "FROM blacklist_events",
      rows: [
        makeBlacklistRow({ stablecoin: "USDC", chain_id: "ethereum", chain_name: "Ethereum", event_type: "blacklist", address: "0xa", amount: 1000, amount_native: 1000, amount_usd_at_event: 1000, timestamp: 1_700_000_000 }),
        makeBlacklistRow({ stablecoin: "USDC", chain_id: "ethereum", chain_name: "Ethereum", event_type: "unblacklist", address: "0xa", amount: 0, amount_native: 0, amount_usd_at_event: 0, timestamp: 1_700_100_000 }),
        makeBlacklistRow({ stablecoin: "USDT", chain_id: "ethereum", chain_name: "Ethereum", event_type: "destroy", address: "0xb", amount: 500, amount_native: 500, amount_usd_at_event: 500, timestamp: 1_700_200_000 }),
      ],
    },
    { match: "FROM blacklist_current_balances", rows: [] },
    { match: "FROM cron_runs",                   rows: [] },
  ]);
  const res = await handleBlacklistSummary(db);
  const json = await res.json();
  expect(json.stats.usdcBlacklisted).toBe(1);
  expect(json.stats.usdtBlacklisted).toBe(0); // only destroy, not blacklist
  expect(json.stats.destroyedTotal).toBe(500);
  expect(json.stats.perCoinBlacklistCounts.USDC).toBe(1);
  expect(json.stats.recoverableGapCount).toBeDefined();   // required field present
  expect(json.stats.recentCount).toBeDefined();
  expect(json.stats.recentCount24h).toBeDefined();
});

it("excludes suppression_reason != null from public aggregates", async () => {
  const db = mockD1([
    {
      match: "FROM blacklist_events",
      rows: [
        makeBlacklistRow({ stablecoin: "EURC", chain_id: "ethereum", chain_name: "Ethereum", event_type: "blacklist", address: "0xc", amount: 0, amount_native: 0, amount_usd_at_event: 0, timestamp: 1_700_000_000, suppression_reason: "circle_mirror_zero_balance" }),
      ],
    },
    { match: "FROM blacklist_current_balances", rows: [] },
    { match: "FROM cron_runs",                   rows: [] },
  ]);
  const res = await handleBlacklistSummary(db);
  const json = await res.json();
  expect(json.stats.frozenAddresses).toBe(0);
  expect(json.totalEvents).toBe(0);
});

it("preserves net-frozen semantics for frozenAddresses", async () => {
  // One address blacklisted then unblacklisted; one address blacklisted only.
  // Net frozen = 1, NOT distinct-ever-blacklisted (2).
  const db = mockD1([
    {
      match: "FROM blacklist_events",
      rows: [
        makeBlacklistRow({ stablecoin: "USDC", address: "0xa", event_type: "blacklist",   timestamp: 1_700_000_000 }),
        makeBlacklistRow({ stablecoin: "USDC", address: "0xa", event_type: "unblacklist", timestamp: 1_700_100_000 }),
        makeBlacklistRow({ stablecoin: "USDC", address: "0xb", event_type: "blacklist",   timestamp: 1_700_200_000 }),
      ],
    },
    { match: "FROM blacklist_current_balances", rows: [] },
    { match: "FROM cron_runs",                   rows: [] },
  ]);
  const res = await handleBlacklistSummary(db);
  const json = await res.json();
  expect(json.stats.frozenAddresses).toBe(1);
});
```

Run the existing-plus-new cases:

```bash
cd worker && npx vitest run src/api/__tests__/blacklist-summary.test.ts
```

Expected: existing cases still green + 3 new cases pass.

- [ ] **Step 2: Replace the handler**

Rewrite `worker/src/api/blacklist-summary.ts` (full file shown; adapt imports):

```typescript
import {
  addFreshnessHeaders,
  buildMethodologyEnvelope,
  getLatestSuccessfulCronTimestamp,
  jsonResponse,
  withErrorHandler,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/blacklist-tracker-version";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CONTRACT_CONFIGS } from "../lib/blacklist-contracts";
import { loadBlacklistCurrentBalanceMap } from "../lib/blacklist-current-balances";
import { BLACKLIST_STABLECOINS, type BlacklistStablecoin, type BlacklistEvent } from "@shared/types/market";
import { buildBlacklistQuarterlyChartFromSnapshots } from "@shared/lib/blacklist-aggregates";
import { mapBlacklistEventRow, type BlacklistEventRow } from "../lib/blacklist-api";
import {
  buildBlacklistActiveRecords,
  computeBlacklistActiveSummaryStats,
  computeBlacklistTrackedSummaryStats,
} from "@shared/lib/blacklist-active-records";

export const handleBlacklistSummary = withErrorHandler(
  "blacklist-summary",
  async (db: D1Database): Promise<Response> => {
    // 1) Per-coin blacklist-event counts (public only = suppression_reason IS NULL)
    const perCoinResult = await db
      .prepare(
        `SELECT stablecoin, event_type, COUNT(*) AS n, SUM(COALESCE(amount_usd_at_event, 0)) AS usd_sum
         FROM blacklist_events
         WHERE suppression_reason IS NULL
         GROUP BY stablecoin, event_type`,
      )
      .all<{ stablecoin: string; event_type: string; n: number; usd_sum: number }>();

    // 2) Latest event per (stablecoin, chain_id, LOWER(address)) — drives both
    //    net-frozen semantics AND activeRecords construction. D1 supports
    //    SQLite ≥ 3.25 window functions (ROW_NUMBER ... OVER PARTITION BY).
    const latestByAddrResult = await db
      .prepare(
        `WITH ranked AS (
           SELECT
             id, stablecoin, chain_id, chain_name, event_type, address,
             amount, amount_native, amount_usd_at_event, amount_source, amount_status,
             tx_hash, block_number, timestamp, methodology_version,
             contract_address, config_key, event_signature, event_topic0,
             suppression_reason, explorer_tx_url, explorer_address_url,
             ROW_NUMBER() OVER (PARTITION BY stablecoin, chain_id, LOWER(address) ORDER BY timestamp DESC, id DESC) AS rn
           FROM blacklist_events
           WHERE suppression_reason IS NULL
         )
         SELECT id, stablecoin, chain_id, chain_name, event_type, address,
                amount, amount_native, amount_usd_at_event, amount_source, amount_status,
                tx_hash, block_number, timestamp, methodology_version,
                contract_address, config_key, event_signature, event_topic0,
                suppression_reason, explorer_tx_url, explorer_address_url
         FROM ranked
         WHERE rn = 1`,
      )
      .all<BlacklistEventRow>();

    // Map snake_case → camelCase so buildBlacklistActiveRecords (and
    // buildBlacklistQuarterlyChartFromSnapshots) see a canonical BlacklistEvent.
    const latestByAddr: BlacklistEvent[] = (latestByAddrResult.results ?? [])
      .map(mapBlacklistEventRow);

    // 3) frozenAddresses — preserve NET semantics (blacklist events whose LATEST
    //    action is still 'blacklist'). Do NOT use a DISTINCT-ever-blacklisted
    //    count; that silently inflates the metric.
    const frozenAddresses = latestByAddr.filter((e) => e.eventType === "blacklist").length;

    // 4) recoverableGapCount — required by BlacklistSummaryStatsSchema.
    const recoverableGapResult = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM blacklist_events
         WHERE suppression_reason IS NULL
           AND amount_status IN ('recoverable_pending','provider_failed','ambiguous')`,
      )
      .first<{ n: number }>();

    // 5) Total row count (events)
    const totalResult = await db
      .prepare(`SELECT COUNT(*) AS n FROM blacklist_events WHERE suppression_reason IS NULL`)
      .first<{ n: number }>();

    // 6) Latest public event timestamp (freshness)
    const latestTsRow = await db
      .prepare(`SELECT MAX(timestamp) AS t FROM blacklist_events WHERE suppression_reason IS NULL`)
      .first<{ t: number | null }>();
    const latestTs = latestTsRow?.t ?? Math.floor(Date.now() / 1000);

    // 7) Recent counts
    const now = Math.floor(Date.now() / 1000);
    const recent30dRow = await db
      .prepare(`SELECT COUNT(*) AS n FROM blacklist_events WHERE suppression_reason IS NULL AND timestamp >= ?`)
      .bind(now - 30 * 86400)
      .first<{ n: number }>();
    const recent24hRow = await db
      .prepare(`SELECT COUNT(*) AS n FROM blacklist_events WHERE suppression_reason IS NULL AND timestamp >= ?`)
      .bind(now - 86400)
      .first<{ n: number }>();

    // 8) Current-balances snapshot-derived stats
    const currentBalances = await loadBlacklistCurrentBalanceMap(db);
    const activeRecords = buildBlacklistActiveRecords(latestByAddr, currentBalances);
    const activeStats = computeBlacklistActiveSummaryStats(activeRecords);
    const trackedStats = computeBlacklistTrackedSummaryStats(currentBalances);

    // 9) Build per-coin counts (all BLACKLIST_STABLECOINS keys present; 0 by default)
    const perCoinBlacklistCounts = Object.fromEntries(
      BLACKLIST_STABLECOINS.map((s) => [s, 0]),
    ) as Record<BlacklistStablecoin, number>;
    let destroyedTotal = 0;
    const blacklistBySymbol = new Map<string, number>();
    for (const row of perCoinResult.results ?? []) {
      if (row.event_type === "blacklist") {
        if (BLACKLIST_STABLECOINS.includes(row.stablecoin as BlacklistStablecoin)) {
          perCoinBlacklistCounts[row.stablecoin as BlacklistStablecoin] = row.n;
        }
        blacklistBySymbol.set(row.stablecoin, row.n);
      }
      if (row.event_type === "destroy") destroyedTotal += row.usd_sum ?? 0;
    }

    const usdcBlacklisted = blacklistBySymbol.get("USDC") ?? 0;
    const usdtBlacklisted = blacklistBySymbol.get("USDT") ?? 0;
    const goldBlacklisted = (blacklistBySymbol.get("PAXG") ?? 0) + (blacklistBySymbol.get("XAUT") ?? 0);

    const chart = buildBlacklistQuarterlyChartFromSnapshots(currentBalances, latestByAddr);

    const chainOptions = [
      ...new Map(
        CONTRACT_CONFIGS.map((c) => [c.chain.chainId, { id: c.chain.chainId, name: c.chain.chainName }]),
      ).values(),
    ].sort((a, b) => a.name.localeCompare(b.name));

    const freshnessTs = await getLatestSuccessfulCronTimestamp(db, "sync-blacklist", latestTs);

    return jsonResponse(
      {
        stats: {
          usdcBlacklisted,
          usdtBlacklisted,
          goldBlacklisted,
          frozenAddresses,                         // NET, not distinct-ever
          destroyedTotal,
          recentCount: recent30dRow?.n ?? 0,       // required
          recentCount24h: recent24hRow?.n ?? 0,    // required
          recoverableGapCount: recoverableGapResult?.n ?? 0, // required
          activeAddressCount: activeStats.activeAddressCount,
          activeFrozenTotal: activeStats.activeFrozenTotal,
          activeAmountGapCount: activeStats.activeAmountGapCount,
          trackedAddressCount: trackedStats.trackedAddressCount,
          trackedFrozenTotal: trackedStats.trackedFrozenTotal,
          trackedAmountGapCount: trackedStats.trackedAmountGapCount,
          perCoinBlacklistCounts,                  // required (see SF-10)
        },
        chart,
        chains: chainOptions,
        totalEvents: totalResult?.n ?? 0,
        methodology: buildMethodologyEnvelope({
          version: BLACKLIST_TRACKER_METHODOLOGY_VERSION,
          versionLabel: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
          currentVersion: BLACKLIST_TRACKER_METHODOLOGY_VERSION,
          currentVersionLabel: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
          changelogPath: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
          asOf: latestTs,
        }),
      },
      addFreshnessHeaders(
        { "Cache-Control": CACHE_PROFILES.realtime },
        freshnessTs,
        API_FRESHNESS_MAX_AGE_SEC.blacklistSummary,
      ),
    );
  },
);
```

**Important:** `mapBlacklistEventRow` (in `worker/src/lib/blacklist-api.ts`) is the canonical snake→camel mapper. Don't cast with `as any`; route every DB row through `mapBlacklistEventRow` before handing it to shared helpers that expect camelCase.

- [ ] **Step 3: Add helper `buildBlacklistQuarterlyChartFromSnapshots`**

In `shared/lib/blacklist-aggregates.ts`, add alongside `buildBlacklistChartData`. Signature takes camelCase `BlacklistEvent[]` (already mapped by the handler) + the existing `Map` snapshot shape:

```typescript
import type { BlacklistEvent, BlacklistStablecoin } from "../types/market";
import { BLACKLIST_STABLECOINS } from "../types/market";

export function buildBlacklistQuarterlyChartFromSnapshots(
  currentBalances: Map<string, {
    stablecoin: BlacklistStablecoin;
    chainId: string;
    address: string;
    amountNative: number | null;
    amountUsd: number | null;
    observedAt: number;
  }>,
  latestByAddr: BlacklistEvent[],
): BlacklistChartPoint[] {
  const latestBlacklistTsByKey = new Map<string, number>();
  for (const row of latestByAddr) {
    if (row.eventType !== "blacklist") continue;
    const key = `${row.stablecoin}:${row.chainId}:${row.address.toLowerCase()}`;
    const prev = latestBlacklistTsByKey.get(key);
    if (prev == null || row.timestamp > prev) latestBlacklistTsByKey.set(key, row.timestamp);
  }
  const emptyBucket = (): Record<BlacklistStablecoin, number> =>
    Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, 0])) as Record<BlacklistStablecoin, number>;
  const buckets = new Map<number, Record<BlacklistStablecoin, number>>();
  for (const snapshot of currentBalances.values()) {
    if (snapshot.amountUsd == null) continue;
    const key = `${snapshot.stablecoin}:${snapshot.chainId}:${snapshot.address.toLowerCase()}`;
    const ts = latestBlacklistTsByKey.get(key) ?? snapshot.observedAt;
    const q = Math.floor(ts / (90 * 86400)) * (90 * 86400);
    if (!buckets.has(q)) buckets.set(q, emptyBucket());
    buckets.get(q)![snapshot.stablecoin] += snapshot.amountUsd;
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ts, byCoin]) => ({
      quarter: new Date(ts * 1000).toISOString().slice(0, 7),
      ...byCoin,
      total: BLACKLIST_STABLECOINS.reduce((sum, s) => sum + (byCoin[s] ?? 0), 0),
    }));
}
```

- [ ] **Step 4: Wire `perCoinBlacklistCounts` into the response schema (required, not optional)**

Edit `shared/types/market.ts:524-540`. Do not downgrade existing required fields; make the new `perCoinBlacklistCounts` required for consistency with sibling stats:

```typescript
const BlacklistSummaryStatsSchema = z.object({
  usdcBlacklisted: z.number(),
  usdtBlacklisted: z.number(),
  goldBlacklisted: z.number(),
  frozenAddresses: z.number(),
  destroyedTotal: z.number(),
  activeAddressCount: z.number(),
  activeFrozenTotal: z.number(),
  activeAmountGapCount: z.number(),
  trackedAddressCount: z.number().optional(),
  trackedFrozenTotal: z.number().optional(),
  trackedAmountGapCount: z.number().optional(),
  recentCount: z.number(),
  recentCount24h: z.number(),
  recoverableGapCount: z.number(),
  perCoinBlacklistCounts: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
});
```

- [ ] **Step 5: Run tests, type-check**

```bash
cd worker && npx tsc --noEmit
cd worker && npx vitest run src/api/__tests__/blacklist-summary.test.ts
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add worker/src/api/blacklist-summary.ts \
        worker/src/api/__tests__/blacklist-summary.test.ts \
        shared/lib/blacklist-aggregates.ts \
        shared/types/market.ts
git commit -m "perf(blacklist): aggregate summary endpoint in SQL

Replaces unbounded SELECT * load with 5 targeted aggregates + ROW_NUMBER
window for latest-per-address lookups. Cuts worker memory from ~5-10MB
per cache-miss to a few KB; response schema adds perCoinBlacklistCounts."
```

---

### Task 3.2: Inline `post-fetch-counters.ts` and delete the module

**Why:** `post-fetch-counters.ts` is a thin wrapper with one exported function and two private helpers. It's called from exactly one place (sync-blacklist.ts). Deleting the module removes one indirection level.

**Files:**
- Delete: `worker/src/cron/blacklist/post-fetch-counters.ts`
- Modify: `worker/src/cron/sync-blacklist.ts` (inline the accumulator)

- [ ] **Step 1: Inline the accumulator in sync-blacklist.ts**

Replace the import and callsite:

```typescript
// Before (top of file):
import { processRowsAndAccumulatePostFetchRows } from "./blacklist/post-fetch-counters";

// After:
import { processFetchedBlacklistRows } from "./blacklist/post-fetch";

// Replace both callsites (Tron + EVM branches):
// Before:
const processed = await processRowsAndAccumulatePostFetchRows(
  { /* context */ },
  { enrichCounters, currentBalanceCacheCounters },
);
totalInsertedRows += processed;

// After:
const processed = await processFetchedBlacklistRows({ /* context */ });
enrichCounters.attempted += processed.enrichCounters.attempted;
enrichCounters.succeeded += processed.enrichCounters.succeeded;
enrichCounters.failed += processed.enrichCounters.failed;
currentBalanceCacheCounters.updated += processed.currentBalanceCacheCounters.updated;
currentBalanceCacheCounters.deleted += processed.currentBalanceCacheCounters.deleted;
currentBalanceCacheCounters.failed += processed.currentBalanceCacheCounters.failed;
totalInsertedRows += processed.insertedRows;
```

- [ ] **Step 2: Delete the module and its tests**

```bash
rm worker/src/cron/blacklist/post-fetch-counters.ts
# Remove imports from any tests that referenced it:
grep -rln "post-fetch-counters" worker/
# (edit or delete)
```

- [ ] **Step 3: Type-check + run full blacklist tests**

```bash
cd worker && npx tsc --noEmit
cd worker && npx vitest run src/cron/blacklist/
```

- [ ] **Step 4: Commit**

```bash
git add -A worker/src/cron/
git commit -m "refactor(blacklist): inline post-fetch-counters accumulator"
```

---

## Phase 4 — Frontend Polish

### Task 4.1: Disambiguate CSV export for non-USD coins

**Why:** CSV export currently emits one ambiguous "Amount" column. For BRZ (BRL-pegged), EURC/EURI (EUR-pegged), TGBP (GBP-pegged), A7A5 (RUB-pegged) the number could be native-denominated OR USD-converted; readers can't tell. Split into four columns.

**Files:**
- Modify: `src/components/blacklist-table.tsx` (CSV-generating block around lines 82-94)

- [ ] **Step 1: Update the CSV column list**

```tsx
// Before:
const csvColumns = [
  { header: "Date", accessor: (row) => new Date(row.timestamp * 1000).toISOString() },
  { header: "Stablecoin", accessor: (row) => row.stablecoin },
  { header: "Chain", accessor: (row) => row.chainName },
  { header: "Event Type", accessor: (row) => row.eventType },
  { header: "Address", accessor: (row) => row.address },
  { header: "Amount", accessor: (row) => formatBlacklistAmountCell(row) },
  { header: "Amount USD At Event", accessor: (row) => row.amountUsdAtEvent ?? "" },
  { header: "Transaction", accessor: (row) => row.txHash },
];

// After:
const csvColumns = [
  { header: "Date", accessor: (row) => new Date(row.timestamp * 1000).toISOString() },
  { header: "Stablecoin", accessor: (row) => row.stablecoin },
  { header: "Chain", accessor: (row) => row.chainName },
  { header: "Event Type", accessor: (row) => row.eventType },
  { header: "Address", accessor: (row) => row.address },
  { header: "Amount (Native)", accessor: (row) =>
    row.amountNative == null
      ? ""
      : row.amountNative.toLocaleString(undefined, {
          maximumFractionDigits: isGoldBlacklistStablecoin(row.stablecoin) ? 4 : 2,
        })
  },
  { header: "Amount Unit", accessor: (row) => row.stablecoin },
  { header: "Amount (USD at event)", accessor: (row) => row.amountUsdAtEvent ?? "" },
  { header: "Amount Status", accessor: (row) => row.amountStatus },
  { header: "Transaction", accessor: (row) => row.txHash },
];
```

- [ ] **Step 2: Commit**

```bash
git add src/components/blacklist-table.tsx
git commit -m "fix(blacklist-ui): split CSV amount into native/unit/USD/status cols"
```

---

### Task 4.2: Data-driven stats strip + amount-status badge

**Why:** Stats cards today hardcode USDC / USDT / gold. With 24+ coins tracked (30+ after expansion), this is arbitrary. Surface per-coin blacklist counts returned from the new `perCoinBlacklistCounts`. Also render a subtle amount-status badge next to non-resolved rows so readers know when an amount is pending-recovery.

**Files:**
- Modify: `src/components/blacklist-stats.tsx`
- Modify: `src/components/blacklist-table.tsx` (amount cell)

- [ ] **Step 1: Update blacklist-stats.tsx**

Replace the hardcoded triple (usdc, usdt, gold) with a top-5-by-count strip derived from `stats.perCoinBlacklistCounts`:

```tsx
const topByCount = stats?.perCoinBlacklistCounts
  ? Object.entries(stats.perCoinBlacklistCounts)
      .filter(([, count]) => count > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
  : [];

// Render:
<div className="grid grid-cols-2 md:grid-cols-5 gap-3">
  {topByCount.map(([coin, count]) => (
    <MetricStatCard
      key={coin}
      borderColorClass={BLACKLIST_CHART_COLORS[coin] ?? "border-border"}
      title={`${coin} Blacklisted`}
      value={count}
      subtext="unique events"
    />
  ))}
</div>
```

Keep the three original cards behind a `showLegacyTriples` boolean default-false prop so if we need a rollback it's one-line.

- [ ] **Step 2: Add status badge to blacklist-table.tsx**

```tsx
{!["resolved", "permanently_unavailable"].includes(evt.amountStatus) && (
  <span
    className="ml-1 inline-flex items-center rounded border border-border px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
    title={AMOUNT_STATUS_TOOLTIPS[evt.amountStatus]}
  >
    {evt.amountStatus.replace(/_/g, " ")}
  </span>
)}
```

Define `AMOUNT_STATUS_TOOLTIPS` at the top of the file. Keep `permanently_unavailable` out of the render gate (no badge shown) but include it in the tooltip map so if another component ever does render it, the copy exists:

```tsx
const AMOUNT_STATUS_TOOLTIPS: Record<string, string> = {
  recoverable_pending: "Amount not yet recovered from historical balance — backfill pass pending.",
  provider_failed: "Amount recovery failed at the data provider; next backfill pass will retry.",
  ambiguous: "Multiple candidate amounts; manual review required.",
  permanently_unavailable: "Amount cannot be recovered (e.g., EURC mirror-zero or Tron legacy row).",
};
```

- [ ] **Step 3: Commit**

```bash
git add src/components/blacklist-stats.tsx src/components/blacklist-table.tsx
git commit -m "feat(blacklist-ui): data-driven stats strip + amount-status badge"
```

---

### Task 4.3: View-model tests for pagination edge cases

**Why:** Frontend audit found missing tests for clamped-page-beyond-total, zero-total range bounds, and filter-triggered page reset.

**Files:**
- Modify: `src/app/blacklist/view-model.test.tsx`

- [ ] **Step 1: Add three test cases**

```tsx
it("clamps page to totalPages when navigating beyond bounds", () => {
  currentSearch = "?page=99";
  useBlacklistEventsPageMock.mockReturnValue({
    data: { events: [], total: 25 },
    /* ... */
  });
  const { result } = renderHook(() => useBlacklistPageController());
  expect(result.current.clampedPage).toBe(1);
});

it("returns zero range bounds when total is 0", () => {
  useBlacklistEventsPageMock.mockReturnValue({
    data: { events: [], total: 0 },
    /* ... */
  });
  const { result } = renderHook(() => useBlacklistPageController());
  expect(result.current.rangeStart).toBe(0);
  expect(result.current.rangeEnd).toBe(0);
});

it("resets page to 1 when applying a new filter", () => {
  currentSearch = "?page=3";
  const { result } = renderHook(() => useBlacklistPageController());
  act(() => result.current.handleStablecoinChange("USDC"));
  const nextParams = new URLSearchParams(currentSearch);
  expect(nextParams.get("page")).toBeNull();  // page=1 is the default, dropped from URL
});
```

- [ ] **Step 2: Run and commit**

```bash
npm test -- src/app/blacklist/view-model.test.tsx
git add src/app/blacklist/view-model.test.tsx
git commit -m "test(blacklist-ui): cover page-clamp, zero-total, filter-reset"
```

---

## Phase 5 — Minor Coverage Gaps (Existing-Coin Chain Additions)

### Task 5.1: Add Polygon USDQ, Arbitrum/Base AID, Base/BSC/Polygon TGBP

**Why:** Per ABI verifier: these contracts are already deployed on additional chains listed in `shared/data/stablecoins/*.json` but not in `CONTRACT_CONFIG_SPECS`. All reuse existing families (USDT0 / DENY_LIST / BANNED respectively), so cost is a handful of lines.

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts:593-599`

Contract addresses (from `shared/data/stablecoins/*.json`, verified during ABI audit):

| Coin | Chain | Address | Canonical id |
|---|---|---|---|
| USDQ | Polygon | `0xb291996477504506bf5f583102b5b5ea5d1e40e0` | `usdq-quantoz` |
| AID  | Arbitrum | `0x18f52b3fb465118731d9e0d276d4eb3599d57596` | `aid-gaib` |
| AID  | Base     | `0x18f52b3fb465118731d9e0d276d4eb3599d57596` | `aid-gaib` |
| TGBP | Base     | `0x27f6c8289550fce67f6b50bed1f519966afe5287` | `tgbp-tokenised` |
| TGBP | BSC      | `0x27f6c8289550fce67f6b50bed1f519966afe5287` | `tgbp-tokenised` |
| TGBP | Polygon  | `0x27f6c8289550fce67f6b50bed1f519966afe5287` | `tgbp-tokenised` |

- [ ] **Step 1: Look up deployment blocks — verbatim commands**

Required: `ETHERSCAN_API_KEY` exported in env. Chain IDs: 1=eth, 10=op, 56=bsc, 100=gnosis, 137=polygon, 8453=base, 42161=arbitrum, 43114=avalanche.

```bash
# USDQ Polygon
curl "https://api.etherscan.io/v2/api?chainid=137&module=contract&action=getcontractcreation&contractaddresses=0xb291996477504506bf5f583102b5b5ea5d1e40e0&apikey=$ETHERSCAN_API_KEY" | jq -r '.result[0].blockNumber'

# AID Arbitrum + Base
curl "https://api.etherscan.io/v2/api?chainid=42161&module=contract&action=getcontractcreation&contractaddresses=0x18f52b3fb465118731d9e0d276d4eb3599d57596&apikey=$ETHERSCAN_API_KEY" | jq -r '.result[0].blockNumber'
curl "https://api.etherscan.io/v2/api?chainid=8453&module=contract&action=getcontractcreation&contractaddresses=0x18f52b3fb465118731d9e0d276d4eb3599d57596&apikey=$ETHERSCAN_API_KEY" | jq -r '.result[0].blockNumber'

# TGBP Base / BSC / Polygon
for cid in 8453 56 137; do
  curl "https://api.etherscan.io/v2/api?chainid=$cid&module=contract&action=getcontractcreation&contractaddresses=0x27f6c8289550fce67f6b50bed1f519966afe5287&apikey=$ETHERSCAN_API_KEY" | jq -r --arg cid "$cid" '"chain=" + $cid + " block=" + (.result[0].blockNumber // "UNVERIFIED")'
done
```

Paste the numeric results into Step 2. If Etherscan v2 returns no data for a chain (contract not yet verified there), defer that specific spec — do not commit a placeholder.

- [ ] **Step 2: Append 6 entries to `CONTRACT_CONFIG_SPECS`**

```typescript
// Immediately after the USDQ Ethereum entry:
{ chain: POLYGON, stablecoinId: "usdq-quantoz", stablecoin: "USDQ", startBlock: <polygon_deploy>, events: USDT0_EVENT_FAMILY.events },

// Immediately after the AID Ethereum entry:
{ chain: ARBITRUM, stablecoinId: "aid-gaib", stablecoin: "AID", startBlock: <arb_deploy>, events: DENY_LIST_EVENT_FAMILY.events },
{ chain: BASE, stablecoinId: "aid-gaib", stablecoin: "AID", startBlock: <base_deploy>, events: DENY_LIST_EVENT_FAMILY.events },

// Immediately after the TGBP Avalanche entry:
{ chain: BASE, stablecoinId: "tgbp-tokenised", stablecoin: "TGBP", startBlock: <base_deploy>, events: BANNED_EVENT_FAMILY.events },
{ chain: BSC, stablecoinId: "tgbp-tokenised", stablecoin: "TGBP", startBlock: <bsc_deploy>, events: BANNED_EVENT_FAMILY.events },
{ chain: POLYGON, stablecoinId: "tgbp-tokenised", stablecoin: "TGBP", startBlock: <polygon_deploy>, events: BANNED_EVENT_FAMILY.events },
```

- [ ] **Step 3: Run type-check + commit**

```bash
cd worker && npx tsc --noEmit
git add worker/src/lib/blacklist-contracts.ts
git commit -m "feat(blacklist): add Polygon USDQ, ARB+Base AID, Base+BSC+POLY TGBP

Existing-family additions for contracts already deployed but not tracked.
Zero new families required."
```

---

## Phase 6 — Tier-1 Coverage Expansion (10 New Stablecoins)

Tier 1 = 10 coins where integration complexity is low (6 reuse existing families, 4 introduce one new family). Detailed per-coin data in `agents/plans/_audit-blacklist-top25-candidates.md`. Tier 2 (11–25) deferred.

### Task 6.1: Extend `BlacklistEventDef` with a data-bool discriminator (pre-req for TUSD)

**Why:** TrueUSD's blacklist/unblacklist is a *single* event `Blacklisted(address indexed account, bool isBlacklisted)` where the second data word disambiguates add vs remove. Today `BlacklistEventDef` hardcodes one `eventType` per event. Add a generic `eventTypeFromDataBoolIndex?: number` hook so one event def can resolve to either `"blacklist"` or `"unblacklist"` based on the bool at a given data slot. This unlocks TUSD (Task 6.2) without one-off parser branches.

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts:29-40` (extend the `BlacklistEventDef` type)
- Modify: `worker/src/cron/blacklist/evm-source.ts` (resolve `eventType` from the bool slot inside `buildBlacklistRow`)
- Test: `worker/src/cron/blacklist/__tests__/evm-source.test.ts` (cover both bool-true and bool-false)

- [ ] **Step 1: Extend the type**

```typescript
// worker/src/lib/blacklist-contracts.ts (BlacklistEventDef):
export interface BlacklistEventDef {
  signature: string;
  topicHash: string;
  eventType: BlacklistEventType;  // default / fallback when the bool slot is absent
  hasAmount: boolean;
  addressTopicIndex?: number;
  addressDataIndex?: number;
  addressArrayData?: boolean;
  amountTopicIndex?: number;
  amountDataIndex?: number;
  tronResultKey?: string;
  /** When set, the uint8/bool at this 32-byte data slot decides whether this
   *  event means 'blacklist' (non-zero) or 'unblacklist' (zero). Overrides
   *  `eventType` for the produced row. */
  eventTypeFromDataBoolIndex?: number;
}
```

- [ ] **Step 2: Resolve the bool in `evm-source.ts`**

In `parseEvmLogs` (before constructing the row), check the hook. Use `BigInt` zero-check, not a regex — the slot is always a uint256 word, and `BigInt("0x" + "00"*32) === 0n` is the only correct falsiness test:

```typescript
let resolvedEventType = eventDef.eventType;
if (typeof eventDef.eventTypeFromDataBoolIndex === "number") {
  const cleaned = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
  const slotIdx = eventDef.eventTypeFromDataBoolIndex;
  const boolSlot = cleaned.slice(slotIdx * 64, slotIdx * 64 + 64);
  if (boolSlot.length === 64) {
    const isTrue = BigInt("0x" + boolSlot) !== 0n;
    resolvedEventType = isTrue ? "blacklist" : "unblacklist";
  }
  // If the slot is short/missing, fall back to eventDef.eventType (default).
}
// Pass resolvedEventType into buildBlacklistRow instead of eventDef.eventType.
```

`buildBlacklistRow` currently derives `eventType` from `eventDef.eventType` via `getBlacklistEventByTopic`. Add a parameter:

```typescript
function buildBlacklistRow(
  config: ContractEventConfig,
  log: EvmLogLike,
  affectedAddress: string,
  amount: number | null,
  blockNumber: number,
  timestamp: number,
  rowSuffix = "",
  eventTypeOverride?: BlacklistEventType,
): BlacklistRow | null {
  const eventDef = getBlacklistEventByTopic(config, log.topics[0]);
  if (!eventDef) return null;
  const eventType = eventTypeOverride ?? eventDef.eventType;
  // rest as before, using `eventType`
}
```

- [ ] **Step 3: Add unit tests for both bool branches**

```typescript
// In evm-source.test.ts, add:
it("resolves eventType from data bool slot (bool=true → blacklist)", () => {
  const log = {
    address: TUSD_CONFIG.contractAddress,
    topics: [
      TRUEUSD_BLACKLISTED_TOPIC,
      "0x000000000000000000000000" + "11".repeat(20),  // indexed address
    ],
    data: "0x" + "01".padStart(64, "0"),  // bool=true at slot 0
    blockNumber: "0x1",
    transactionHash: "0xa",
    logIndex: "0x0",
    timeStamp: "0x61000000",
  };
  const rows = parseEvmLogs(TUSD_CONFIG, [log]);
  expect(rows[0].event_type).toBe("blacklist");
});

it("resolves eventType from data bool slot (bool=false → unblacklist)", () => {
  // Same as above but with data: 0x00...00 (bool false)
  // Expect rows[0].event_type === "unblacklist"
});
```

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/blacklist-contracts.ts worker/src/cron/blacklist/evm-source.ts worker/src/cron/blacklist/__tests__/evm-source.test.ts
git commit -m "feat(blacklist): BlacklistEventDef.eventTypeFromDataBoolIndex

Extends the event-def shape so a single event topic can resolve to
blacklist or unblacklist based on a bool slot in the event data. This
unlocks TUSD's Blacklisted(address,bool) pattern without a dedicated
per-coin parser branch."
```

---

### Task 6.2: Add TUSD (TrueUSD) on 5 EVM chains — new `TRUEUSD_EVENT_FAMILY`

**Why:** Rank-23 globally, ~$484M supply. TrueUSD emits `Blacklisted(address indexed, bool)` + `DestroyedBlackFunds(address,uint256)`. The bool discriminator is now handled by Task 6.1's extension. TUSD Tron is deferred (Tron doesn't go through the new bool path without parallel work).

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts` — add `TRUEUSD_EVENT_FAMILY` + 5 `CONTRACT_CONFIG_SPECS`
- Modify: `shared/types/market.ts` — add `"TUSD"` to `BLACKLIST_STABLECOINS`
- Modify: `shared/lib/classification.ts` — add `TUSD: "#0284c7"` (or any unused hex) to `BLACKLIST_CHART_COLORS`

- [ ] **Step 1: Compute keccak hashes and verify ABI per-chain**

Before writing the family, run:

```bash
# Ethereum TUSD contract address in shared/data/stablecoins/usd-major.json (id=tusd-trueusd).
# Fetch the verified ABI + first `Blacklisted` event:
curl "https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getabi&address=0x0000000000085d4780B73119b644AE5ecd22b376&format=raw" | jq '.[] | select(.type=="event" and .name=="Blacklisted")'
```

Confirm the ABI matches `Blacklisted(address indexed, bool)`. Compute its topic hash in code (don't guess the hex literal):

```typescript
import { keccak256, toBytes } from "viem";
const TRUEUSD_BLACKLISTED_TOPIC = keccak256(toBytes("Blacklisted(address,bool)"));
// Store the resulting hex literal in blacklist-contracts.ts — the subagent must
// paste the actual computed value, NOT the string above.
```

- [ ] **Step 2: Add the family**

```typescript
const TRUEUSD_BLACKLISTED_TOPIC = "<paste computed keccak hex from Step 1>";
const TRUEUSD_DESTROYED_TOPIC = USDT_DESTROYED_FUNDS_TOPIC; // same 0x61e6e6... signature

const TRUEUSD_EVENT_FAMILY = defineEventFamily("trueusd-blacklist", [
  {
    signature: "Blacklisted(address,bool)",
    topicHash: TRUEUSD_BLACKLISTED_TOPIC,
    eventType: "blacklist", // fallback — actual type comes from bool slot
    hasAmount: false,
    eventTypeFromDataBoolIndex: 0, // bool lives in data[0]
  },
  {
    signature: "DestroyedBlackFunds(address,uint256)",
    topicHash: TRUEUSD_DESTROYED_TOPIC,
    eventType: "destroy",
    hasAmount: true,
  },
]);
```

- [ ] **Step 3: Add `CONTRACT_CONFIG_SPECS` entries**

Look up addresses + deployment blocks:

```bash
# All 5 chains, address per `shared/data/stablecoins/usd-major.json` tusd-trueusd entry.
for chain in ethereum bsc avalanche polygon optimism; do
  addr=$(jq -r --arg c "$chain" '.[] | select(.id=="tusd-trueusd") | .contracts[] | select(.chain==$c) | .address' \
    shared/data/stablecoins/usd-major.json)
  cid=$(case $chain in ethereum) echo 1;; bsc) echo 56;; avalanche) echo 43114;; polygon) echo 137;; optimism) echo 10;; esac)
  echo "--- $chain $addr ---"
  curl -s "https://api.etherscan.io/v2/api?chainid=$cid&module=contract&action=getcontractcreation&contractaddresses=$addr&apikey=$ETHERSCAN_API_KEY" | jq -r '.result[0].txHash, .result[0].blockNumber // empty'
done
```

Paste results into the specs:

```typescript
{ chain: ETHEREUM, stablecoinId: "tusd-trueusd", stablecoin: "TUSD", startBlock: <deploy>, events: TRUEUSD_EVENT_FAMILY.events },
{ chain: BSC,      stablecoinId: "tusd-trueusd", stablecoin: "TUSD", startBlock: <deploy>, events: TRUEUSD_EVENT_FAMILY.events },
{ chain: AVALANCHE,stablecoinId: "tusd-trueusd", stablecoin: "TUSD", startBlock: <deploy>, events: TRUEUSD_EVENT_FAMILY.events },
{ chain: POLYGON,  stablecoinId: "tusd-trueusd", stablecoin: "TUSD", startBlock: <deploy>, events: TRUEUSD_EVENT_FAMILY.events },
{ chain: OPTIMISM, stablecoinId: "tusd-trueusd", stablecoin: "TUSD", startBlock: <deploy>, events: TRUEUSD_EVENT_FAMILY.events },
```

(Tron TUSD deferred — Tron path doesn't use `eventTypeFromDataBoolIndex` yet.)

- [ ] **Step 4: Append `"TUSD"` to `BLACKLIST_STABLECOINS` and `BLACKLIST_CHART_COLORS`**

```typescript
// shared/types/market.ts:
"TUSD",

// shared/lib/classification.ts:
TUSD: "#0284c7",  // distinct from existing entries
```

- [ ] **Step 5: Type-check + commit**

```bash
cd worker && npx tsc --noEmit
cd .. && npm run test -- blacklist
git add worker/src/lib/blacklist-contracts.ts shared/types/market.ts shared/lib/classification.ts
git commit -m "feat(blacklist): add TUSD coverage (5 EVM chains, TRUEUSD_EVENT_FAMILY)"
```

---

### Task 6.3: Add USDA (Avalon) + USAT + AEUR — reuse existing families

**Why:** All three drop straight into existing families per the research doc. Canonical IDs verified against `shared/data/stablecoins/*.json`:
- **USDA** (`usda-avalon`, ETH+BSC, ~$270M): `USDT_EVENT_FAMILY` (legacy `AddedBlackList` + `RemovedBlackList` + Destroy)
- **USAT** (`usat-tether`, ETH, ~$150M): `USDT0_EVENT_FAMILY` per research doc. The research doc classifies USAT as the newer Tether pattern; confirm the contract ABI actually emits `BlockPlaced`/`BlockReleased` before committing (see Step 1.5 below). If USAT instead uses the legacy `AddedBlackList` names, swap to `USDT_EVENT_FAMILY.events` — a topic-hash mismatch is silent (zero match) not an error, so this is worth verifying.
- **AEUR** (`aeur-anchored-coins` — **the correct id**; NOT `aeur-anchored`), ETH+BSC, ~$26M: `DUAL_INDEX_FREEZE_EVENT_FAMILY` (after Task 1.3 split)

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts`
- Modify: `shared/types/market.ts`
- Modify: `shared/lib/classification.ts` — add `USDA`, `USAT`, `AEUR` to `BLACKLIST_CHART_COLORS`

- [ ] **Step 1: Resolve address + deploy block per chain**

For each (`usda-avalon`, `usat-tether`, `aeur-anchored-coins`):

```bash
# Extract address from canonical JSON:
jq -r --arg id "usda-avalon" --arg chain "ethereum" '.[] | select(.id==$id) | .contracts[] | select(.chain==$chain) | .address' shared/data/stablecoins/usd-major.json shared/data/stablecoins/usd-minor.json 2>/dev/null

# Etherscan v2 contract creation lookup (chainid 1=eth, 56=bsc, 10=op, etc.):
curl "https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getcontractcreation&contractaddresses=<ADDR>&apikey=$ETHERSCAN_API_KEY" | jq -r '.result[0].blockNumber'
```

- [ ] **Step 1.5: Confirm USAT event-name shape before picking a family**

USAT is classified as `USDT0_EVENT_FAMILY` in the research doc, but topic-hash mismatch produces zero events silently (no error). Verify by grepping the verified ABI:

```bash
USAT_ADDR=$(jq -r '.[] | select(.id=="usat-tether") | .contracts[] | select(.chain=="ethereum") | .address' shared/data/stablecoins/usd-minor.json)
curl "https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getabi&address=$USAT_ADDR&apikey=$ETHERSCAN_API_KEY" \
  | jq '.result | fromjson | .[] | select(.type=="event" and (.name | test("Block|Blacklist|Freeze")))'
```

Decision matrix:
- ABI shows `BlockPlaced(address)` / `BlockReleased(address)` → keep `USDT0_EVENT_FAMILY.events` (the plan's default).
- ABI shows `AddedBlackList(address)` / `RemovedBlackList(address)` → switch to `USDT_EVENT_FAMILY.events`.
- ABI shows neither → defer USAT to tier 2 and note the gap in the PR body.

- [ ] **Step 2: Append specs** (use the canonical id — do not copy `aeur-anchored`):

```typescript
// USDA
{ chain: ETHEREUM, stablecoinId: "usda-avalon", stablecoin: "USDA", startBlock: <deploy>, events: USDT_EVENT_FAMILY.events },
{ chain: BSC,      stablecoinId: "usda-avalon", stablecoin: "USDA", startBlock: <deploy>, events: USDT_EVENT_FAMILY.events },

// USAT (Tether)
{ chain: ETHEREUM, stablecoinId: "usat-tether", stablecoin: "USAT", startBlock: <deploy>, events: USDT0_EVENT_FAMILY.events },

// AEUR — note the id is aeur-anchored-coins, not aeur-anchored
{ chain: ETHEREUM, stablecoinId: "aeur-anchored-coins", stablecoin: "AEUR", startBlock: <deploy>, events: DUAL_INDEX_FREEZE_EVENT_FAMILY.events },
{ chain: BSC,      stablecoinId: "aeur-anchored-coins", stablecoin: "AEUR", startBlock: <deploy>, events: DUAL_INDEX_FREEZE_EVENT_FAMILY.events },
```

If `usat-tether` has no verified ABI on Etherscan yet (new token), either pre-verify it or defer this chain entry.

- [ ] **Step 3: Append symbols to `BLACKLIST_STABLECOINS` + `BLACKLIST_CHART_COLORS`**

```typescript
// shared/types/market.ts (after TUSD):
"USDA", "USAT", "AEUR",

// shared/lib/classification.ts (add to BLACKLIST_CHART_COLORS object):
USDA: "#15803d",  USAT: "#a21caf",  AEUR: "#1e40af",
```

- [ ] **Step 4: Type-check + commit**

```bash
cd worker && npx tsc --noEmit
git add worker/src/lib/blacklist-contracts.ts shared/types/market.ts shared/lib/classification.ts
git commit -m "feat(blacklist): add USDA / USAT / AEUR via existing families"
```

---

### Task 6.4: Add XUSD (StraitsX) + XAUm (Matrixdock) — existing families

**Why:**
- **XUSD** (`xusd-straitsx`, ETH+BSC, ~$50M): `USDC_EVENT_FAMILY` pattern (`Blacklisted(address)` / `UnBlacklisted(address)`)
- **XAUm** (`xaum-matrixdock`, ETH+BSC, ~$500M gold fund): `USDT0_EVENT_FAMILY` minus Destroy

**Canonical symbol casing note:** The data corpus uses `"XAUm"` (lowercase m). Our `BLACKLIST_STABLECOINS` const-array symbols have historically been all-caps (PAXG, XAUT, USDT, …). We ship the symbol as `"XAUM"` (all-caps) so the frontend filter enum stays consistent, and resolve it to `xaum-matrixdock` via the explicit `stablecoin` override in the config spec (bypassing `resolveBlacklistStablecoinSymbol`'s case-sensitive lookup on the `symbol` field).

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts`
- Modify: `shared/types/market.ts`
- Modify: `shared/lib/classification.ts` — add `XUSD`, `XAUM` to `BLACKLIST_CHART_COLORS`
- Modify: `shared/lib/blacklist.ts` — widen `isGoldBlacklistStablecoin`, add `XAUM` price asset id

- [ ] **Step 1: Resolve addresses + deploy blocks (same command template as 6.3 Step 1)**

- [ ] **Step 2: Append specs**

```typescript
{ chain: ETHEREUM, stablecoinId: "xusd-straitsx",   stablecoin: "XUSD", startBlock: <deploy>, events: USDC_EVENT_FAMILY.events },
{ chain: BSC,      stablecoinId: "xusd-straitsx",   stablecoin: "XUSD", startBlock: <deploy>, events: USDC_EVENT_FAMILY.events },
{ chain: ETHEREUM, stablecoinId: "xaum-matrixdock", stablecoin: "XAUM", startBlock: <deploy>, events: USDT0_EVENT_FAMILY.events },
{ chain: BSC,      stablecoinId: "xaum-matrixdock", stablecoin: "XAUM", startBlock: <deploy>, events: USDT0_EVENT_FAMILY.events },
```

- [ ] **Step 3: Widen `isGoldBlacklistStablecoin`**

```typescript
// shared/lib/blacklist.ts:
export function isGoldBlacklistStablecoin(symbol: string): symbol is "PAXG" | "XAUT" | "XAUM" {
  return symbol === "PAXG" || symbol === "XAUT" || symbol === "XAUM";
}
```

- [ ] **Step 4: Add price-cache asset id**

```typescript
// shared/lib/blacklist.ts:
const BLACKLIST_PRICE_ASSET_IDS: Partial<Record<BlacklistStablecoin, string>> = {
  PAXG: "paxg-paxos",
  XAUT: "xaut-tether",
  XAUM: "xaum-matrixdock", // <-- new; resolves to the matrixdock commodity price entry
  A7A5: "a7a5-old-vector",
  BRZ: "brz-transfero",
  EURC: "eurc-circle",
  EURI: "euri-banking-circle",
  TGBP: "tgbp-tokenised",
};
```

- [ ] **Step 5: `BLACKLIST_STABLECOINS` + `BLACKLIST_CHART_COLORS`**

```typescript
// shared/types/market.ts:
"XUSD", "XAUM",
// shared/lib/classification.ts:
XUSD: "#0891b2", XAUM: "#ca8a04",
```

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/blacklist-contracts.ts shared/types/market.ts shared/lib/classification.ts shared/lib/blacklist.ts
git commit -m "feat(blacklist): add XUSD + XAUm via existing families"
```

---

### Task 6.5: Add JPYC — new `CENTRE_BLOCKLISTED_FAMILY`

**Why:** JPYC (JP Yen Coin) on ETH/Polygon/Avalanche, ~$72M. Emits CENTRE-fork variant `Blocklisted(address)` / `UnBlocklisted(address)` — distinctive enough to warrant its own family. Non-USD peg (JPY) — register price-cache entry.

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts`
- Modify: `shared/types/market.ts`
- Modify: `shared/lib/classification.ts` — add `JPYC` to `BLACKLIST_CHART_COLORS`
- Modify: `shared/lib/blacklist.ts` — register JPYC non-USD price asset id

- [ ] **Step 1: Compute topic hashes and verify the implementation ABI**

```bash
# ETH address from shared/data/stablecoins/non-usd.json id=jpyc-jpyc; resolve via jq.
# Then fetch getabi, confirm "Blocklisted" / "UnBlocklisted" event names.
```

Compute topic hashes in code at commit time (do not paste the `<keccak …>` literal):

```typescript
import { keccak256, toBytes } from "viem";
const BLOCKLISTED_TOPIC = keccak256(toBytes("Blocklisted(address)"));
const UNBLOCKLISTED_TOPIC = keccak256(toBytes("UnBlocklisted(address)"));
```

- [ ] **Step 2: Add family**

```typescript
const JPYC_BLOCKLISTED_TOPIC = "<paste actual hex>";
const JPYC_UNBLOCKLISTED_TOPIC = "<paste actual hex>";

const CENTRE_BLOCKLISTED_FAMILY = defineEventFamily("centre-blocklisted", [
  { signature: "Blocklisted(address)",   topicHash: JPYC_BLOCKLISTED_TOPIC,   eventType: "blacklist",    hasAmount: false },
  { signature: "UnBlocklisted(address)", topicHash: JPYC_UNBLOCKLISTED_TOPIC, eventType: "unblacklist",  hasAmount: false },
]);
```

- [ ] **Step 3: Add specs**

```typescript
{ chain: ETHEREUM,  stablecoinId: "jpyc-jpyc", stablecoin: "JPYC", startBlock: <deploy>, events: CENTRE_BLOCKLISTED_FAMILY.events },
{ chain: POLYGON,   stablecoinId: "jpyc-jpyc", stablecoin: "JPYC", startBlock: <deploy>, events: CENTRE_BLOCKLISTED_FAMILY.events },
{ chain: AVALANCHE, stablecoinId: "jpyc-jpyc", stablecoin: "JPYC", startBlock: <deploy>, events: CENTRE_BLOCKLISTED_FAMILY.events },
```

- [ ] **Step 4: Register JPYC as non-USD and append to chart colors**

```typescript
// shared/lib/blacklist.ts BLACKLIST_PRICE_ASSET_IDS:
JPYC: "jpyc-jpyc",

// shared/lib/classification.ts BLACKLIST_CHART_COLORS:
JPYC: "#ea580c",
```

- [ ] **Step 5: Append to BLACKLIST_STABLECOINS and commit**

```bash
# shared/types/market.ts: add "JPYC" to the array
git add worker/src/lib/blacklist-contracts.ts shared/types/market.ts shared/lib/classification.ts shared/lib/blacklist.ts
git commit -m "feat(blacklist): add JPYC via CENTRE_BLOCKLISTED_FAMILY"
```

---

### Task 6.6: Add FRXUSD — new `FRAX_FREEZE_FAMILY`

**Why:** FRXUSD (`frxusd-frax`, ETH, ~$136M). Emits `AccountFrozen(address)` non-indexed (address in data slot 0) + `AccountUnfrozen(address)` non-indexed. Cannot reuse `ACCOUNT_FREEZE_EVENT_FAMILY` (which uses indexed). Same event-name signature hashes AS the existing indexed family — distinguishing factor is `addressDataIndex: 0` vs the default `addressTopicIndex: 1`.

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts`
- Modify: `shared/types/market.ts`
- Modify: `shared/lib/classification.ts`

- [ ] **Step 1: Verify ABI (AccountFrozen is non-indexed on this contract)**

```bash
# frxusd-frax ETH address lookup
jq -r '.[] | select(.id=="frxusd-frax") | .contracts[] | select(.chain=="ethereum") | .address' shared/data/stablecoins/usd-minor.json
# Pull ABI and confirm 'indexed' is absent on the address param
```

- [ ] **Step 2: Add family (re-uses topic constants where hash matches)**

```typescript
const FRAX_FREEZE_FAMILY = defineEventFamily("frax-freeze", [
  {
    signature: "AccountFrozen(address)",
    topicHash: ACCOUNT_FROZEN_TOPIC,   // same keccak as indexed variant
    eventType: "blacklist",
    hasAmount: false,
    addressDataIndex: 0,               // <-- key difference
  },
  {
    signature: "AccountUnfrozen(address)",
    topicHash: ACCOUNT_UNFROZEN_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
    addressDataIndex: 0,
  },
]);
```

- [ ] **Step 3: Spec + symbol + color**

```typescript
// blacklist-contracts.ts:
{ chain: ETHEREUM, stablecoinId: "frxusd-frax", stablecoin: "FRXUSD", startBlock: <deploy>, events: FRAX_FREEZE_FAMILY.events },

// shared/types/market.ts: "FRXUSD",
// shared/lib/classification.ts: FRXUSD: "#f97316",
```

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/blacklist-contracts.ts shared/types/market.ts shared/lib/classification.ts
git commit -m "feat(blacklist): add FRXUSD via FRAX_FREEZE_FAMILY (non-indexed address)"
```

---

### Task 6.7: Add NUSD (Neutrl) + EURCV (SocGen) — new families (apxUSD deferred)

**Why:**
- **NUSD** (`nusd-neutrl`, ETH, ~$172M): `DenyListUpdated(address indexed, bool)` event — same bool-discriminator pattern as TUSD. Reuse Task 6.1's `eventTypeFromDataBoolIndex` hook.
- **EURCV** (`eurcv-societe-generale-forge` — **the correct id**; NOT `eurcv-socgen`), ETH, ~$108M: SocGen freeze via `AddressesFrozen(address[])` / `AddressesUnfrozen(address[])` batch events. Reuse `USDTB_EVENT_FAMILY`'s `addressArrayData` mechanism with a new family key for the different topic hashes.

**apxUSD deferred to tier 2:** The research doc's `apxusd-apyx` contract emits a single `DenyListUpdated(address,address)` event with no add/remove discriminator (both addresses are accounts, no bool). Without direction information we would record every event as `blacklist` and lose reversibility. Revisit once either (a) the issuer publishes disambiguation, or (b) we implement tx-input classification.

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts`
- Modify: `shared/types/market.ts`
- Modify: `shared/lib/classification.ts`
- Modify: `shared/lib/blacklist.ts` — EURCV is EUR-denominated; add price asset entry

- [ ] **Step 1: Verify ABIs for both contracts**

```bash
# NUSD ETH address
jq -r '.[] | select(.id=="nusd-neutrl") | .contracts[] | select(.chain=="ethereum") | .address' shared/data/stablecoins/usd-minor.json
# EURCV ETH address (note canonical id)
jq -r '.[] | select(.id=="eurcv-societe-generale-forge") | .contracts[] | select(.chain=="ethereum") | .address' shared/data/stablecoins/non-usd.json
# Fetch each ABI via Etherscan v2 getabi and confirm event names + indexed flags
```

- [ ] **Step 2: Define families**

```typescript
// NUSD: same bool pattern as TUSD, different event name
const NEUTRL_DENYLIST_UPDATED_TOPIC = "<paste actual hex>";

const NEUTRL_DENYLIST_FAMILY = defineEventFamily("neutrl-denylist", [
  {
    signature: "DenyListUpdated(address,bool)",
    topicHash: NEUTRL_DENYLIST_UPDATED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
    eventTypeFromDataBoolIndex: 0,
  },
]);

// EURCV: batch array of addresses per event
const SOCGEN_ADDR_FROZEN_TOPIC = "<paste actual hex>";
const SOCGEN_ADDR_UNFROZEN_TOPIC = "<paste actual hex>";

const SOCGEN_FREEZE_FAMILY = defineEventFamily("socgen-freeze", [
  { signature: "AddressesFrozen(address[])",   topicHash: SOCGEN_ADDR_FROZEN_TOPIC,   eventType: "blacklist",   hasAmount: false, addressArrayData: true },
  { signature: "AddressesUnfrozen(address[])", topicHash: SOCGEN_ADDR_UNFROZEN_TOPIC, eventType: "unblacklist", hasAmount: false, addressArrayData: true },
]);
```

- [ ] **Step 3: Add specs**

```typescript
{ chain: ETHEREUM, stablecoinId: "nusd-neutrl",                   stablecoin: "NUSD",  startBlock: <deploy>, events: NEUTRL_DENYLIST_FAMILY.events },
{ chain: ETHEREUM, stablecoinId: "eurcv-societe-generale-forge",  stablecoin: "EURCV", startBlock: <deploy>, events: SOCGEN_FREEZE_FAMILY.events },
```

- [ ] **Step 4: Symbols + colors + price ids**

```typescript
// shared/types/market.ts: "NUSD", "EURCV",
// shared/lib/classification.ts: NUSD: "#7c2d12", EURCV: "#1e3a8a",
// shared/lib/blacklist.ts BLACKLIST_PRICE_ASSET_IDS:
EURCV: "eurcv-societe-generale-forge",
```

- [ ] **Step 5: Two commits (NUSD and EURCV separately for reviewability)**

```bash
# Commit 1:
git add worker/src/lib/blacklist-contracts.ts shared/types/market.ts shared/lib/classification.ts
git commit -m "feat(blacklist): add NUSD via NEUTRL_DENYLIST_FAMILY

Reuses Task 6.1's eventTypeFromDataBoolIndex for blacklist/unblacklist
direction. apxUSD (same tier) deferred — no discriminator in its event."

# Commit 2:
git add worker/src/lib/blacklist-contracts.ts shared/types/market.ts shared/lib/classification.ts shared/lib/blacklist.ts
git commit -m "feat(blacklist): add EURCV via SOCGEN_FREEZE_FAMILY (batch array)"
```

---

### Task 6.8: Add FIDD (Fidelity) — new `FIDELITY_RESTRICTION_FAMILY`

**Why:** Rank-34 globally, ~$51M. Fidelity RESTRICT events don't match any existing pattern (per research doc, events are `AccountRestricted(address)` / `AccountUnrestricted(address)` with indexed address).

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts`
- Modify: `shared/types/market.ts`
- Modify: `shared/lib/classification.ts`

- [ ] **Step 1: Verify ABI**

```bash
jq -r '.[] | select(.id=="fidd-fidelity") | .contracts[] | select(.chain=="ethereum") | .address' shared/data/stablecoins/usd-minor.json
# Etherscan getabi
```

- [ ] **Step 2: Define family**

```typescript
const FIDELITY_RESTRICTED_TOPIC = "<paste actual hex>";
const FIDELITY_UNRESTRICTED_TOPIC = "<paste actual hex>";

const FIDELITY_RESTRICTION_FAMILY = defineEventFamily("fidelity-restriction", [
  { signature: "AccountRestricted(address)",   topicHash: FIDELITY_RESTRICTED_TOPIC,   eventType: "blacklist",   hasAmount: false },
  { signature: "AccountUnrestricted(address)", topicHash: FIDELITY_UNRESTRICTED_TOPIC, eventType: "unblacklist", hasAmount: false },
]);
```

- [ ] **Step 3: Add spec + symbol + color**

```typescript
// blacklist-contracts.ts:
{ chain: ETHEREUM, stablecoinId: "fidd-fidelity", stablecoin: "FIDD", startBlock: <deploy>, events: FIDELITY_RESTRICTION_FAMILY.events },
// shared/types/market.ts: "FIDD",
// shared/lib/classification.ts: FIDD: "#166534",
```

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/blacklist-contracts.ts shared/types/market.ts shared/lib/classification.ts
git commit -m "feat(blacklist): add FIDD via FIDELITY_RESTRICTION_FAMILY"
```

---

## Phase 7 — Docs + Methodology Version

### Task 7.1: Bump methodology to v3.94 (remediation) and v3.95 (expansion)

**Files:**
- Modify: `shared/lib/blacklist-tracker-version.ts`
- Modify: `docs/blacklist-tracker.md`
- Modify: `docs/blacklist-tracker-timeline.md`

**Computing `effectiveAt`:** `effectiveAt` is a Unix epoch in seconds. Compute it at commit time so it matches the actual merge moment:

```bash
date -u +%s      # e.g., 1776700000
```

Use that exact integer as the literal in both entries below. `date` is YYYY-MM-DD from the same `date -u +%F`.

- [ ] **Step 1: Add v3.94 entry covering Phase 1–3 + Phase 5**

```typescript
{
  version: "3.94",
  title: "Correctness + efficiency + minor coverage gaps",
  date: "<exec YYYY-MM-DD>",
  effectiveAt: <exec epoch seconds from `date -u +%s`>,
  summary:
    "Caps Gnosis dRPC scan window (rescues 2 missed BRZ events), splits dual-index-freeze from WLFI destroys (FDUSD/EURI no longer inherit destroy topics), propagates TronGrid failures to the circuit breaker, locks EURC mirror-zero rows to permanently_unavailable, aggregates the summary endpoint in SQL, and closes three minor chain-coverage gaps (Polygon USDQ, ARB+Base AID, Base+BSC+POLY TGBP).",
  impact: [
    "Gnosis BRZ begins producing events after ~12.5M-block backlog drain",
    "FDUSD / EURI configs stop carrying topic slots they cannot match",
    "TronGrid outages now register with the circuit breaker",
    "EURC mirror-zero rows exit the recoverable-pending backfill pool",
    "Summary endpoint memory footprint drops from ~5-10MB to a few KB per cache miss",
    "7 new chain-coverage rows for existing coins",
  ],
},
```

- [ ] **Step 2: Add v3.95 entry covering Phase 6 tier-1 expansion**

```typescript
{
  version: "3.95",
  title: "Tier-1 coverage expansion",
  date: "<exec YYYY-MM-DD>",
  effectiveAt: <exec epoch seconds>,
  summary:
    "Adds 10 new tracked stablecoins: TUSD (new TRUEUSD_EVENT_FAMILY across 6 chains), USDA + USAT + AEUR via existing families, XUSD + XAUm via existing families, JPYC (new CENTRE_BLOCKLISTED_FAMILY), FRXUSD (new FRAX_FREEZE_FAMILY), NUSD / apxUSD / EURCV / FIDD (four new single-coin families).",
  impact: [
    "Tracks $484M TUSD + $270M USDA + $172M NUSD + $160M apxUSD + $150M USAT + $136M FRXUSD + $108M EURCV + $72M JPYC + $51M FIDD + $50M XUSD (tier-1 expansion)",
    "Six coins reuse existing families (TUSD additions reuse DestroyedBlackFunds topic)",
    "Four net-new families introduced with per-coin tests",
  ],
},
```

- [ ] **Step 3: Append corresponding rows to `docs/blacklist-tracker-timeline.md`**

(Pattern identical to existing v3.93/v3.92 entries in that file.)

- [ ] **Step 4: Refresh `docs/blacklist-tracker.md`**

- Update "Cron-backed sync coverage" list in the top of the file to include TUSD, USDA, USAT, AEUR, XUSD, XAUM, JPYC, FRXUSD, NUSD, APXUSD, EURCV, FIDD.
- Update "Live API/UI filter enum" reference.
- Append new event families to the "Event Signatures" section.
- Append "Known Gotchas #21: Gnosis dRPC free-tier is capped at 10k-block ranges — scan windows must stay ≤9k."
- Update "Known Gotchas #20" (non-USD) to include new non-USD additions (EURCV, JPYC).

- [ ] **Step 5: Commit**

```bash
git add shared/lib/blacklist-tracker-version.ts docs/blacklist-tracker.md docs/blacklist-tracker-timeline.md
git commit -m "docs(blacklist): methodology v3.94 + v3.95, doc refresh"
```

---

## Phase 8 — Validation & Rollout

### Task 8.1: Full test + build + merge-gate

**Files:** no code

- [ ] **Step 1: Run full test suite**

```bash
npm test
cd worker && npx vitest run
cd .. && cd worker && npx tsc --noEmit && cd ..
```

- [ ] **Step 2: Run merge gate**

```bash
npm run test:merge-gate
```

- [ ] **Step 3: Local wrangler dry-run**

```bash
cd worker && npx wrangler dev
# Trigger sync-blacklist manually via /cdn-cgi/test-scheduled or a test invocation;
# verify no runtime errors.
```

- [ ] **Step 4: Post-migration diagnostic diff (uses baseline from Task 0.1)**

Re-run the three baseline queries and diff against `/tmp/blacklist-baseline-*.json`. Confirm the expected shape:

```bash
cd worker

# (A) derived rows should have dropped to ~0 after 0100 + one backfill pass drains them.
#     Pre-migration: 7198 derived rows; post-migration: recoverable_pending should bump by ~7198
#     and source=derived should be ~0.
npx wrangler d1 execute stablecoin-db --remote \
  --command "SELECT amount_source, COUNT(*) n FROM blacklist_events GROUP BY 1 ORDER BY 1" --json \
  > /tmp/blacklist-post-source.json
diff <(jq '.[].results' /tmp/blacklist-baseline-source.json) <(jq '.[].results' /tmp/blacklist-post-source.json) | head -40

# (B) sync_state rowcount should drop by 5 (duplicate-dedup, migration 0099).
npx wrangler d1 execute stablecoin-db --remote \
  --command "SELECT COUNT(*) FROM blacklist_sync_state" --json
# Expected: baseline total - 5.

# (C) EURC mirror-zero rows (`suppression_reason='circle_mirror_zero_balance'`) should all
#     have amount_status='permanently_unavailable' after 0103.
npx wrangler d1 execute stablecoin-db --remote \
  --command "SELECT COUNT(*) FROM blacklist_events WHERE suppression_reason='circle_mirror_zero_balance' AND amount_status != 'permanently_unavailable'" --json
# Expected: 0.
```

If any of the three checks don't match expectations, stop the rollout — run `wrangler d1 time-travel restore stablecoin-db --bookmark=<Task 0.1 bookmark>` and investigate before retrying.

---

### Task 8.2: Staged rollout plan (narrative, not a task)

Post-merge, monitor via `cron_runs` table metadata for sync-blacklist:

1. **Hour 1 after deploy:** verify `apiErrors=0` and `rowsWritten` increasing proportionally with the backfill drain.
2. **Day 1–7:** watch 7198 `derived` rows drain through the 50-row-per-hour backfill. Expected clear rate ~1,200 rows/day.
3. **Week 2:** verify Gnosis BRZ cursor advances past block 33,267,000 and picks up the two known events.
4. **Week 2:** verify new tier-1 symbols show their first events (TUSD on Ethereum historically had ~50 freeze events; should ingest within hours).

Rollback plan:
- D1 issues: `npx wrangler d1 time-travel restore stablecoin-db --bookmark=00001b06-00014eb0-00005050-dd275c00bb858144ed8653f1c7eeed78` (pre-merge baseline captured 2026-04-18).
- Worker issues: `npx wrangler rollback stablecoin-api`.
- Per-coin issue in Phase 6: revert the specific spec entry + symbol + family.

---

## Appendix — Self-review checklist (run before handoff)

- [ ] Every step with code has executable code, not pseudocode.
- [ ] Every file path is absolute (or worker-root-relative).
- [ ] No TBD / "look this up later" in committed code (only in lookup-prep steps).
- [ ] Test commands cite exact paths.
- [ ] Deployment blocks for Phase 5 + 6 are looked up before commit (subagent task — surface the values in PR).
- [ ] `BLACKLIST_STABLECOINS` (`shared/types/market.ts`) receives every new symbol: TUSD, USDA, USAT, AEUR, XUSD, XAUM, JPYC, FRXUSD, NUSD, EURCV, FIDD. (apxUSD deferred.)
- [ ] `BLACKLIST_CHART_COLORS` (`shared/lib/classification.ts`) receives a hex entry for every new symbol — build fails TS2741 without it.
- [ ] `BLACKLIST_PRICE_ASSET_IDS` (`shared/lib/blacklist.ts`) updated for every new non-USD symbol (XAUM → `xaum-matrixdock`, JPYC → `jpyc-jpyc`, EURCV → `eurcv-societe-generale-forge`).
- [ ] Methodology version entries bump correctly (v3.93 → v3.94 → v3.95; NOT v3.10). `effectiveAt` is a Unix-epoch-seconds integer from `date -u +%s` at commit time.
- [ ] Phase 6 runs AFTER Phase 3 — `BlacklistChartPointSchema` atomicity constraint.
- [ ] Canonical stablecoin IDs: `aeur-anchored-coins` (NOT `aeur-anchored`), `eurcv-societe-generale-forge` (NOT `eurcv-socgen`), `apxusd-apyx` if apxUSD is re-added later.
- [ ] Docs refreshed with new cron coverage + gotcha additions (including the dRPC 10k-block cap as Known Gotcha #21).
- [ ] Reviewer's MF and SF items all resolved; the single remaining intentional deferral is apxUSD (no direction discriminator).
