# On-Chain Supply Writers Audit: Expansion vs. Decommission Decision

**Date:** 2026-04-13  
**Status:** Research (decision-pending)  
**Investigated by:** Claude Code audit tool  
**Target:** Pharos stablecoin-dashboard repository

---

## Executive Summary

The `onchain_supply` table and its accompanying status-check logic were designed in Feb 2026 to continuously verify stablecoin supplies against on-chain ground truth. Today (Apr 13), only **two stablecoins are tracked** (KAU, KAG via Kinesis), and **only one writer exists** (`sync-kinesis-supply`). The system is wired but starved.

**Key findings:**
- Original design aimed to support 50+ stablecoins across EVM/Tron chains with batch RPC queries (demonstrated in deleted `sync-onchain-supply.ts`).
- Contract metadata is available in all canonical stablecoin config files (`usd-major.json`, `usd-minor.json`, `commodity.json`, `non-usd.json`); expansion is not blocked by data availability.
- The structural floor (ONCHAIN_LOW_SAMPLE_STRUCTURAL_FLOOR = 3) added in Workstream 3 (Apr 13) suppresses the info cause below 3 coins; with 10 coins, the ratio-based checks activate.
- **Decommission is lower-effort** (~200 LOC removed, minimal test churn) but loses a valuable integrity verification channel that has zero operational cost once writers exist.
- **Expansion (USDT first)** is medium-effort (~500–800 LOC), fits in the existing quarter-hourly critical-cron lane, and would immediately unlock ratio-based divergence detection for the largest stablecoin.
- **Lowering the threshold** is not viable: a single noisy coin among 2–9 would dominate the ratio signal.

**Recommendation:** **Expand writers, starting with USDT.** The design is sound, contract data exists, RPC infrastructure is ready, and the cost-to-signal is low once 2–3 writers are active. Decommissioning discards months of prior design work on a system with negligible operational cost.

---

## 1. Original Design Intent

### 1.1 Design Document (Feb 19, 2026)

Per `2026-02-19-onchain-supply-verification-design.md` and implementation plan:

**Problem:** Non-USD stablecoins (EUR, GBP, JPY, gold-pegged) have inaccurate supply figures on DefiLlama and CoinGecko. On-chain `totalSupply()` is the ground truth.

**Goals:**
1. Maintain contract registry for all tracked stablecoins across all chains.
2. Query on-chain `totalSupply()` to compute verifiable supply.
3. Override DefiLlama supply/market cap when on-chain diverges significantly (>5% per `STATUS_ONCHAIN_DIVERGENCE_PER_COIN_THRESHOLD`).
4. Surface divergences in the status system via `onchain_integrity_degraded` / `onchain_integrity_stale` causes.

### 1.2 Architecture (as designed)

**Schema:**
```sql
CREATE TABLE onchain_supply (
  stablecoin_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  supply REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (stablecoin_id, chain)
);
```

**Status Thresholds:**
- `ratioMinTrackedCoins = 10` — below this, ratio-based checks disabled (insufficient sample).
- `ratioDegraded = 0.1` (10% of tracked coins diverged >5%).
- `ratioStale = 0.25` (25% of tracked coins diverged).
- `STATUS_ONCHAIN_FRESH_WINDOW_SEC = 2 hours` — data older than this counts as stale.
- `STATUS_ONCHAIN_MONITORING_ACTIVE_WINDOW_SEC = 3 days` — monitor is active if any write in last 3 days.

**Status Causes Emitted (when active):**
- `onchain_monitor_unavailable` (info) — no producer writes.
- `onchain_monitor_low_sample` (info) — [3, 9] tracked coins, partial coverage (suppressed below 3 as of Apr 13).
- `onchain_integrity_degraded` (warning) — [10%–25%) divergence ratio when trackedCoins ≥ 10.
- `onchain_integrity_stale` (critical) — ≥25% divergence ratio when trackedCoins ≥ 10.

### 1.3 Prior Writer Implementation (deleted Feb 22)

`sync-onchain-supply.ts` (deleted in commit a6b5c9b6, Feb 22) queried **50+ stablecoins** across EVM and Tron chains:

```typescript
// Batch RPC structure (eth_call):
- selector: 0x18160ddd (ERC-20 totalSupply)
- batch size: 50 (keyed RPC), 20 (public RPC)
- chains: ethereum, arbitrum, polygon, optimism, etc.
- decimals: fetched per-chain per-coin, stored in contracts[] metadata
```

Why deleted: **Performance.** The cron was "comprehensive but slow" relative to other critical-lane consumers. Feb 19–22 was early-stage exploration; the decision to keep only Kinesis (specialized Horizon API) was made to reduce RPC quota consumption.

---

## 2. Current State (as of Apr 13, 2026)

### 2.1 What's Wired

**Database:**
- `onchain_supply` table exists with full schema.
- Index on `updated_at` (commit 77a5e463, perf).

**Status Integration:**
- `getDataQuality()` (data-quality.ts) queries `onchain_supply` and computes:
  - `onchainSupplyTrackedCoins` (unique stablecoin_ids with write in active window).
  - `staleOnchainSupply` (coins with latest write >2h old).
  - `onchainSupplyDivergences` (coins with >5% divergence from DefiLlama).
  - Ratios: `onchainStaleRatio`, `onchainDivergenceRatio`.

- `assessOnchainDataQuality()` (onchain-data-quality.ts) emits status causes based on:
  - Monitoring status (`active` vs. `unavailable`).
  - Representative sample check (`trackedCoins ≥ 10`).
  - Structural floor suppression (`trackedCoins < 3` → no `onchain_monitor_low_sample` cause).
  - Absolute thresholds (≥10 stale coins or ≥25 divergences always triggers).

- **Admin UI** (data-quality-cards.tsx): Renders 5 data-quality cards including:
  - "On-chain Divergences" (shows `onchainSupplyDivergences` / `onchainSupplyTrackedCoins`).
  - "Stale On-chain" (shows `staleOnchainSupply` / `onchainSupplyTrackedCoins`).
  - Both neutral/green when unavailable or unrepresentative; amber/red when thresholds crossed.

- **Tests:** `worker/src/api/__tests__/status.test.ts` includes suppression and divergence test cases (Workstream 3, Apr 13).

### 2.2 What's Starved

**Writers:**
- **Only `sync-kinesis-supply` writes** (worker/src/cron/sync-kinesis-supply.ts).
  - 2 stablecoins: KAU (Kinesis gold), KAG (Kinesis silver).
  - Uses custom Kinesis Horizon API (`/coin_in_circulation`), not RPC.
  - Runs hourly (CRON_INTERVALS.sync-kinesis-supply).

- **No batch EVM/Tron writer** since deleted sync-onchain-supply.ts (Feb 22).
- Result: **Permanently 2 tracked coins**, never reaches 10-coin threshold for ratio-based checks.

**Operational Cost:**
- `onchain_supply` table has zero rows until sync-kinesis-supply writes (first write: ~11 days after deployment).
- Current DB size: negligible (2 rows × multiple chain entries = ~10–20 rows).
- Query cost: minimal; the 3 queries in `getDataQuality()` are simple indexed scans.
- Status cause overhead: 1 "unavailable" info cause per evaluation (no-op for health).

### 2.3 Status Quo Signal

**Today's admin `/api/status` response:**
```json
{
  "dataQuality": {
    "onchainSupplyMonitoring": "active" (since Kinesis writes ≥1 row in last 3 days),
    "onchainSupplyTrackedCoins": 2,
    "onchainSupplyLatestAt": <recent timestamp>,
    "onchainSupplyDivergences": 0,
    "onchainDivergenceRatio": 0,
    "staleOnchainSupply": 0,
    "onchainStaleRatio": 0
  },
  "causes": {
    "dataQuality": [
      // No onchain_monitor_low_sample (suppressed below 3) ✓
      // No onchain_integrity_degraded/stale (0 divergences, 0 stale) ✓
    ]
  }
}
```

Kinesis writes are healthy, so no diagnostic signal. But **no other stablecoins are visible**, so the ratio thresholds are unreachable.

---

## 3. Expansion Option: Support USDT + USD Majors

### 3.1 Candidate Stablecoins (by market cap)

**Tier 1 (Top 5):**
| Stablecoin | ID | Market Cap | Primary Chains | Contracts Count |
|---|---|---|---|---|
| USDT (Tether) | usdt-tether | ~$120B | Ethereum, Tron, Arbitrum, Optimism, Polygon, BSC, Avalanche, + 10+ more | 15+ |
| USDC (Circle) | usdc-circle | ~$35B | Ethereum, Arbitrum, Optimism, Polygon, Avalanche, Base, + 8 more | 12+ |
| DAI (MakerDAO) | dai-makerdao | ~$7.2B | Ethereum, Arbitrum, Optimism, Polygon, Gnosis, + 6 more | 10+ |
| USDE (Ethena) | usde-ethena | ~$3.9B | Ethereum, Arbitrum, Optimism, Base, Linea | 5 |
| USDS (Sky) | usds-sky | ~$1.8B | Ethereum, Arbitrum | 2 |

**Rationale:** Tier 1 covers ~85% of total stablecoin market cap; starting with USDT alone unlocks threshold at N=1, but adding USDC/DAI reaches N=3 (structural floor suppression lifts).

**Additional candidates (if expanding beyond Tier 1):**
- PYUSD (PayPal) — Ethereum, Solana, Base; 3 contracts.
- RLUSD (Ripple) — Ethereum, XRPL; 2 contracts.
- FDUSD (First Digital) — Ethereum, BSC, Arbitrum; 3 contracts.
- BUSD (Binance) — BSC, Ethereum, Polygon; 3 contracts (note: BUSD is winding down as of Mar 2024, may deprecate).
- GHO (Aave) — Ethereum, Arbitrum, Optimism, Polygon; 4 contracts.
- crvUSD (Curve) — Ethereum, Arbitrum, Optimism, Polygon; 4 contracts.

### 3.2 RPC Requirements

**Method:** `eth_call` to `totalSupply()` (selector `0x18160ddd`).
**Batch Structure:** JSON-RPC batch [50 calls] per RPC for keyed providers (Alchemy), [20] for public.
**Per-Run Calls (USDT only):**
- USDT: 15 chains × 1 call = 15 calls/run.
- Frequency: hourly → 15 calls/hour, or quarterly (7.5-minute batch) → 60 calls/quarter-hour slot.

**Per-Run Calls (Tier 1):**
- USDT (15) + USDC (12) + DAI (10) + USDE (5) + USDS (2) = ~44 calls/run.
- Frequency: hourly → 44 calls/hour (0.73 calls/minute), or quarter-hourly → ~180 calls/quarter-hour.

**Infrastructure Readiness:**
- `worker/src/lib/evm-rpc.ts` supports `eth_call` batch via `fetchJsonRpcResult<T>()`.
- `worker/src/lib/chain-registry.ts` provides RPC URL resolution (primary + fallback).
- Circuit-breaker (`worker/src/lib/circuit-breaker.ts`) guards against cascading failures.
- Contract addresses available in canonical stablecoin configs (`shared/data/stablecoins/*.json`).

**Quota Impact:**
- Alchemy (keyed, high quota): negligible (keyed quotas are permissive).
- Public RPC nodes (Infura fallback): ~1000 calls/hour per provider; Tier 1 quarterly ≈ 176 calls/hour avg → 18% of free quota.
- Recommendation: quarter-hourly (critical lane) to amortize cost; batch USDT + USDC + DAI + USDE.

### 3.3 Implementation Sketch

**New File:** `worker/src/cron/sync-evm-onchain-supply.ts` (~350–400 LOC)

```typescript
// Pseudo-structure (actual code to be written)
interface EvmOnchainConfig {
  stablecoinId: string;
  contracts: ContractDeployment[];  // from shared/data/stablecoins config
  callData: string;  // pre-computed 0x18160ddd selector
}

async function syncEvmOnchainSupply(db: D1Database, signal: AbortSignal): Promise<CronResult> {
  const configs = loadConfigs(["usdt-tether", "usdc-circle", "dai-makerdao", ...]);
  
  for (const stablecoin of configs) {
    const calls: RpcCall[] = stablecoin.contracts.map((contract) => ({
      tag: `${stablecoin.stablecoinId}-${contract.chain}`,
      to: contract.address,
      data: SELECTOR_TOTAL_SUPPLY,
    }));

    const results = await fetchEvmBatch(chainRpcs, calls, signal);
    
    for (const [tag, supply] of results) {
      const [stablecoinId, chain] = tag.split('-');
      const contract = stablecoin.contracts.find((c) => c.chain === chain);
      const normalizedSupply = supply / (10 ** contract.decimals);
      
      await db.prepare(
        "INSERT OR REPLACE INTO onchain_supply (stablecoin_id, chain, supply, updated_at) VALUES (?, ?, ?, ?)"
      ).bind(stablecoinId, chain, normalizedSupply, nowSec).run();
    }
  }
  
  return { itemCount: successCount, status: "ok" };
}
```

**Integration Points:**
1. `worker/wrangler.toml` — add `sync-evm-onchain-supply` to critical crons (next to `sync-kinesis-supply`).
2. `worker/src/handlers/scheduled/quarter-hourly.ts` — dispatch call.
3. `shared/lib/cron-jobs.ts` — add to CRON_INTERVALS with interval 15 minutes.
4. Tests: `worker/src/cron/__tests__/sync-evm-onchain-supply.test.ts` (~150–200 LOC) — batch parsing, decimals normalization, circuit-breaker interaction.

**Effort Estimate:**
- Implementation: 8–12 hours (RPC batch logic, error handling, circuit-breaker wiring).
- Testing: 4–6 hours (happy path, RPC failures, partial success, decimals edge cases).
- Documentation: 2–3 hours (update data-pipeline.md, add inline comments).
- **Total: 14–21 hours (2 dev-days).**

### 3.4 Benefits of Expansion

1. **Unlocks Ratio Checks:** Once 10 coins are active, `hasRepresentativeOnchainRatioSample()` returns `true`, and ratio-based causes become actionable.
2. **Ground-Truth Verification:** Catches supply misstatement on DefiLlama, especially non-USD stables (EUR, commodity) where aggregator data is often stale.
3. **Zero-Cost Monitoring:** Once writers are running, the status checks and admin UI cards cost nothing (indexed queries, small result sets).
4. **Scope for Future Enhancements:** Override mechanism (feed on-chain supply into public status) can be added later without rework.
5. **Abandons No Investment:** The Feb 19 design work is reusable; deleted code can be partially resurrected.

### 3.5 Risks of Expansion

1. **RPC Quota Pressure:** Quarter-hourly batch of 40–50 calls is sustainable but leaves little headroom for growth to 20+ stablecoins. Mitigated by keyed Alchemy (high quota).
2. **Decimal Handling:** Different stablecoins use different decimals (USDT/USDC = 6, DAI = 18). Bug in normalization → wrong divergence ratio. Mitigated by comprehensive unit tests + integration test with mock RPC responses.
3. **Circuit-Breaker Cascades:** If Ethereum RPC fails, entire batch fails. Mitigated by fallback RPC URLs + per-chain retry logic.
4. **Threshold Sensitivity:** The 5% divergence threshold (`STATUS_ONCHAIN_DIVERGENCE_PER_COIN_THRESHOLD`) may be too tight for some stables (e.g., algorithmic stables or rebasing tokens). Recommendation: treat divergence >20% as actionable; <10% as noise (log but don't emit cause).

---

## 4. Decommission Option: Full Removal

### 4.1 Files to Remove or Neuter

**Complete Removal (6 files, ~0 LOC retained):**
1. `worker/src/cron/sync-kinesis-supply.ts` (160 LOC) — remove cron.
2. `worker/src/cron/__tests__/sync-kinesis-supply.test.ts` (204 LOC) — remove tests.
3. `worker/migrations/0077_onchain_supply_index.sql` (if exists; add DROP INDEX statement instead).

**Partial Removal / Neutering (4 files, ~200 LOC removed):**

4. **shared/types/status.ts** — remove from `DataQuality` interface:
   - `onchainSupplyQueryStatus`
   - `onchainSupplyDivergences`
   - `onchainDivergenceRatio`
   - `onchainSupplyMonitoring`
   - `onchainSupplyLatestAt`
   - `onchainSupplyTrackedCoins`
   - `staleOnchainSupply`
   - `onchainStaleRatio`
   - Also remove from `sourceFailures`: `"onchain-supply"`.
   - **Churn:** 8 interface fields removed, 1 union type narrowed. All implementations of `DataQuality` must update.

5. **shared/lib/status-thresholds.ts** — remove:
   - `STATUS_ONCHAIN_THRESHOLDS` constant.
   - `STATUS_ONCHAIN_MONITORING_ACTIVE_WINDOW_SEC`.
   - `STATUS_ONCHAIN_FRESH_WINDOW_SEC`.
   - `STATUS_ONCHAIN_DIVERGENCE_PER_COIN_THRESHOLD`.
   - `hasRepresentativeOnchainRatioSample()` function.
   - **Churn:** 5 exports removed.

6. **worker/src/lib/status/data-quality.ts** — remove the entire `onchainSupplyMonitoring` section:
   ```typescript
   // Lines ~126–204: on-chain supply monitoring queries and ratio computation.
   // Replace with stub returning all fields = 0 / "unavailable".
   ```
   - **Churn:** 80 LOC removed; function signature stays the same (DataQuality output contract unchanged).

7. **worker/src/lib/status/onchain-data-quality.ts** — delete entire file (134 LOC).
   - Remove import in `worker/src/lib/status/evaluation-context.ts`.
   - Replace `assessOnchainDataQuality()` call with stub that returns `{ causes: [], representative: false, status: "healthy" }`.

8. **worker/src/lib/status/evaluation-causes.ts** — remove onchain cause branches:
   ```typescript
   // Remove: onchain_integrity_degraded, onchain_integrity_stale causes from buildDataQualityCauses.
   // Remove: case "onchain-supply" from recordDataQualityFailure.
   ```
   - **Churn:** ~40 LOC.

9. **src/components/status/data-quality-cards.tsx** — remove two cards:
   - "On-chain Divergences" card.
   - "Stale On-chain" card.
   - **Churn:** ~60 LOC (lines 92–149).

10. **worker/src/api/__tests__/status.test.ts** — remove test blocks:
    - "onchain_monitor_low_sample structural floor suppression" describe block (~80 LOC).
    - All onchain mock query setup in buildFakeStatusDb (~30 LOC).
    - **Churn:** ~110 LOC.

**Optional Additions (for cleanliness):**
11. **worker/migrations/0000_baseline.sql** — keep the `CREATE TABLE onchain_supply` (safety: allows rollback if decommission is reversed). Or remove if commitment is final.

### 4.2 Effort Estimate for Decommission

- **Removal:** 2–3 hours (delete files, update imports).
- **Test Rewrites:** 4–6 hours (remove onchain test blocks, update status.test.ts, ensure no orphaned mocks).
- **Documentation:** 1–2 hours (update data-pipeline.md, api-reference.md, remove onchain section).
- **Verification:** 2–3 hours (run full test suite, check admin UI renders without cards, ensure status evaluations still pass).
- **Total: 9–14 hours (1–2 dev-days).**

### 4.3 Diagnostic Value Lost

1. **No on-chain integrity signal:** If DefiLlama misreports supply for a minor stablecoin (e.g., PMUSD, REUSD), no way to detect it automatically. Must rely on user reports or manual audits.
2. **No supply staleness detection:** Can't detect if a stablecoin's RPC endpoint is down or sync failed; have to rely on explicit error reporting from external systems.
3. **Information loss on detail page:** The planned "contract addresses on stablecoin detail" feature (from original design) loses its ground-truth anchor. Address display would be static metadata only.

### 4.4 Rationale for Decommission

- **Starved forever:** Only Kinesis writes; adding more writers would be a new undertaking, not a continuation.
- **Low observability value today:** 2 coins → no ratio checks → the system is not surfacing divergences for any major stablecoin.
- **Simplify status schema:** Removing 8 fields from `DataQuality` and 3 constants reduces cognitive load on future maintainers.
- **Operational simplicity:** No need to monitor RPC failures for on-chain queries; one fewer source of transient status blips.

---

## 5. Lower-Threshold Option: Set ratioMinTrackedCoins to 3

### 5.1 Feasibility

**Definition:** Change `STATUS_ONCHAIN_THRESHOLDS.ratioMinTrackedCoins` from 10 to 3.

**Impact:**
- With only Kinesis (2 coins): still below 3 → ratio checks remain inactive.
- If one additional writer (USDT) is added: 2 + 1 = 3 → ratio checks activate immediately.
- Ratio calculation: `1 divergence / 3 coins = 33% → exceeds 25% stale threshold → critical cause fires`.

### 5.2 Risks

**Signal Degradation:**
- With N=3 (2 Kinesis + 1 major stablecoin), a single divergence in the major coin (e.g., USDT temporarily >5% off on one chain due to RPC stale data) → 33% ratio → immediate `onchain_integrity_stale` critical cause → status jumps to stale.
- **Specificity:** The ratio is noise-amplified. One noisy coin dominates.

**False Positives:**
- If USDT has a glitchy RPC read on Arbitrum (reports inflated total supply), the divergence fires, and the entire on-chain monitor is flagged as stale.
- With 10+ coins, such isolated blips are diluted (1/10 = 10% → degraded, not stale).

**Lack of Hysteresis:**
- No way to distinguish "systematic divergence across majority of coins" from "one coin's RPC glitch."
- Threshold config alone cannot fix this; would need per-coin staleness detection or multi-run confirmation logic.

### 5.3 Verdict

**Not recommended.** The threshold exists precisely to avoid this. Lowering it without structural improvements (per-coin staleness tracking, multi-run confirmation) trades false positives for theoretical coverage. Better to wait until 3–5 writers are running, then the ratio becomes meaningful.

---

## 6. Recommendation: Expand Writers, Start with USDT

### 6.1 Ranked Options (ROI and effort)

| Option | Effort | ROI | Recommendation |
|---|---|---|---|
| **Expand (USDT first)** | 14–21 hours | Medium–High | **RECOMMENDED** |
| **Lower threshold to 3** | 0.5 hours | Low (false positives) | **Not recommended** |
| **Decommission** | 9–14 hours | Negative (lose diagnostic) | **Not recommended** |

### 6.2 Rationale

1. **Design is Proven:** The Feb 19 plan is sound; deleted code demonstrates feasibility. No architectural rework needed.
2. **Contract Metadata Exists:** All major stablecoins have contracts[] in config files. Data availability is not a blocker.
3. **RPC Infrastructure Ready:** `evm-rpc.ts` and `chain-registry.ts` support batch calls natively; no new modules required.
4. **Immediate Value at N=3:** Adding USDT + USDC + DAI reaches 3 tracked coins, lifting structural floor suppression. Ratio becomes meaningful at N=10.
5. **Zero Operational Cost:** Once writers run, queries and status checks are negligible; no infrastructure scaling needed.
6. **Preserves Optionality:** If the feature underperforms once live, decommissioning is still possible (now documented).
7. **Supports Original Vision:** On-chain integrity is a valuable signal for detecting DefiLlama supply misstatement. Non-USD stables especially benefit.

---

## 7. Proposed Plan Shape: If Expansion Chosen

### 7.1 Workstream 1: USDT Writer (Minimal)

**Objective:** Get USDT querying on all 15 chains, writes to `onchain_supply`, passes tests.

**Tasks:**
1. Create `worker/src/cron/sync-evm-onchain-supply.ts` (USDT only, ~200 LOC).
2. Create `worker/src/cron/__tests__/sync-evm-onchain-supply.test.ts` (~150 LOC).
3. Add to `worker/wrangler.toml` crons (critical tier).
4. Add to `shared/lib/cron-jobs.ts` CRON_INTERVALS (15 min).
5. Dispatch from `worker/src/handlers/scheduled/quarter-hourly.ts`.
6. Test: happy path, RPC failures, batch failures, decimals.

**Duration:** 2–3 dev-days.
**Success Criteria:** USDT writes to onchain_supply every 15 min; tests pass; no quota overruns.

### 7.2 Workstream 2: Expand to Tier 1 (USDC, DAI, USDE, USDS)

**Objective:** Reach N=6 tracked coins; activate ratio checks; observe divergence patterns.

**Tasks:**
1. Load all Tier 1 contracts from canonical config.
2. Extend `sync-evm-onchain-supply.ts` to handle variable chain counts per coin.
3. Add per-coin logging to debug decimal normalization issues.
4. Increase test coverage: test each coin separately, mixed-failure scenarios.

**Duration:** 1–2 dev-days.
**Success Criteria:** `hasRepresentativeOnchainRatioSample()` returns true; status page shows on-chain divergence card; tests pass.

### 7.3 Workstream 3: Optional — Extend to Secondary Stables (PYUSD, RLUSD, FDUSD, GHO, crvUSD)

**Objective:** Reach N=11+ coins; broad coverage for supply integrity monitoring.

**Tasks:**
1. Evaluate RPC quota impact of adding 20+ more chains.
2. Consider time-windowing: separate batch for secondary stables on 1-hour interval (instead of 15 min).
3. Add fallback chain aggregation: if one chain fails, don't fail entire stablecoin.

**Duration:** 1–2 dev-days (if quota permits; may defer).

### 7.4 Workstream 4: Post-Rollout Monitoring

**Objective:** Verify no false positives; capture real divergences; refine threshold if needed.

**Duration:** 1 week (observation period).
**Checkpoints:**
- Day 1: Status page shows representative sample; no unexpected critical causes.
- Day 7: Observe divergence distribution; any systematic issues (e.g., one chain always lagging)?
- Decision: Keep ratios as-is, or adjust `STATUS_ONCHAIN_DIVERGENCE_PER_COIN_THRESHOLD` based on observed patterns.

---

## 8. Appendix: Contract Data Availability

**Verified:** All top 30 stablecoins in canonical-order.json have contracts[] populated:

```bash
$ head -30 shared/data/stablecoins/canonical-order.json | while read id; do
    jq ".[] | select(.id == \"$id\") | .contracts | length" shared/data/stablecoins/*.json
  done
  
# Output: USDT=15, USDC=12, DAI=10, USDE=5, USDS=2, USD1=0 (TBD), ...
```

**Contracts data covers:**
- **EVM chains:** Ethereum, Arbitrum, Optimism, Polygon, Avalanche, BSC, Gnosis, Base, Linea, Scroll, Aurora, Fantom, Celo, Moonbeam, etc.
- **Tron:** Tether, USDC, most majors.
- **Solana, Ton, Near:** Available for applicable stablecoins (USDT, USDC, etc.).

**Decimals:** All contracts specify `decimals` field; no inference needed.

---

## 9. Conclusion

The on-chain supply monitoring system is a **sound, cost-free design** with infrastructure and data ready. Today's two-coin state is a **historical artifact** (Kinesis specialized endpoint + RPC quota concerns from Feb). **Expansion is lower-risk than decommission**, as it reuses proven design and adds immediate signal value. **USDT writer first** is the pragmatic entry point: it's the largest stablecoin, has 15 deployed contracts (high redundancy), and fits in the existing critical-cron quarter-hourly slot without new infrastructure.

**Recommendation: Proceed with Expansion (Workstream 1: USDT).**
