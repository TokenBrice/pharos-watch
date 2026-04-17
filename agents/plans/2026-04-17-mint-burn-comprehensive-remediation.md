# Mint-Burn Flows Comprehensive Remediation & Expansion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix critical data-accuracy bugs (CCIP/CCTP bridge-mint mis-classification, Bank Run Gauge mcap weighting, reUSD counterparty extraction, LayerZero false negatives, atomic-roundtrip detector edge cases), harden ingestion reliability and observability, optimize the lone unindexed query, and lay multi-chain EVM groundwork without expanding chain scope yet.

**Architecture:** Surgical fixes inside the existing `mint-burn-pipeline/*`, `mint-burn-bridge-classifier`, `mint-burn-flows`, and cron orchestrator modules. One D1 migration adds a single index; no schema redesign. One backfill operation re-classifies historical rows after the bridge-mint fix lands. Methodology bumps to **v6.0** because the gauge fix changes published numbers.

**Tech Stack:** TypeScript strict, Vitest, Cloudflare Workers + D1, React 19 + TanStack Query, Alchemy JSON-RPC.

---

## Scope Decisions

**In scope:**
- All correctness bugs surfaced by the 2026-04-17 audit (Phase 1).
- Resilience hardening for things that silently fail today (Phase 2).
- One missing index + cache invalidation hook + classifier refactor (Phase 3).
- Observability metrics that exist as ad-hoc logs but aren't structured (Phase 4).
- Multi-chain EVM groundwork: validate that Arbitrum support post-USDai is generic enough to accept Base/Optimism/BSC etc., add chain-registry hooks, but **do NOT add new per-chain coin configs in this plan** — those land in a follow-on plan once the foundation is shipped (Phase 5).
- Methodology v6.0 bump + docs (Phase 6).

**Out of scope (separate initiatives):**
- Tron TRC-20 adapter and Solana SPL adapter — both require new non-EVM RPC stacks; tracked as appendix items.
- Per-chain coin configs for Base/BSC/Polygon/Optimism/Avalanche — wave them in after the multi-chain groundwork lands; one chain per follow-on plan with explicit per-token validation.
- Stargate / Across / Fraxferry / Hop / Synapse bridge detection — gated on future validation queries; Phase 0 Q1-Q5 cover CCIP/CCTP/reUSD/roundtrip/null-price only. When the operator is ready to evaluate these protocols, add a Phase-0-equivalent query that isolates burns with unknown counterparties in suspected bridge windows (per-protocol research required to identify their known router/pool addresses first). Only build detection for protocols whose query reveals >$1M/30d of misclassification.
- Frontend bundle-size cleanup of duplicated `flow-*.tsx` components — defer; the existing `mint-burn-coin-helpers` extraction (commit 86cd1006) already DRY'd the worst of it.

**Confirmed non-issues from the audit (skip):**
- Hook `staleTime` is **already** `CRON_20MIN` (verified at `src/hooks/use-mint-burn-flows.ts:89,111,149`). One audit subagent mis-read this; no fix needed.
- `findMintBurnHistoricalPrice` null guard is already present (`parse.ts:21` checks `historical?.price != null` after commit 5ff8586e).
- `recalcAffectedHours` finally-block already exists (commit 7c23c17c). The remaining issue is that the failure isn't **propagated** to the run status — addressed in Task 7.
- `mint-burn-coverage-expansion.md` (untracked draft) is now stale: Tier 1 (6 ETH coins) and Tier 2 (CCTP) shipped via commits 29accf66 and 831812bb. Task 6.3 retires it.

---

## File Map

| Phase | Task | Files Modified | Files Created |
|-------|------|----------------|---------------|
| 0 | Validation queries | — | `agents/research/2026-04-17-mint-burn-pre-fix-baseline.md` |
| 1 | 1.1 CCIP/CCTP mint parity | `worker/src/lib/mint-burn-bridge-classifier.ts`, `worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts` | — |
| 1 | 1.2 LayerZero endpoint-only | `worker/src/lib/mint-burn-bridge-classifier.ts`, `worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts` | — |
| 1 | 1.3 Custom counterparty encoding | `worker/src/lib/evm-logs.ts`, `worker/src/lib/mint-burn-contracts.ts`, `worker/src/lib/mint-burn-pipeline/parse.ts`, `worker/src/lib/__tests__/mint-burn-pipeline.test.ts` | `worker/src/lib/__tests__/evm-logs.test.ts` (if absent) |
| 1 | 1.4 Roundtrip amount-match | `worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts`, `worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts`, `worker/src/lib/__tests__/mint-burn-roundtrip.test.ts` | — |
| 1 | 1.5 Roundtrip empty-tx guard | `worker/src/lib/__tests__/mint-burn-roundtrip.test.ts` | — |
| 1 | 1.6 Gauge canonical-chain mcap | `worker/src/api/mint-burn-flows.ts`, `worker/src/lib/mint-burn-canonical-chain.ts`, `worker/src/api/__tests__/mint-burn-flows.test.ts` | `worker/src/lib/__tests__/mint-burn-canonical-mcap.test.ts` |
| 1 | 1.7 Historical reclassification | `worker/src/api/backfill-mint-burn.ts`, `worker/src/api/reclassify-atomic-roundtrips.ts`, `worker/src/api/__tests__/backfill-mint-burn.test.ts`, `worker/src/api/__tests__/reclassify-atomic-roundtrips.test.ts` | — |
| 2 | 2.1 Bridge-config Zod validation | `worker/src/lib/mint-burn-contracts.ts`, `worker/src/lib/__tests__/mint-burn-contracts.test.ts` | — |
| 2 | 2.2 Recalc failure propagation | `worker/src/cron/sync-mint-burn.ts`, `worker/src/cron/__tests__/sync-mint-burn.test.ts` | — |
| 2 | 2.3 Stuck-config grace period | `worker/src/cron/mint-burn/run-state.ts`, `worker/src/cron/mint-burn/run-configs.ts`, `worker/src/cron/__tests__/sync-mint-burn.test.ts` | `worker/migrations/0096_mint_burn_config_deferral.sql` |
| 2 | 2.4 Concurrent tx-context fetch | `worker/src/lib/mint-burn-pipeline/classification.ts`, `worker/src/lib/__tests__/mint-burn-pipeline.test.ts` | — |
| 3 | 3.1 flow_type index | — | `worker/migrations/0097_mbe_flow_type_ts_index.sql` |
| 3 | 3.2 Cache invalidation on cron | `worker/src/cron/sync-mint-burn.ts`, `worker/src/api/mint-burn-flows-shared.ts`, `worker/src/cron/__tests__/sync-mint-burn.test.ts` | — |
| 3 | 3.3 Bridge-classifier strategy split | `worker/src/lib/mint-burn-bridge-classifier.ts` | `worker/src/lib/mint-burn-bridge-classifier-protocols.ts`, `worker/src/lib/__tests__/mint-burn-bridge-classifier-protocols.test.ts` |
| 4 | 4.1 Run metadata metrics | `worker/src/cron/mint-burn/run-completion.ts`, `worker/src/lib/mint-burn-pipeline/price-heal.ts`, `worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts`, `worker/src/cron/__tests__/sync-mint-burn.test.ts` | — |
| 4 | 4.2 Subrequest budget metric | `worker/src/cron/sync-mint-burn.ts`, `worker/src/cron/mint-burn/run-completion.ts` | — |
| 5 | 5.1 Multi-chain config audit | `worker/src/cron/mint-burn/chain-context.ts`, `worker/src/cron/mint-burn/run-configs.ts`, `worker/src/cron/__tests__/sync-mint-burn-multichain.test.ts` (new) | — |
| 5 | 5.2 Per-chain mcap helper | `worker/src/lib/mint-burn-canonical-chain.ts` | `worker/src/lib/__tests__/mint-burn-tracked-chains.test.ts` |
| 6 | 6.1 Methodology version bump | `shared/lib/mint-burn-flow-version.ts`, `shared/lib/__tests__/mint-burn-flow-version.test.ts`, `src/app/methodology/mint-burn-flow-changelog/page.tsx` | — |
| 6 | 6.2 Doc updates | `docs/mint-burn-flows.md`, `docs/mint-burn-flows-timeline.md` | — |
| 6 | 6.3 Retire stale draft | — | move/delete `agents/plans/mint-burn-coverage-expansion.md` |

---

## Phase 0: Validation Queries (run before any code changes)

### Task 0.1: Capture pre-fix baseline volumes

**Why:** Quantify the magnitude of each bug before fixing so we (a) know whether the fix is worth the methodology bump and (b) have a regression check after backfill.

**Files:**
- Create: `agents/research/2026-04-17-mint-burn-pre-fix-baseline.md`

- [ ] **Step 1: Run baseline queries via wrangler against production D1**

The operator (or you, with wrangler access) runs each query and pastes the output into the research file:

```bash
# Q1: CCIP coin bridge MINTS misclassified as standard (last 90d)
npx wrangler d1 execute pharos-db --remote --command \
  "SELECT stablecoin_id, COUNT(*) AS count, ROUND(SUM(amount_usd),0) AS volume_usd
   FROM mint_burn_events
   WHERE stablecoin_id IN ('usdo-openeden','usd1-world-liberty-financial','avusd-avant','zchf-frankencoin')
     AND direction='mint' AND flow_type='standard'
     AND timestamp >= strftime('%s','now')-86400*90
   GROUP BY stablecoin_id ORDER BY volume_usd DESC;"

# Q2: USDC and EURC CCTP-related burns currently classified as effective_burn
npx wrangler d1 execute pharos-db --remote --command \
  "SELECT stablecoin_id, COUNT(*) AS count, ROUND(SUM(amount_usd),0) AS volume_usd
   FROM mint_burn_events
   WHERE stablecoin_id IN ('usdc-circle','eurc-circle')
     AND direction='burn' AND burn_type='effective_burn'
     AND counterparty='0xfd78ee919681417d192449715b2594ab58f5d002'
     AND timestamp >= strftime('%s','now')-86400*90
   GROUP BY stablecoin_id;"

# Q3: reUSD events with NULL counterparty (bug B1.3)
npx wrangler d1 execute pharos-db --remote --command \
  "SELECT direction, COUNT(*) AS total,
          SUM(CASE WHEN counterparty IS NULL THEN 1 ELSE 0 END) AS null_cp,
          ROUND(100.0*SUM(CASE WHEN counterparty IS NULL THEN 1 ELSE 0 END)/COUNT(*),1) AS null_pct
   FROM mint_burn_events WHERE stablecoin_id='reusd-re-protocol' GROUP BY direction;"

# Q4: Atomic-roundtrip rows with mint != burn amount (potential false positives, B1.4)
npx wrangler d1 execute pharos-db --remote --command \
  "WITH grp AS (
     SELECT tx_hash, stablecoin_id,
       SUM(CASE WHEN direction='mint' THEN amount ELSE 0 END) AS mint_amt,
       SUM(CASE WHEN direction='burn' THEN amount ELSE 0 END) AS burn_amt
     FROM mint_burn_events
     WHERE flow_type='atomic_roundtrip'
       AND timestamp >= strftime('%s','now')-86400*30
     GROUP BY tx_hash, stablecoin_id)
   SELECT COUNT(*) AS rt_groups,
          SUM(CASE WHEN ABS(mint_amt-burn_amt) > 0.005*MAX(mint_amt,burn_amt) THEN 1 ELSE 0 END) AS mismatched
   FROM grp;"

# Q5: NULL price backlog distribution (operational health)
npx wrangler d1 execute pharos-db --remote --command \
  "SELECT stablecoin_id, COUNT(*) AS null_rows
   FROM mint_burn_events WHERE amount_usd IS NULL
   GROUP BY stablecoin_id ORDER BY null_rows DESC LIMIT 20;"

# Q6: USDC + USDT supply by chain (drives gauge weighting fix urgency)
# SQLite's json_extract does NOT support JSONPath filter syntax (`?()`);
# fetch the full payload and grep the relevant asset client-side.
npx wrangler d1 execute pharos-db --remote --command \
  "SELECT substr(payload, 1, 8000) AS head FROM cache WHERE key='stablecoins-cache';" > /tmp/sc-head.txt
# Then manually inspect the file for usdc-circle and usdt-tether `circulating` maps,
# or pipe through a quick node one-liner:
#   node -e 'const d=require("/tmp/sc-head.txt"); ...'
# Simpler: fetch via the public API and parse JSON locally:
curl -s 'https://api.pharos.watch/api/stablecoins' \
  | jq '.peggedAssets[] | select(.id=="usdc-circle" or .id=="usdt-tether") | {id, circulating}'
```

- [ ] **Step 2: Write the baseline file**

Capture each query's output verbatim with a 1-sentence interpretation. Save as `agents/research/2026-04-17-mint-burn-pre-fix-baseline.md`. Cite this file from each remediation task that depends on the metrics.

- [ ] **Step 3: Commit**

```bash
git add agents/research/2026-04-17-mint-burn-pre-fix-baseline.md
git commit -m "docs(mint-burn): capture pre-remediation baseline metrics"
```

---

## Phase 1: Critical Correctness Fixes

### Task 1.1: CCIP/CCTP classifier — tag bridge MINTS in addition to burns

**Why:** `classifyBridgeAwareBurnRows` at `worker/src/lib/mint-burn-bridge-classifier.ts:130-190` only iterates `burnRows`. The function name says "Burn" because the original CCIP design only tagged the burn side. But CCIP and CCTP both produce a destination-chain MINT in the same protocol, and on Ethereum we see destination MINTs when funds are returning from another chain. Today those mints leak into `flow_type='standard'` and inflate net mint volume. LayerZero OFT path correctly tags both directions (line 102-122). Affected: USDO, USD1, avUSD, ZCHF (CCIP) + USDC, EURC (CCTP) — six tracked coins.

**Deliberate behavior change (update existing tests):** The current code emits `burn_type='review_required'` with reason `'bridge-signal-with-unknown-pool'` when a burn in a bridge-signal tx has an unknown counterparty pool. The existing classifier tests assert this at lines 209-219 (CCIP) and 299-309 (CCTP) of `worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts`. After this fix, such rows become `flow_type='bridge_transfer'` + `burn_type='bridge_burn'` instead. We accept this as more aggressive-but-correct: a bridge-signal-bearing tx is a bridge tx, full stop, and an unknown-pool burn inside it is still a bridge burn, just through a pool we hadn't catalogued. The `'known-bridge-pool-without-bridge-signal'` review path is preserved (known-pool counterparty in a tx WITHOUT bridge signal still flags for operator triage). The `'tx-context-unavailable'` review path is also preserved.

**Files:**
- Modify: `worker/src/lib/mint-burn-bridge-classifier.ts:130-190`
- Modify: `worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts`

- [ ] **Step 1: Add a failing test for an isolated CCIP bridge mint**

Append to `worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { classifyBridgeAwareBurnRows, type MintBurnBridgeClassifiableRow, type MintBurnTxContext } from "../mint-burn-bridge-classifier";
import { ccipBridgeDetection } from "../mint-burn-contracts-helpers";

const CCIP_ROUTER = "0x80226fc0ee2b096224eeac085bb9a8cba1146f7d";
const CCIP_SEND_REQUESTED_TOPIC = "0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd";
const CCIP_SEND_SELECTOR = "0x96f4e9f9";

function row(overrides: Partial<MintBurnBridgeClassifiableRow> = {}): MintBurnBridgeClassifiableRow {
  return {
    id: "id-1", tx_hash: "0xtx1", direction: "mint",
    flow_type: "standard", counterparty: null, burn_type: null, burn_review_reason: null,
    ...overrides,
  };
}

describe("CCIP/CCTP classifier — bridge MINTS", () => {
  // CCIP pool address for ZCHF (per mint-burn-contracts.ts:200). Using a real
  // CCIP pool, not the CCTP TokenMinterV2, so the test stays semantically scoped.
  const CCIP_POOL_ZCHF = "0x9359cd75549dae00cdd8d22297bc9b13fbbe4b79";
  const detection = ccipBridgeDetection([CCIP_POOL_ZCHF]);

  it("tags an isolated CCIP bridge mint (no burn in same tx) as bridge_transfer", () => {
    const rows = [row({ direction: "mint", tx_hash: "0xa" })];
    const ctx = new Map<string, MintBurnTxContext | null>([
      ["0xa", {
        to: CCIP_ROUTER,
        inputSelector: CCIP_SEND_SELECTOR,
        logTopics: [CCIP_SEND_REQUESTED_TOPIC],
        logAddresses: [CCIP_ROUTER],
      }],
    ]);
    classifyBridgeAwareBurnRows(rows, detection, ctx);
    expect(rows[0].flow_type).toBe("bridge_transfer");
  });

  it("tags both mint and burn when both share a CCIP bridge tx", () => {
    const rows = [
      row({ direction: "mint", tx_hash: "0xb", id: "id-2" }),
      row({ direction: "burn", tx_hash: "0xb", id: "id-3", counterparty: CCIP_POOL_ZCHF }),
    ];
    const ctx = new Map<string, MintBurnTxContext | null>([
      ["0xb", { to: CCIP_ROUTER, inputSelector: CCIP_SEND_SELECTOR, logTopics: [CCIP_SEND_REQUESTED_TOPIC], logAddresses: [CCIP_ROUTER] }],
    ]);
    classifyBridgeAwareBurnRows(rows, detection, ctx);
    expect(rows[0].flow_type).toBe("bridge_transfer");
    expect(rows[1].flow_type).toBe("bridge_transfer");
    expect(rows[1].burn_type).toBe("bridge_burn");
  });

  it("does not tag a standard mint with no bridge signal", () => {
    const rows = [row({ direction: "mint", tx_hash: "0xc" })];
    const ctx = new Map<string, MintBurnTxContext | null>([
      ["0xc", { to: "0x1234", inputSelector: "0xabcd", logTopics: [], logAddresses: [] }],
    ]);
    classifyBridgeAwareBurnRows(rows, detection, ctx);
    expect(rows[0].flow_type).toBe("standard");
  });
});
```

- [ ] **Step 1b: Update existing review_required tests to reflect the behavior change**

Find lines 209-219 and 299-309 of `worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts` (the two `flags bridge signal with unknown pool as review_required` tests — one per CCIP/CCTP coin). Replace the assertions so they now assert the stricter classification:

```typescript
// OLD (to delete):
//   expect(row.burn_type).toBe("review_required");
//   expect(row.burn_review_reason).toBe("bridge-signal-with-unknown-pool");
// NEW (keep test scaffolding, change assertions):
    expect(row.flow_type).toBe("bridge_transfer");
    expect(row.burn_type).toBe("bridge_burn");
    expect(row.burn_review_reason).toBeNull();
```

Also rename each test from `flags bridge signal with unknown pool as review_required` to `tags bridge signal with unknown pool as bridge_transfer (aggressive: bridge tx = bridge rows)`.

- [ ] **Step 2: Run test — expect FAIL on the new cases AND on the updated existing cases**

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-bridge-classifier.test.ts
```

Expected: new test cases fail because mints stay `standard`; updated existing tests fail because burns are still `review_required`.

- [ ] **Step 3: Patch `classifyBridgeAwareBurnRows`** in `worker/src/lib/mint-burn-bridge-classifier.ts`

Replace lines 125–190 (the non-LayerZero path) with:

```typescript
  const poolSet = normalizeHexSet(detection.knownBridgePoolAddresses);
  const routerSet = normalizeHexSet(detection.knownBridgeRouterAddresses);
  const topicSet = normalizeHexSet(detection.bridgeSignalTopics);
  const selectorSet = normalizeHexSet(detection.bridgeSignalSelectors);

  for (const [txHash, txRows] of rowsByTx) {
    const ctx = txContextByHash.get(txHash) ?? null;

    // Compute per-burn pool flags (used for legacy review-required path)
    const burnRows = txRows.filter((row) => row.direction === "burn");
    const knownPoolFlags = burnRows.map((row) =>
      row.counterparty ? poolSet.has(row.counterparty.toLowerCase()) : false,
    );
    const hasKnownPoolBurn = knownPoolFlags.some(Boolean);

    if (!ctx) {
      // No tx context: keep legacy review-required for known-pool burns; mints stay standard
      for (let i = 0; i < burnRows.length; i++) {
        const row = burnRows[i];
        if (knownPoolFlags[i]) {
          row.burn_type = "review_required";
          row.burn_review_reason = "tx-context-unavailable";
        }
      }
      continue;
    }

    const ctxTopics = normalizeHexSet(ctx.logTopics);
    const hasBridgeTopic = hasSetIntersection(ctxTopics, topicSet);
    const selector = normalizeSelector(ctx.inputSelector);
    const to = ctx.to?.toLowerCase() ?? null;
    const hasRouterSelector = Boolean(to && selector && routerSet.has(to) && selectorSet.has(selector));
    const hasBridgeSignal = hasBridgeTopic || hasRouterSelector;

    // NEW: if a tx has a bridge signal, tag every row in the tx (mints + burns) as bridge_transfer.
    // This catches isolated bridge mints (destination chain) that have no burn pool counterparty.
    if (hasBridgeSignal) {
      markBridgeTransfer(txRows);
      continue;
    }

    // Legacy path for txs without bridge signal but with known-pool burn counterparty
    for (let i = 0; i < burnRows.length; i++) {
      const row = burnRows[i];
      if (knownPoolFlags[i]) {
        row.burn_type = "review_required";
        row.burn_review_reason = "known-bridge-pool-without-bridge-signal";
      }
    }
  }
```

- [ ] **Step 4: Run test — expect PASS, plus existing tests still pass**

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-bridge-classifier.test.ts
cd worker && npx vitest run src/lib/__tests__/mint-burn-pipeline.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/mint-burn-bridge-classifier.ts worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts
git commit -m "fix(mint-burn): tag CCIP/CCTP bridge mints as bridge_transfer (was burn-only)"
```

---

### Task 1.2: LayerZero classifier — accept endpoint-only bridge signals

**Why:** `classifyBridgeAwareBurnRows` LayerZero branch (lines 96-122) requires `touchesBridgeContract && (signal-topic-with-emitter || signal-selector)`. The April 8 USDai investigation (`agents/research/2026-04-08-usdai-mint-burn-bridge-investigation.md`) documented `tx 0x475e9c9b1dd0412cb5b192945f2b7c7d87c78d01c41a6aaef7fa53d2f04122da` where a LayerZero Executor mints USDai on Arbitrum without the OAdapter contract being in `to` or in the log addresses. That tx is currently misclassified as economic mint. The fix: accept the signal-topic+emitter combination as standalone evidence (the LayerZero endpoint emitting a `PacketDelivered` topic is itself a bridge fingerprint).

**Files:**
- Modify: `worker/src/lib/mint-burn-bridge-classifier.ts:96-122`
- Modify: `worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts`

- [ ] **Step 1: Add a failing LayerZero test** in `worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts`

```typescript
import { layerZeroOftBridgeDetection } from "../mint-burn-contracts-helpers";
import type { MintBurnBridgeDetectionConfig } from "../mint-burn-contracts";

describe("LayerZero OFT classifier — endpoint-only signal", () => {
  // Fixture references from agents/research/2026-04-08-usdai-mint-burn-bridge-investigation.md.
  // `layerZeroOftBridgeDetection` takes ONLY `knownBridgeContractAddresses`; the emitter
  // (LAYERZERO_ENDPOINT_V2), topics (PACKET_SENT/PACKET_DELIVERED), and selectors are
  // hardcoded inside the helper. We use those canonical defaults here.
  const ARB_LZ_ENDPOINT_V2 = "0x1a44076050125825900e736c501f859c50fe728c"; // same address shared across chains
  const PACKET_DELIVERED_TOPIC = "0x1ab700d4ced0c005b164c0f789fd09fcbb0156d4c2041b8a3bfbcd961cd1567f";
  const detection: MintBurnBridgeDetectionConfig = layerZeroOftBridgeDetection([
    "0xffa10065ce1d1c42fabc46e06b84ed8ffeb4bae5", // USDai OAdapter (Arb)
  ]);

  it("tags a LayerZero-Executor-only mint when endpoint emits PacketDelivered (no OAdapter touch)", () => {
    const rows = [row({ direction: "mint", tx_hash: "0xexec" })];
    const ctx = new Map<string, MintBurnTxContext | null>([
      ["0xexec", {
        to: "0x31cae3b7fb82d847621859fb1585353c5720660d", // LayerZero Executor
        inputSelector: "0x123456ab",
        logTopics: [PACKET_DELIVERED_TOPIC],
        logAddresses: [ARB_LZ_ENDPOINT_V2], // endpoint is in logs but OAdapter is NOT
      }],
    ]);
    classifyBridgeAwareBurnRows(rows, detection, ctx);
    expect(rows[0].flow_type).toBe("bridge_transfer");
  });

  // Documented tradeoff: the Arbitrum LayerZero endpoint is shared across many OFT
  // deployments. A tx that emits PacketDelivered for ANY OFT will now pass fingerprintC.
  // In the current pipeline the classifier is called with detection tied to a specific
  // coin, so an unrelated OFT tx won't affect coins whose mint/burn rows are absent from
  // that tx. The remaining risk is a shared tx where BOTH coins have rows — a mint of
  // tracked coin A in the same tx as a bridge of coin B is (conservatively) now tagged.
  // We accept this as a tradeoff for catching Executor-only mints; add a per-message
  // recipient-address decode step if real fallout emerges.
  it("tags a mint when LayerZero endpoint emits the signal (even without OAdapter touch)", () => {
    // Second detection config using a DIFFERENT known bridge contract.
    const otherOftDetection: MintBurnBridgeDetectionConfig = layerZeroOftBridgeDetection([
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
    const rows = [row({ direction: "mint", tx_hash: "0xsame" })];
    const ctx = new Map<string, MintBurnTxContext | null>([
      ["0xsame", {
        to: "0x31cae3b7fb82d847621859fb1585353c5720660d",
        inputSelector: "0x00000000",
        logTopics: [PACKET_DELIVERED_TOPIC],
        logAddresses: [ARB_LZ_ENDPOINT_V2],
      }],
    ]);
    classifyBridgeAwareBurnRows(rows, otherOftDetection, ctx);
    expect(rows[0].flow_type).toBe("bridge_transfer"); // documented tradeoff
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** (mint stays `standard`)

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-bridge-classifier.test.ts -t "endpoint-only signal"
```

- [ ] **Step 3: Patch the LayerZero branch** at `worker/src/lib/mint-burn-bridge-classifier.ts:117`

Change:
```typescript
      if (touchesBridgeContract && ((hasSignalTopic && hasExpectedEmitter) || hasSignalSelector)) {
        markBridgeTransfer(txRows);
      }
```
To:
```typescript
      // Bridge fingerprint = ANY of:
      //   (a) tx touches bridge contract AND has signal topic with expected emitter,
      //   (b) tx touches bridge contract AND has known signal selector,
      //   (c) endpoint signal topic emitted by expected emitter (catches Executor-only patterns).
      const fingerprintA = touchesBridgeContract && hasSignalTopic && hasExpectedEmitter;
      const fingerprintB = touchesBridgeContract && hasSignalSelector;
      const fingerprintC = hasSignalTopic && hasExpectedEmitter && signalEmitterSet.size > 0;
      if (fingerprintA || fingerprintB || fingerprintC) {
        markBridgeTransfer(txRows);
      }
```

The `signalEmitterSet.size > 0` guard prevents fingerprintC from firing when no emitter is configured (avoids false positives on bare topic matches).

- [ ] **Step 4: Run all classifier tests — expect PASS**

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-bridge-classifier.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/mint-burn-bridge-classifier.ts worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts
git commit -m "fix(mint-burn): detect LayerZero bridge tx via endpoint emitter alone (catches Executor-only mints)"
```

---

### Task 1.3: Custom-event counterparty extraction

**Why:** `parse.ts:71` hardcodes `topics[2]` for mints / `topics[1]` for burns. Works for ERC-20 `Transfer` and for reUSD's `InstantRedemptionRouted` (where `address indexed user` is `topics[1]`). Breaks for reUSD's `Deposited(address user, address token, uint256 amount)` where ALL params are unindexed — `topics[2]` doesn't exist, so counterparty is set to `null`. Phase 0 Q3 quantifies the impact. Other custom events with similar layouts will hit the same bug, so the fix should be general (per-event encoding, not a reUSD special case).

Helper placement: `decodeAddress` and `decodeUint256AtSlot` already live in `worker/src/lib/evm-logs.ts` (lines 48, 63). The new data-word reader belongs there too (one pattern, one file), not inlined in `parse.ts`. `decodeAddress` accepts 32-byte hex with or without `0x` prefix (see `evm-logs.ts:48-51`), so composing `decodeAddress(readDataWord(data, slot))` works without modification.

**Files:**
- Modify: `worker/src/lib/evm-logs.ts` (add `readDataWord` helper)
- Modify: `worker/src/lib/__tests__/evm-logs.test.ts` (unit coverage for the new helper; create the file if absent)
- Modify: `worker/src/lib/mint-burn-contracts.ts` (extend `MintBurnEventDef`, update reUSD configs)
- Modify: `worker/src/lib/mint-burn-pipeline/parse.ts` (consume new field)
- Modify: `worker/src/lib/__tests__/mint-burn-pipeline.test.ts`

- [ ] **Step 1: Add a failing parse test**

Append to `worker/src/lib/__tests__/mint-burn-pipeline.test.ts`:

```typescript
import { parseMintBurnLogs } from "../mint-burn-pipeline/parse";

const REUSD_DEPOSITED_TOPIC = "0xb4c03061fb5b7fed76389d5af8f2e0ddb09f8c70d1333abbb62582835e10accb";
const USER_DATA = "000000000000000000000000aaaa1111aaaa2222aaaa3333aaaa4444aaaa5555";
const TOKEN_DATA = "000000000000000000000000bbbb1111bbbb2222bbbb3333bbbb4444bbbb5555";
const AMOUNT_DATA = "0000000000000000000000000000000000000000000000000de0b6b3a7640000"; // 1e18

describe("parseMintBurnLogs — custom counterparty encoding", () => {
  it("extracts counterparty from data slot when counterpartyEncoding is set", () => {
    const config = {
      chain: { chainId: "ethereum", explorerUrl: "https://etherscan.io" },
      stablecoinId: "test", symbol: "TEST",
      contractAddress: "0xc0", decimals: 18, dustThreshold: 0,
      startBlock: 1, events: [],
    } as any;
    const eventDef = {
      signature: "Deposited(address,address,uint256)",
      topicHash: REUSD_DEPOSITED_TOPIC,
      direction: "mint" as const,
      amountEncoding: "nth-data-uint256" as const,
      dataSlot: 2,
      counterpartyEncoding: { source: "data" as const, slot: 0 },
    };
    const logs = [{
      address: "0xc0",
      topics: [REUSD_DEPOSITED_TOPIC],
      data: "0x" + USER_DATA + TOKEN_DATA + AMOUNT_DATA,
      blockNumber: "0x64", transactionHash: "0xtx", logIndex: "0x0",
    }] as any;
    const { rows } = parseMintBurnLogs(config, eventDef, logs, new Map([[100, 1700000000]]), new Map(), new Map(), 1700000100);
    expect(rows[0].counterparty).toBe("0xaaaa1111aaaa2222aaaa3333aaaa4444aaaa5555");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** (counterparty resolves to null)

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-pipeline.test.ts -t "custom counterparty encoding"
```

- [ ] **Step 3: Extend `MintBurnEventDef`** in `worker/src/lib/mint-burn-contracts.ts` (find the interface declaration, around line 30-50)

Add the field at the end of `MintBurnEventDef`:

```typescript
  /**
   * Override counterparty extraction. When omitted, defaults to:
   *   mint  → topics[2] (Transfer recipient)
   *   burn  → topics[1] (Transfer sender)
   *
   * Use this for non-Transfer custom events where the relevant address is
   * unindexed (data) or located in a non-default topic slot.
   *
   * `source: "topic"` reads `log.topics[index]` (must be ≥1).
   * `source: "data"` reads a 32-byte word from `log.data` at `slot * 32`
   * (the address is the low-20 bytes of that word).
   */
  counterpartyEncoding?:
    | { source: "topic"; index: number }
    | { source: "data"; slot: number };
```

- [ ] **Step 4a: Add `readDataWord` to `worker/src/lib/evm-logs.ts`**

Insert after `decodeUint256AtSlot` (around line 69):

```typescript
/**
 * Extract a 32-byte data word (hex string with 0x prefix) at slot index from
 * ABI-encoded event data. Returns null when data is shorter than expected.
 * Compose with `decodeAddress(...)` to extract unindexed address parameters.
 */
export function readDataWord(hexData: string, slotIndex: number): string | null {
  const cleaned = hexData.startsWith("0x") ? hexData.slice(2) : hexData;
  const start = slotIndex * 64;
  if (cleaned.length < start + 64) return null;
  return "0x" + cleaned.slice(start, start + 64);
}
```

- [ ] **Step 4b: Add unit test for `readDataWord`** in `worker/src/lib/__tests__/evm-logs.test.ts` (create the file if it doesn't exist)

```typescript
import { describe, expect, it } from "vitest";
import { decodeAddress, readDataWord } from "../evm-logs";

describe("readDataWord", () => {
  const USER = "000000000000000000000000aaaa1111aaaa2222aaaa3333aaaa4444aaaa5555";
  const TOKEN = "000000000000000000000000bbbb1111bbbb2222bbbb3333bbbb4444bbbb5555";
  const AMOUNT = "0000000000000000000000000000000000000000000000000de0b6b3a7640000";

  it("returns the slot-0 word with 0x prefix", () => {
    expect(readDataWord("0x" + USER + TOKEN + AMOUNT, 0)).toBe("0x" + USER);
  });
  it("returns slot-1 when composed correctly", () => {
    expect(readDataWord("0x" + USER + TOKEN + AMOUNT, 1)).toBe("0x" + TOKEN);
  });
  it("returns null when slot is out of range", () => {
    expect(readDataWord("0x" + USER, 3)).toBeNull();
  });
  it("handles data without 0x prefix", () => {
    expect(readDataWord(USER, 0)).toBe("0x" + USER);
  });
  it("composes with decodeAddress for unindexed-param extraction", () => {
    expect(decodeAddress(readDataWord("0x" + USER + TOKEN, 0)!)).toBe(
      "0xaaaa1111aaaa2222aaaa3333aaaa4444aaaa5555",
    );
  });
});
```

- [ ] **Step 4c: Patch `parse.ts:71-72`** to honor the new encoding

Import `readDataWord` by adding it to the existing evm-logs import at line 2:

```typescript
import { decodeAddress, decodeUint256AtSlot, readDataWord } from "../evm-logs";
```

Replace lines 71-72 with:

```typescript
    let counterparty: string | null = null;
    if (eventDef.counterpartyEncoding) {
      const enc = eventDef.counterpartyEncoding;
      if (enc.source === "topic") {
        const word = log.topics[enc.index];
        counterparty = word ? decodeAddress(word) : null;
      } else {
        const word = readDataWord(log.data, enc.slot);
        counterparty = word ? decodeAddress(word) : null;
      }
    } else {
      const counterpartyTopic = direction === "mint" ? log.topics[2] : log.topics[1];
      counterparty = counterpartyTopic ? decodeAddress(counterpartyTopic) : null;
    }
```

- [ ] **Step 5: Update reUSD `Deposited` config** in `worker/src/lib/mint-burn-contracts.ts:685-691`

Add the new field:

```typescript
    events: [{
      signature: "Deposited(address,address,uint256)",
      topicHash: REUSD_DEPOSITED_TOPIC,
      direction: "mint",
      amountEncoding: "nth-data-uint256",
      dataSlot: 2,
      counterpartyEncoding: { source: "data", slot: 0 }, // user (unindexed)
    }],
```

The `InstantRedemptionRouted` config is already correct (user is `topics[1]` and direction is "burn", which matches the default).

- [ ] **Step 6: Run tests — expect PASS, plus type-check**

```bash
cd worker && npx vitest run src/lib/__tests__/evm-logs.test.ts src/lib/__tests__/mint-burn-pipeline.test.ts
cd worker && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add worker/src/lib/evm-logs.ts worker/src/lib/__tests__/evm-logs.test.ts worker/src/lib/mint-burn-contracts.ts worker/src/lib/mint-burn-pipeline/parse.ts worker/src/lib/__tests__/mint-burn-pipeline.test.ts
git commit -m "fix(mint-burn): support custom counterparty encoding for non-Transfer events (reUSD Deposited)"
```

---

### Task 1.4: Atomic-roundtrip detector — require amount match

**Why:** `roundtrip-detection.ts:8-33` flags any `(tx, coin)` group with both mint and burn as `atomic_roundtrip`, ignoring whether the amounts actually round-trip. A real partial bridge or composed DeFi tx (mint 100, burn 50) gets entirely filtered out of economic flow when only the 50 was a roundtrip and the net 50 was real issuance. The fix: require `|sum(mint) - sum(burn)| ≤ tolerance × max(sum(mint), sum(burn))`. Tolerance = 0.5% (matches typical fee/dust slippage). Below tolerance: tag as roundtrip. Above tolerance: keep both sides as `standard` so the net contributes to flow.

**Files:**
- Modify: `worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts`
- Modify: `worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts` (mirror the tolerance check in the SQL-driven sweep)
- Modify: `worker/src/lib/__tests__/mint-burn-roundtrip.test.ts`

- [ ] **Step 1: Add failing tests** in `worker/src/lib/__tests__/mint-burn-roundtrip.test.ts`

```typescript
import { detectAtomicRoundtrips } from "../mint-burn-pipeline/roundtrip-detection";
import type { MintBurnRow } from "../mint-burn-pipeline/types";

function mb(direction: "mint" | "burn", tx: string, amount: number, id = "x"): MintBurnRow {
  return {
    id: `${id}-${direction}`, stablecoin_id: "c", symbol: "C", chain_id: "ethereum",
    direction, amount, amount_usd: amount, price_used: 1, price_timestamp: 0,
    price_source: "test", burn_type: direction === "burn" ? "effective_burn" : null,
    burn_review_reason: null, flow_type: "standard", counterparty: null,
    tx_hash: tx, block_number: 1, timestamp: 1, explorer_tx_url: "",
  };
}

describe("detectAtomicRoundtrips — amount tolerance", () => {
  it("flags mint and burn that match within 0.5%", () => {
    const rows = [mb("mint", "0x1", 100), mb("burn", "0x1", 100.4)];
    detectAtomicRoundtrips(rows);
    expect(rows.every((r) => r.flow_type === "atomic_roundtrip")).toBe(true);
  });

  it("does NOT flag mint 100 / burn 50 (net economic flow)", () => {
    const rows = [mb("mint", "0x2", 100), mb("burn", "0x2", 50)];
    detectAtomicRoundtrips(rows);
    expect(rows.every((r) => r.flow_type === "standard")).toBe(true);
  });

  it("does NOT flag mint 100 / burn 95 (5% mismatch exceeds tolerance)", () => {
    const rows = [mb("mint", "0x3", 100), mb("burn", "0x3", 95)];
    detectAtomicRoundtrips(rows);
    expect(rows.every((r) => r.flow_type === "standard")).toBe(true);
  });

  it("flags multi-row groups when totals match within tolerance", () => {
    const rows = [
      mb("mint", "0x4", 60, "a"), mb("mint", "0x4", 40, "b"),
      mb("burn", "0x4", 100, "c"),
    ];
    detectAtomicRoundtrips(rows);
    expect(rows.every((r) => r.flow_type === "atomic_roundtrip")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL on cases 2 and 3** (currently flag everything)

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-roundtrip.test.ts -t "amount tolerance"
```

- [ ] **Step 3: Replace `detectAtomicRoundtrips`** in `worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts`

```typescript
import type { MintBurnRow } from "./types";

/** Roundtrip is recognised only when sum(mint) ≈ sum(burn) within this fraction. */
export const ROUNDTRIP_AMOUNT_TOLERANCE = 0.005; // 0.5%

/**
 * Detect atomic roundtrips: transactions whose mint and burn totals (per stablecoin)
 * round-trip within `ROUNDTRIP_AMOUNT_TOLERANCE`. Mutates rows in place to set
 * `flow_type = "atomic_roundtrip"`. Rows missing tx_hash are skipped (defensive
 * guard against malformed input). Returns count of rows flagged.
 */
export function detectAtomicRoundtrips(rows: MintBurnRow[]): number {
  const groups = new Map<string, MintBurnRow[]>();
  for (const row of rows) {
    if (!row.tx_hash) continue;
    const key = `${row.tx_hash}-${row.stablecoin_id}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  let flagged = 0;
  for (const group of groups.values()) {
    let mintTotal = 0;
    let burnTotal = 0;
    for (const row of group) {
      if (row.direction === "mint") mintTotal += row.amount;
      else burnTotal += row.amount;
    }
    if (mintTotal === 0 || burnTotal === 0) continue;
    const denom = Math.max(mintTotal, burnTotal);
    if (Math.abs(mintTotal - burnTotal) > denom * ROUNDTRIP_AMOUNT_TOLERANCE) continue;
    for (const row of group) {
      row.flow_type = "atomic_roundtrip";
      flagged++;
    }
  }
  return flagged;
}
```

- [ ] **Step 4: Mirror the tolerance in the cross-run sweep** at `worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts`

Find the SQL `HAVING COUNT(DISTINCT direction) > 1` clause. Extend it to require matched totals. Use `CASE WHEN a >= b THEN a ELSE b END` instead of `MAX(a, b)` — the two-argument scalar `MAX()` inside a `HAVING` clause with aggregate expressions has edge cases in older SQLite builds; `CASE WHEN` is universally safe:

```sql
HAVING COUNT(DISTINCT direction) > 1
   AND ABS(SUM(CASE WHEN direction='mint' THEN amount ELSE 0 END)
         - SUM(CASE WHEN direction='burn' THEN amount ELSE 0 END))
       <= 0.005 * (
            CASE
              WHEN SUM(CASE WHEN direction='mint' THEN amount ELSE 0 END)
                 >= SUM(CASE WHEN direction='burn' THEN amount ELSE 0 END)
              THEN SUM(CASE WHEN direction='mint' THEN amount ELSE 0 END)
              ELSE SUM(CASE WHEN direction='burn' THEN amount ELSE 0 END)
            END
          )
```

Add a code comment in the file that cites `ROUNDTRIP_AMOUNT_TOLERANCE` from `roundtrip-detection.ts` as the source of truth for the `0.005` literal (the SQL can't import the TS constant; keep them in sync manually — the test in Step 1 guards the TS side, and an integration test should assert sweep parity).

- [ ] **Step 5: Add a sweep test** in `worker/src/lib/__tests__/mint-burn-roundtrip.test.ts` (or in the existing sweep test file) that asserts a mismatched tx is NOT picked up by the sweep. Use the existing test scaffolding pattern.

- [ ] **Step 6: Run all tests + type-check**

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-roundtrip.test.ts
cd worker && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts worker/src/lib/__tests__/mint-burn-roundtrip.test.ts
git commit -m "fix(mint-burn): require atomic-roundtrip mint/burn totals to match within 0.5%"
```

---

### Task 1.5: Roundtrip detector — guard against empty tx_hash

**Why:** Already addressed in Task 1.4 Step 3 via `if (!row.tx_hash) continue;`. This task exists only to add explicit test coverage so the regression is caught.

**Files:**
- Modify: `worker/src/lib/__tests__/mint-burn-roundtrip.test.ts`

- [ ] **Step 1: Add an explicit test**

```typescript
describe("detectAtomicRoundtrips — empty tx_hash guard", () => {
  it("does not collide rows with missing tx_hash", () => {
    const rows = [
      { ...mb("mint", "", 100, "a"), tx_hash: "" } as MintBurnRow,
      { ...mb("burn", "", 100, "b"), tx_hash: "" } as MintBurnRow,
    ];
    detectAtomicRoundtrips(rows);
    expect(rows.every((r) => r.flow_type === "standard")).toBe(true);
  });
});
```

- [ ] **Step 2: Run + commit (test-only; code already fixed in Task 1.4)**

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-roundtrip.test.ts
git add worker/src/lib/__tests__/mint-burn-roundtrip.test.ts
git commit -m "test(mint-burn): add regression test for empty tx_hash in roundtrip detector"
```

---

### Task 1.6: Bank Run Gauge — weight by canonical-chain mcap

**Why:** `worker/src/api/mint-burn-flows.ts:464-478` builds `mcapById` via `sumPegBuckets(asset.circulating)` — the **total** circulating supply across **all** chains. Intensity, however, is computed from per-chain `mint_burn_hourly` rows filtered to canonical issuance chains. Result: USDC's intensity reflects Ethereum-only flows but its weight in the gauge reflects $36B global supply (including ~$4B Solana, $1B Avalanche, etc. that we don't measure). This systematically inflates the influence of multi-chain coins. The fix introduces a `getMintBurnTrackedChains(stablecoinId)` helper alongside the existing `isCanonicalMintBurnPair`, sums `circulating` only for the chains we track, and feeds that into `mcapById`.

**Files:**
- Modify: `worker/src/lib/mint-burn-canonical-chain.ts` — add `getMintBurnTrackedChains()`
- Modify: `worker/src/api/mint-burn-flows.ts:464-478`
- Create: `worker/src/lib/__tests__/mint-burn-canonical-mcap.test.ts`
- Modify: `worker/src/api/__tests__/mint-burn-flows.test.ts` (gauge weighting regression)

- [ ] **Step 1: Read current canonical-chain helper**

Confirm the existing `isCanonicalMintBurnPair` at `worker/src/lib/mint-burn-canonical-chain.ts`. The new helper should derive its data from the same `MINT_BURN_CONFIGS` used by the rest of the pipeline so it auto-updates when configs change.

- [ ] **Step 2: Write failing helper test** at `worker/src/lib/__tests__/mint-burn-canonical-mcap.test.ts`

The `StablecoinData.circulating` shape is `Record<string, number> | undefined` (verified at `shared/types/core.ts:520` — flat per-chain USD totals, NOT nested peg-bucket objects). `sumPegBuckets` at `shared/lib/supply.ts:9` sums the values of that record.

```typescript
import { describe, expect, it } from "vitest";
import { getMintBurnTrackedChains, sumMcapForTrackedChains } from "../mint-burn-canonical-chain";

describe("getMintBurnTrackedChains", () => {
  it("returns ethereum for USDC", () => {
    expect(getMintBurnTrackedChains("usdc-circle")).toEqual(["ethereum"]);
  });
  it("returns arbitrum for USDai", () => {
    expect(getMintBurnTrackedChains("usdai-usd-ai")).toEqual(["arbitrum"]);
  });
  it("returns empty array for an untracked coin", () => {
    expect(getMintBurnTrackedChains("nonexistent-coin")).toEqual([]);
  });
});

describe("sumMcapForTrackedChains", () => {
  // Shape: Record<chainId, usdValue>. DefiLlama already converts to USD regardless of peg.
  const circulating: Record<string, number> = {
    ethereum: 32_000_000_000,
    solana:   4_000_000_000,
    base:     1_000_000_000,
  };
  it("sums only tracked chains for USDC (ethereum-only today)", () => {
    expect(sumMcapForTrackedChains("usdc-circle", circulating)).toBe(32_000_000_000);
  });
  it("returns 0 when no tracked-chain key is present in circulating", () => {
    expect(sumMcapForTrackedChains("usdc-circle", { solana: 4e9 })).toBe(0);
  });
  it("falls back to global mcap (sumPegBuckets) for an untracked coin id", () => {
    expect(sumMcapForTrackedChains("nonexistent", circulating)).toBe(37_000_000_000);
  });
  it("handles undefined circulating gracefully", () => {
    expect(sumMcapForTrackedChains("usdc-circle", undefined)).toBe(0);
  });
});
```

- [ ] **Step 3: Run test — expect FAIL** (helpers don't exist)

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-canonical-mcap.test.ts
```

- [ ] **Step 4: Implement helpers** in `worker/src/lib/mint-burn-canonical-chain.ts`

Add at the bottom of the file:

```typescript
import { MINT_BURN_CONFIGS } from "./mint-burn-contracts";
import { sumPegBuckets } from "@shared/lib/supply";

const TRACKED_CHAINS_BY_COIN: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const c of MINT_BURN_CONFIGS) {
    const set = new Set(map.get(c.stablecoinId) ?? []);
    set.add(c.chain.chainId);
    map.set(c.stablecoinId, [...set]);
  }
  return map;
})();

export function getMintBurnTrackedChains(stablecoinId: string): string[] {
  return TRACKED_CHAINS_BY_COIN.get(stablecoinId) ?? [];
}

/**
 * Returns the circulating-supply USD total restricted to chains we actively
 * track in mint/burn ingestion. Used for gauge mcap weighting so a coin's
 * influence on the Bank Run Gauge matches the chain scope of its intensity input.
 *
 * Fallback policy:
 *   - If `circulating` is undefined → 0 (no data to weight against).
 *   - If the coin has no tracked chains (legacy/future id) → fall back to
 *     `sumPegBuckets(circulating)` so the gauge degrades to legacy behavior
 *     rather than zeroing a known coin out.
 */
export function sumMcapForTrackedChains(
  stablecoinId: string,
  circulating: Record<string, number> | undefined,
): number {
  if (!circulating) return 0;
  const trackedChains = getMintBurnTrackedChains(stablecoinId);
  if (trackedChains.length === 0) return sumPegBuckets(circulating);
  let total = 0;
  for (const chainId of trackedChains) {
    const v = circulating[chainId];
    if (typeof v === "number" && Number.isFinite(v)) total += v;
  }
  return total;
}
```

- [ ] **Step 5: Run helper test — expect PASS**

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-canonical-mcap.test.ts
```

- [ ] **Step 6: Patch the gauge mcap loader** at `worker/src/api/mint-burn-flows.ts:476-478`

Change:
```typescript
    for (const asset of stablecoinsCacheResult.payload.peggedAssets as StablecoinData[]) {
      if (TRACKED_IDS.has(asset.id)) mcapById.set(asset.id, sumPegBuckets(asset.circulating));
    }
```
To:
```typescript
    for (const asset of stablecoinsCacheResult.payload.peggedAssets as StablecoinData[]) {
      if (TRACKED_IDS.has(asset.id)) {
        mcapById.set(asset.id, sumMcapForTrackedChains(asset.id, asset.circulating));
      }
    }
```

Add the import:
```typescript
import { sumMcapForTrackedChains } from "../lib/mint-burn-canonical-chain";
```

- [ ] **Step 7: Add a regression test** in `worker/src/api/__tests__/mint-burn-flows.test.ts`

```typescript
describe("Bank Run Gauge — canonical-chain mcap weighting", () => {
  it("weights USDC by Ethereum-only circulating, ignoring Solana/Avax buckets", async () => {
    // Stub stablecoins-cache with USDC having $30B ETH + $4B Solana
    // Stub mint_burn_hourly with USDC intensity = -50
    // Stub another coin (e.g., USDT) with intensity = +50, mcap $80B all on Ethereum
    // Expected gauge = (-50*30B + 50*80B) / (30B + 80B) ≈ 27.3
    // Without fix it would be (-50*34B + 50*80B) / (34B + 80B) ≈ 20.6
    // ... (use the test harness pattern already established in the file)
  });
});
```

(Skeleton above — fill with the file's existing stub pattern. The numeric expectation is the regression hook.)

- [ ] **Step 8: Run all tests + type-check + worker boundary check**

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-canonical-mcap.test.ts src/api/__tests__/mint-burn-flows.test.ts
cd worker && npx tsc --noEmit
cd .. && npm run check:worker-boundary
```

- [ ] **Step 9: Commit**

```bash
git add worker/src/lib/mint-burn-canonical-chain.ts worker/src/api/mint-burn-flows.ts worker/src/lib/__tests__/mint-burn-canonical-mcap.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts
git commit -m "fix(mint-burn): weight Bank Run Gauge by canonical-chain mcap, not global supply"
```

---

### Task 1.7: Reclassify historical rows via existing backfill endpoint (no new endpoint)

**Why:** Tasks 1.1, 1.2, and 1.4 fix *forward* classification, but historical rows remain mis-tagged. The existing `/api/backfill-mint-burn` endpoint (`worker/src/api/backfill-mint-burn.ts`) already re-runs the shared ingestion pipeline over a block range AND updates `flow_type` on existing rows (v5.0 changelog: "Backfill and replay persistence now updates `flow_type` on existing rows, allowing post-deploy repair of previously inserted bridge-transfer noise"). We do not need to build a new endpoint; we need to (a) verify the classifier-update path is exercised by the existing tests, (b) improve observability of reclassification deltas, and (c) produce an operator playbook that runs replay across affected date ranges.

Amount-mismatched roundtrips are a different case: they already live in `mint_burn_events` with `flow_type='atomic_roundtrip'` and need to be re-evaluated against the new tolerance rule. Because the check is pure SQL (no RPC), extend the existing `worker/src/api/reclassify-atomic-roundtrips.ts` endpoint to handle both directions of flip: standard→roundtrip (existing) AND roundtrip→standard (new).

**Files:**
- Modify: `worker/src/api/backfill-mint-burn.ts` — return richer deltas in response body
- Modify: `worker/src/api/__tests__/backfill-mint-burn.test.ts` — regression asserting `flow_type` updates on existing rows after classifier logic changes
- Modify: `worker/src/api/reclassify-atomic-roundtrips.ts` — also reclassify tolerance-violating rows back to `standard`
- Modify: `worker/src/api/__tests__/reclassify-atomic-roundtrips.test.ts`

- [ ] **Step 1: Failing test for backfill `flow_type` update**

Add to `worker/src/api/__tests__/backfill-mint-burn.test.ts`:

```typescript
it("updates flow_type on existing rows when classifier output differs", async () => {
  // Seed: insert a row for USDC with flow_type='standard' that, under the new
  // CCIP/CCTP mint-tagging rule, should become 'bridge_transfer' when
  // re-classified. Stub the Alchemy response so the row is re-scanned.
  // Run backfill over the containing block range.
  // Assert: the row's flow_type is now 'bridge_transfer' AND
  //         mint_burn_hourly for the affected hour was recalculated.
});
```

- [ ] **Step 2: Verify the test fails**

```bash
cd worker && npx vitest run src/api/__tests__/backfill-mint-burn.test.ts -t "updates flow_type on existing rows"
```

If it passes immediately, the behavior is already covered by `updateEventClassifications`. Move on. If it fails, inspect `worker/src/lib/mint-burn-pipeline/persistence.ts` for whether `updateEventClassifications` is called on pre-existing row ids — it should be; if it's not, add that call path in Step 3.

- [ ] **Step 3: Add reclassification counters to backfill response**

In `worker/src/api/backfill-mint-burn.ts`, extend the return body to include:

```typescript
{
  // ... existing fields ...
  reclassified: {
    flowTypeChanges: number,   // how many rows had flow_type updated
    burnTypeChanges: number,   // how many rows had burn_type updated
  },
}
```

Thread the counters from `updateEventClassifications` in `persistence.ts` (which already knows how many rows it touched) up through the pipeline to the response builder. This gives the operator immediate signal that reclassification is actually happening.

- [ ] **Step 4: Extend `reclassify-atomic-roundtrips.ts` to handle the reverse case**

After the existing forward pass (standard → atomic_roundtrip), add a reverse pass:

```sql
-- Find (tx_hash, stablecoin_id) groups currently marked atomic_roundtrip whose
-- mint/burn totals no longer match within tolerance (Task 1.4 introduced the rule).
SELECT tx_hash, stablecoin_id, chain_id,
       SUM(CASE WHEN direction='mint' THEN amount ELSE 0 END) AS mint_amt,
       SUM(CASE WHEN direction='burn' THEN amount ELSE 0 END) AS burn_amt
FROM mint_burn_events
WHERE flow_type = 'atomic_roundtrip'
GROUP BY tx_hash, stablecoin_id, chain_id
HAVING ABS(mint_amt - burn_amt) > 0.005 * (
         CASE WHEN mint_amt >= burn_amt THEN mint_amt ELSE burn_amt END
       )
LIMIT ?
```

For each group returned, update rows back to `flow_type='standard'` and recompute affected hourly buckets. Return separate counters `{ toRoundtrip, toStandard }`.

- [ ] **Step 5: Test the reverse-flip** in `worker/src/api/__tests__/reclassify-atomic-roundtrips.test.ts`

```typescript
it("flips atomic_roundtrip back to standard when amounts fail new tolerance", async () => {
  // Seed: a row group with mint=100, burn=50 and flow_type='atomic_roundtrip' (legacy tagging)
  // Call endpoint; assert both rows are standard and hourly recalculated.
});
```

- [ ] **Step 6: Run tests + type-check**

```bash
cd worker && npx vitest run src/api/__tests__/backfill-mint-burn.test.ts src/api/__tests__/reclassify-atomic-roundtrips.test.ts
cd worker && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add worker/src/api/backfill-mint-burn.ts worker/src/api/reclassify-atomic-roundtrips.ts worker/src/api/__tests__/backfill-mint-burn.test.ts worker/src/api/__tests__/reclassify-atomic-roundtrips.test.ts
git commit -m "feat(mint-burn): expose reclassification deltas in backfill response; reverse-flip tolerance-violating roundtrips"
```

- [ ] **Step 8: Operator playbook (runbook addition, not committed in this task)**

After all code tasks merge, operator runs the following sequence against `https://ops-api.pharos.watch` with the Access service token. Exact sequencing is important: bridge-mint reclassification first (largest volume impact, catches everything), then roundtrip fix-up (small volume), then validation.

1. **Bridge-mint reclassification via `/api/backfill-mint-burn`** (re-runs shared pipeline incl. new classifier):
   - Determine block ranges for each affected coin from Phase 0 results.
   - For each affected config, loop:
     ```
     POST /api/backfill-mint-burn
       { "configKey": "ethereum-0x...usdc", "fromBlock": <90d-ago>, "toBlock": <latest>,
         "chunkSize": 20000, "maxChunks": 5, "Idempotency-Key": "reclassify-usdc-2026-04-??-1" }
     ```
     Follow the `nextFromBlock` cursor until `done: true`. Track the `reclassified.flowTypeChanges` counter per call.
   - Coins to run, in order of expected volume: `usdc-circle`, `usdai-usd-ai`, `eurc-circle`, `zchf-frankencoin`, `usdo-openeden`, `usd1-world-liberty-financial`, `avusd-avant`.
   - D1 budget note: each chunk executes a `db.batch()` insert-or-ignore + classification update. Keep `chunkSize <= 20000` to respect the 30-second statement ceiling.

2. **Atomic-roundtrip reverse-flip via `/api/reclassify-atomic-roundtrips`** (pure SQL, fast):
   ```
   POST /api/reclassify-atomic-roundtrips
     { "limit": 1000, "Idempotency-Key": "roundtrip-tolerance-2026-04-??" }
   ```
   Loop until `done: true`. Counter `toStandard` should drop to near-zero on steady state.

3. **Validation**: Re-run Phase 0 queries Q1-Q5; confirm the expected deltas. Write results into `agents/research/2026-04-17-mint-burn-post-fix-results.md`.

4. **Cache invalidation**: if Task 3.2 shipped, the next successful cron automatically purges caches. Otherwise manually invalidate via wrangler:
   ```
   npx wrangler d1 execute pharos-db --remote --command "DELETE FROM cache WHERE key LIKE 'mint-burn-flows:%';"
   ```

---

## Phase 2: Hardening

### Task 2.1: Bridge-detection config validation at module load

**Why:** Bridge configs in `mint-burn-contracts.ts` declare addresses, topics, selectors as inline strings. A typo (missing `0x`, mixed case, wrong length) silently fails: the normalizer returns the malformed string and the classifier never matches. With six bridge configs already and more coming for multi-chain expansion, we need a validator that fails loudly at module load.

**Risk & rollout strategy:** Wiring a throw into `resolveMintBurnContractConfig` without pre-auditing all existing configs is a production-outage risk — a single existing checksummed (mixed-case) address or malformed entry would crash the worker on first request after deploy. This task therefore lands in **three separate commits**: (1) add the validator function and tests with ZERO wiring into config resolution, (2) audit-and-normalize existing configs into canonical lowercase + add a *collect-all-errors-and-log* pass, (3) flip the log pass to a throw **only** once the collect pass returns zero errors in CI.

**Files:**
- Modify: `worker/src/lib/mint-burn-contracts.ts`
- Modify: `worker/src/lib/__tests__/mint-burn-contracts.test.ts`

- [ ] **Step 1: Failing test** in `worker/src/lib/__tests__/mint-burn-contracts.test.ts`

```typescript
import { validateMintBurnBridgeDetection } from "../mint-burn-contracts";

describe("validateMintBurnBridgeDetection", () => {
  it("accepts a well-formed config", () => {
    expect(() => validateMintBurnBridgeDetection({
      protocol: "ccip",
      knownBridgePoolAddresses: ["0x80226fc0ee2b096224eeac085bb9a8cba1146f7d"],
      knownBridgeRouterAddresses: ["0x80226fc0ee2b096224eeac085bb9a8cba1146f7d"],
      bridgeSignalTopics: ["0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd"],
      bridgeSignalSelectors: ["0x96f4e9f9"],
    })).not.toThrow();
  });
  it("rejects malformed address (no 0x)", () => {
    expect(() => validateMintBurnBridgeDetection({
      protocol: "ccip",
      knownBridgePoolAddresses: ["80226fc0ee2b096224eeac085bb9a8cba1146f7d"],
      knownBridgeRouterAddresses: [], bridgeSignalTopics: [], bridgeSignalSelectors: [],
    })).toThrow(/address/i);
  });
  it("rejects topic of wrong length", () => {
    expect(() => validateMintBurnBridgeDetection({
      protocol: "ccip",
      knownBridgePoolAddresses: [], knownBridgeRouterAddresses: [],
      bridgeSignalTopics: ["0xdeadbeef"], bridgeSignalSelectors: [],
    })).toThrow(/topic/i);
  });
  it("rejects selector of wrong length", () => {
    expect(() => validateMintBurnBridgeDetection({
      protocol: "ccip",
      knownBridgePoolAddresses: [], knownBridgeRouterAddresses: [],
      bridgeSignalTopics: [], bridgeSignalSelectors: ["0xabcd"],
    })).toThrow(/selector/i);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (validator doesn't exist)

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-contracts.test.ts -t "validateMintBurnBridgeDetection"
```

- [ ] **Step 3: Implement validator** in `worker/src/lib/mint-burn-contracts.ts`

```typescript
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TOPIC_RE = /^0x[0-9a-fA-F]{64}$/;
const SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;

export function validateMintBurnBridgeDetection(d: MintBurnBridgeDetectionConfig): void {
  const all: { kind: "address" | "topic" | "selector"; values: string[] }[] = [
    { kind: "address", values: (d as any).knownBridgePoolAddresses ?? [] },
    { kind: "address", values: (d as any).knownBridgeRouterAddresses ?? [] },
    { kind: "address", values: (d as any).knownBridgeContractAddresses ?? [] },
    { kind: "address", values: (d as any).bridgeSignalEmitterAddresses ?? [] },
    { kind: "topic",   values: d.bridgeSignalTopics ?? [] },
    { kind: "selector",values: d.bridgeSignalSelectors ?? [] },
  ];
  for (const { kind, values } of all) {
    for (const v of values) {
      const re = kind === "address" ? ADDRESS_RE : kind === "topic" ? TOPIC_RE : SELECTOR_RE;
      if (!re.test(v)) {
        throw new Error(`mint-burn bridge config: invalid ${kind} "${v}" for protocol ${d.protocol}`);
      }
    }
  }
}
```

- [ ] **Step 4: First commit — validator function only, no wiring**

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-contracts.test.ts
cd worker && npx tsc --noEmit
git add worker/src/lib/mint-burn-contracts.ts worker/src/lib/__tests__/mint-burn-contracts.test.ts
git commit -m "feat(mint-burn): add validator for bridge-detection config format"
```

- [ ] **Step 5: Collect-all-errors audit pass — log, don't throw**

Add a module-scope audit after `MINT_BURN_CONFIGS = ...` is built:

```typescript
// Audit-and-report: validate every existing bridge config without aborting
// the worker. If any errors surface in CF logs, fix them and escalate to
// throw-on-error in a follow-up commit (see plan task 2.1 step 7).
const bridgeValidationErrors: string[] = [];
for (const cfg of MINT_BURN_CONFIGS) {
  if (!cfg.bridgeDetection) continue;
  try {
    validateMintBurnBridgeDetection(cfg.bridgeDetection);
  } catch (e: any) {
    bridgeValidationErrors.push(`${cfg.chain.chainId}/${cfg.stablecoinId}: ${e.message}`);
  }
}
if (bridgeValidationErrors.length > 0) {
  console.error("[mint-burn-contracts] BRIDGE CONFIG VALIDATION ERRORS:", bridgeValidationErrors);
}
```

This ships but does not crash the worker if any existing config has a format issue. The operator gets a clear error list in CF logs if any exists.

- [ ] **Step 6: Inspect logs post-deploy**

After deploy, query wrangler tail or dashboard logs for `[mint-burn-contracts] BRIDGE CONFIG VALIDATION ERRORS`. If the list is non-empty, open a corrective commit that normalizes each failing entry (typically `.toLowerCase()` on addresses) and redeploy. Only proceed to Step 7 when two full cron cycles emit no validation errors.

- [ ] **Step 7: Flip audit → throw at resolve time (final commit)**

Replace the audit block with a strict validation that throws at module init. Also wire into `resolveMintBurnContractConfig` (around line 169 of `mint-burn-contracts.ts`) so any future config addition fails at type-check / first request:

```typescript
// After spec normalization, before returning:
if (resolved.bridgeDetection) validateMintBurnBridgeDetection(resolved.bridgeDetection);
```

And replace the module-scope audit block with an aggregating throw:

```typescript
// Strict gate: any malformed bridge config crashes the worker on first request
// so the error surfaces immediately in CF logs instead of silently mis-classifying.
const validationErrors: string[] = [];
for (const cfg of MINT_BURN_CONFIGS) {
  if (!cfg.bridgeDetection) continue;
  try { validateMintBurnBridgeDetection(cfg.bridgeDetection); }
  catch (e: any) { validationErrors.push(`${cfg.chain.chainId}/${cfg.stablecoinId}: ${e.message}`); }
}
if (validationErrors.length > 0) {
  throw new Error(`mint-burn bridge config validation failed:\n${validationErrors.join("\n")}`);
}
```

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-contracts.test.ts
cd worker && npx tsc --noEmit
git add worker/src/lib/mint-burn-contracts.ts
git commit -m "feat(mint-burn): enforce bridge-detection config validation at module load (after clean audit)"
```

---

### Task 2.2: Propagate `recalcAffectedHours` failure into run status

**Why:** `worker/src/cron/sync-mint-burn.ts:248-254` catches the recalc error in `finally`, logs it, but does not change the run's success/failure state. The cron metadata still reports `status: "ok"` while the hourly aggregates are stale. Operators have no signal that the next API response will be wrong. Fix: track the failure on a result variable, downgrade status to `degraded` (critical lane) or surface it in metadata (extended lane).

**Files:**
- Modify: `worker/src/cron/sync-mint-burn.ts:240-280`
- Modify: `worker/src/cron/__tests__/sync-mint-burn.test.ts`

- [ ] **Step 1: Read current orchestrator** (`worker/src/cron/sync-mint-burn.ts:200-280`) to find the finally block. Note the `phaseResult`, `affectedHours`, and how status/metadata are computed downstream.

- [ ] **Step 2: Failing test** — assert that when `recalcAffectedHours` throws, the cron return value reflects degraded status and metadata includes a `recalcFailed: true` flag.

Append to `worker/src/cron/__tests__/sync-mint-burn.test.ts`:

```typescript
it("downgrades to degraded and flags metadata when recalcAffectedHours throws", async () => {
  // Use the existing test harness; stub recalcAffectedHours to throw
  // Assert returned status is "degraded" (or marked in metadata) and metadata contains recalcFailed=true
});
```

- [ ] **Step 3: Patch the orchestrator**

Restructure the try/finally so the failure is captured:

```typescript
  let recalcFailed = false;
  let recalcError: string | null = null;
  try {
    phaseResult = await runMintBurnConfigPhase({ ... });
  } finally {
    if (affectedHours.size > 0) {
      try { await recalcAffectedHours(db, affectedHours); }
      catch (e: any) {
        recalcFailed = true;
        recalcError = e?.message ?? String(e);
        console.error("[sync-mint-burn] recalcAffectedHours failed:", e);
      }
    }
  }
```

In the metadata block downstream, add:

```typescript
  metadata.recalcFailed = recalcFailed;
  if (recalcError) metadata.recalcError = recalcError;
```

In the status computation, add `recalcFailed` to the conditions that produce `degraded` for the critical lane.

- [ ] **Step 4: Run cron tests**

```bash
cd worker && npx vitest run src/cron/__tests__/sync-mint-burn.test.ts
cd worker && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/sync-mint-burn.ts worker/src/cron/__tests__/sync-mint-burn.test.ts
git commit -m "fix(mint-burn): surface recalcAffectedHours failure in run status and metadata"
```

---

### Task 2.3: Stuck-config grace period

**Why:** A config that errors persistently (Alchemy rate-limit on a hot config, RPC node returning malformed data, etc.) re-scans the same block range every cycle, consuming subrequest budget that should go to other configs. There's no mechanism to defer it. Add a `mint_burn_config_deferral` table that records `(config_key, deferred_until_ts)`. When `apiErrors > 5` and `coverage < 0.8` for a config in a single run, defer it for 1 hour. The orchestrator skips deferred configs.

**Files:**
- Create: `worker/migrations/0096_mint_burn_config_deferral.sql`
- Modify: `worker/src/cron/mint-burn/run-state.ts`
- Modify: `worker/src/cron/mint-burn/run-configs.ts`
- Modify: `worker/src/cron/__tests__/sync-mint-burn.test.ts`

- [ ] **Step 1: Write migration**

```sql
-- worker/migrations/0096_mint_burn_config_deferral.sql
-- Defer chronically failing mint/burn configs for a grace period so they
-- don't starve healthy configs of subrequest budget.
CREATE TABLE IF NOT EXISTS mint_burn_config_deferral (
  config_key TEXT PRIMARY KEY,
  deferred_until INTEGER NOT NULL,
  reason TEXT NOT NULL,
  api_errors INTEGER NOT NULL DEFAULT 0,
  coverage REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mbcd_until ON mint_burn_config_deferral(deferred_until);
```

- [ ] **Step 2: Failing test**

Test scenarios:
- A config with `apiErrors=6, coverage=0.5` after a run is added to deferral with `deferred_until = now + 3600`.
- A deferred config is skipped on the next run.
- A deferral expires after 1 hour and the config runs again.

- [ ] **Step 3: Implement deferral helpers** in `worker/src/cron/mint-burn/run-state.ts`

```typescript
const DEFERRAL_GRACE_SEC = 3600;
const DEFERRAL_API_ERRORS_THRESHOLD = 5;
const DEFERRAL_COVERAGE_THRESHOLD = 0.8;

export async function loadDeferredConfigs(db: D1Database, nowSec: number): Promise<Set<string>> {
  const rows = await db.prepare(
    "SELECT config_key FROM mint_burn_config_deferral WHERE deferred_until > ?"
  ).bind(nowSec).all<{ config_key: string }>();
  return new Set(rows.results.map((r) => r.config_key));
}

export async function deferConfig(
  db: D1Database, configKey: string, nowSec: number,
  apiErrors: number, coverage: number | null, reason: string,
): Promise<void> {
  await db.prepare(
    `INSERT OR REPLACE INTO mint_burn_config_deferral
       (config_key, deferred_until, reason, api_errors, coverage, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(configKey, nowSec + DEFERRAL_GRACE_SEC, reason, apiErrors, coverage, nowSec).run();
}

export function shouldDeferConfig(apiErrors: number, coverage: number | null): boolean {
  if (apiErrors <= DEFERRAL_API_ERRORS_THRESHOLD) return false;
  if (coverage == null) return true;
  return coverage < DEFERRAL_COVERAGE_THRESHOLD;
}
```

- [ ] **Step 4: Wire into orchestrator** in `worker/src/cron/mint-burn/run-configs.ts`

Before the per-config loop, call `loadDeferredConfigs(db, nowSec)` and skip any matching config (track count in `contractsSkipped` with reason `deferred`). After each config completes, if `shouldDeferConfig(apiErrors, coverage)` returns true, call `deferConfig(...)`.

- [ ] **Step 5: Test + type-check**

```bash
cd worker && npx vitest run src/cron/__tests__/sync-mint-burn.test.ts
cd worker && npx tsc --noEmit
```

- [ ] **Step 6: Commit migration + code together**

```bash
git add worker/migrations/0096_mint_burn_config_deferral.sql worker/src/cron/mint-burn/run-state.ts worker/src/cron/mint-burn/run-configs.ts worker/src/cron/__tests__/sync-mint-burn.test.ts
git commit -m "feat(mint-burn): defer chronically failing configs for 1h to protect lane budget"
```

---

### Task 2.4: Concurrent tx-context fetch in classification

**Why:** `worker/src/lib/mint-burn-pipeline/classification.ts` (find the `for (const txHash of txHashes)` loop) fetches tx contexts sequentially. With LayerZero/CCIP/CCTP coins each producing dozens of bridge txs per cron, this serializes 30-60 RPC calls per coin. Switching to a bounded concurrent fetch (e.g., `pLimit(8)`-style) reduces wall-time without exceeding Cloudflare's 6-connection-per-trigger pool when combined with the existing `eth_getLogs` work, because tx-context fetch happens *after* logs are loaded and decoded.

**Files:**
- Modify: `worker/src/lib/mint-burn-pipeline/classification.ts`
- Modify: `worker/src/lib/__tests__/mint-burn-pipeline.test.ts`

- [ ] **Step 1: Failing test** — assert concurrency WITHOUT relying on wall-clock timing (flake-prone).

Use an in-flight counter that tracks peak concurrency via a spy fetcher. This is deterministic and doesn't depend on scheduler or CI timing.

```typescript
it("fetches tx contexts with bounded concurrency", async () => {
  let inflight = 0;
  let peak = 0;
  const spyFetch = async (hash: string) => {
    inflight++;
    peak = Math.max(peak, inflight);
    await new Promise<void>((r) => queueMicrotask(r)); // yield once
    await new Promise<void>((r) => queueMicrotask(r));
    inflight--;
    return { to: null, inputSelector: null, logTopics: [], logAddresses: [] };
  };
  // Call the classification phase with 20 distinct tx hashes and spyFetch injected
  // as the resolveTxContext implementation.
  // Expect peak === 4 (TX_CONTEXT_CONCURRENCY), not 20, not 1.
  expect(peak).toBe(4);
});
```

(The assertion `peak === 4` is exact — the worker count in `mapWithConcurrency` is `Math.min(limit, items.length) = min(4, 20) = 4`.)

- [ ] **Step 2: Implement bounded concurrency**

Add a small helper at the top of `classification.ts`:

```typescript
async function mapWithConcurrency<T, R>(
  items: T[], limit: number, fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
```

Replace the sequential loop with:

```typescript
const TX_CONTEXT_CONCURRENCY = 4; // <= half of CF's 6-connection pool to leave room for other waitUntil work
const contexts = await mapWithConcurrency(txHashes, TX_CONTEXT_CONCURRENCY, (h) => resolveTxContext(...));
for (let i = 0; i < txHashes.length; i++) txContextByHash.set(txHashes[i], contexts[i]);
```

- [ ] **Step 3: Run tests + type-check + cron-connections check**

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-pipeline.test.ts
cd worker && npx tsc --noEmit
cd .. && npm run check:cron-connections
```

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/mint-burn-pipeline/classification.ts worker/src/lib/__tests__/mint-burn-pipeline.test.ts
git commit -m "perf(mint-burn): fetch tx contexts with bounded concurrency (4) instead of serial"
```

---

## Phase 3: Optimization

### Task 3.1: Add `(flow_type, timestamp)` index for the roundtrip sweep

**Why:** `worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts` does `WHERE flow_type='standard' AND timestamp >= ? GROUP BY tx_hash, stablecoin_id, chain_id HAVING COUNT(DISTINCT direction)>1`. There is no composite index on `(flow_type, timestamp)` — the planner must scan the timestamp index and filter by flow_type at runtime. As event volume grows past 1M, this approaches the 30-second statement budget. Adding the index makes the sweep O(K log N) instead of O(N).

**Files:**
- Create: `worker/migrations/0097_mbe_flow_type_ts_index.sql`

- [ ] **Step 1: Write migration**

```sql
-- worker/migrations/0097_mbe_flow_type_ts_index.sql
-- Speed up the roundtrip-sweep query (and any future flow_type-filtered query)
-- by adding a composite index on (flow_type, timestamp). Backward-compatible.
CREATE INDEX IF NOT EXISTS idx_mbe_flow_type_ts
  ON mint_burn_events(flow_type, timestamp DESC);
```

- [ ] **Step 2: Apply migration locally and assert query plan uses the index**

```bash
cd worker
npx wrangler d1 migrations apply pharos-db --local
npx wrangler d1 execute pharos-db --local --command "EXPLAIN QUERY PLAN SELECT tx_hash FROM mint_burn_events WHERE flow_type='standard' AND timestamp >= 0 LIMIT 1;"
```

Expected: the EXPLAIN output references `idx_mbe_flow_type_ts`.

- [ ] **Step 3: Run merge gate**

```bash
cd .. && npm run test:merge-gate
```

- [ ] **Step 4: Commit**

```bash
git add worker/migrations/0097_mbe_flow_type_ts_index.sql
git commit -m "perf(mint-burn): add (flow_type, timestamp) index to speed roundtrip sweep"
```

---

### Task 3.2: Invalidate API cache after a successful cron run

**Why:** `mint-burn-flows-shared.ts` cache is purely TTL-based (~20 min). After a sync writes new events, the API may serve a stale cached response for up to 20 minutes. After a backfill operation (Task 1.7), staleness can persist much longer with no signal to operators. Add an explicit cache-purge call from `sync-mint-burn` on `status='ok'`.

**Files:**
- Modify: `worker/src/api/mint-burn-flows-shared.ts` — export `invalidateMintBurnFlowCaches(db)`
- Modify: `worker/src/cron/sync-mint-burn.ts` — call it before returning
- Modify: `worker/src/cron/__tests__/sync-mint-burn.test.ts`

- [ ] **Step 1: Failing test** that asserts cache rows for `mint-burn-flows:*` keys are deleted after a successful run.

- [ ] **Step 2: Add helper** in `worker/src/api/mint-burn-flows-shared.ts`

Use a range predicate rather than `LIKE 'prefix%'`. The `cache` table's `key` is PRIMARY KEY (confirmed in `worker/migrations/0000_baseline.sql`), which means `WHERE key >= 'a' AND key < 'b'` executes as an index range scan regardless of SQLite's LIKE-optimization state:

```typescript
export async function invalidateMintBurnFlowCaches(db: D1Database): Promise<void> {
  // Range predicate rather than LIKE: guaranteed to use the PK index.
  // '\uffff' is the largest UTF-16 code unit so it sorts after any realistic key suffix.
  await db
    .prepare("DELETE FROM cache WHERE key >= ? AND key < ?")
    .bind("mint-burn-flows:", "mint-burn-flows:\uffff")
    .run();
}
```

Verify the query plan uses the PK:

```bash
cd worker
npx wrangler d1 execute pharos-db --local --command "EXPLAIN QUERY PLAN DELETE FROM cache WHERE key >= 'mint-burn-flows:' AND key < 'mint-burn-flows:\uffff';"
```

Expected: plan mentions `USING INDEX` or `USING PRIMARY KEY`.

- [ ] **Step 3: Call from orchestrator** at the end of `syncMintBurn()`, after computing the final status:

```typescript
  if (status === "ok" || status === "degraded") {
    try { await invalidateMintBurnFlowCaches(db); }
    catch (e) { console.warn("[sync-mint-burn] cache invalidation failed:", e); }
  }
```

(Wrapped in try/catch because cache invalidation must not fail the run.)

- [ ] **Step 4: Test + commit**

```bash
cd worker && npx vitest run src/cron/__tests__/sync-mint-burn.test.ts
git add worker/src/api/mint-burn-flows-shared.ts worker/src/cron/sync-mint-burn.ts worker/src/cron/__tests__/sync-mint-burn.test.ts
git commit -m "feat(mint-burn): invalidate flow API caches after successful cron sync"
```

---

### Task 3.3: Split bridge classifier by protocol

**Why:** `worker/src/lib/mint-burn-bridge-classifier.ts` is 191 lines with two protocol families inlined into one function (LayerZero OFT branch + CCIP/CCTP/legacy branch). After Tasks 1.1 and 1.2 it grows further. Split into `classifyLayerZeroOft` and `classifyPoolBridge` helpers in a sibling file; the entry function dispatches by `detection.protocol`. Pure refactor, no behavior change.

**Files:**
- Create: `worker/src/lib/mint-burn-bridge-classifier-protocols.ts`
- Modify: `worker/src/lib/mint-burn-bridge-classifier.ts`
- Create: `worker/src/lib/__tests__/mint-burn-bridge-classifier-protocols.test.ts`

- [ ] **Step 1: Move shared helpers (`normalizeHexSet`, `normalizeSelector`, `markBridgeTransfer`, `setDefaultClassification`, `hasSetIntersection`) into the new file** as exported functions. Update imports in the parent.

- [ ] **Step 2: Move the LayerZero branch into `classifyLayerZeroOft(rows, detection, ctxByHash)` in the new file.**

- [ ] **Step 3: Move the CCIP/CCTP branch into `classifyPoolBridge(rows, detection, ctxByHash)`.**

- [ ] **Step 4: Reduce `classifyBridgeAwareBurnRows` to a dispatch:**

```typescript
export function classifyBridgeAwareBurnRows(rows, detection, ctxByHash): void {
  for (const row of rows) setDefaultClassification(row);
  if (!detection) return;
  if (detection.protocol === "layerzero-oft") return classifyLayerZeroOft(rows, detection, ctxByHash);
  return classifyPoolBridge(rows, detection, ctxByHash);
}
```

- [ ] **Step 5: Add focused unit tests** for the two helpers in the new test file (basic cases — the integrated tests in `mint-burn-bridge-classifier.test.ts` continue to cover end-to-end).

- [ ] **Step 6: Run full test suite + type-check**

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-bridge-classifier
cd worker && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add worker/src/lib/mint-burn-bridge-classifier.ts worker/src/lib/mint-burn-bridge-classifier-protocols.ts worker/src/lib/__tests__/mint-burn-bridge-classifier-protocols.test.ts
git commit -m "refactor(mint-burn): split bridge classifier into per-protocol helpers"
```

---

## Phase 4: Observability

### Task 4.1: Structured run-completion metrics

**Why:** Today `mint-burn-pipeline/price-heal.ts` returns `{healed, backlog: {recent, historical}}` but the orchestrator only stuffs them into a JSON metadata blob. `roundtrip-sweep.ts` returns counts but logs warnings only. Operators have no time-series view of NULL-price backlog growth or roundtrip backlog saturation. Promote these to first-class metric fields on the run-completion result and ensure they appear in `/api/status` consumer-ready form.

**Files:**
- Modify: `worker/src/cron/mint-burn/run-completion.ts`
- Modify: `worker/src/lib/mint-burn-pipeline/price-heal.ts`
- Modify: `worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts`
- Modify: `worker/src/cron/__tests__/sync-mint-burn.test.ts`

- [ ] **Step 1: Failing test** asserting that `metadata` returned from `syncMintBurn()` contains:
  - `nullPriceBacklogRecent: number`
  - `nullPriceBacklogHistorical: number`
  - `roundtripsBacklogSaturated: boolean` (true iff sweep returned exactly the limit count)
  - `atomicRoundtripsDetected` and `atomicRoundtripsReclassified` already exist; verify they're still surfaced.

- [ ] **Step 2: Update `roundtrip-sweep.ts`** to return `{reclassified: number, saturated: boolean}` (where `saturated = candidates.length === SWEEP_LIMIT`). Caller propagates `saturated` into metadata.

- [ ] **Step 3: Update `price-heal.ts`** result type so `backlog` is destructured into top-level fields by the caller.

- [ ] **Step 4: Update `run-completion.ts`** to populate these fields on the `metadata` object returned by `syncMintBurn()`.

- [ ] **Step 5: Test + commit**

```bash
cd worker && npx vitest run src/cron/__tests__/sync-mint-burn.test.ts
git add worker/src/cron/mint-burn/run-completion.ts worker/src/lib/mint-burn-pipeline/price-heal.ts worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts worker/src/cron/__tests__/sync-mint-burn.test.ts
git commit -m "feat(mint-burn): expose backlog and saturation metrics in cron metadata"
```

---

### Task 4.2: Subrequest-budget utilization metric

**Why:** `worker/src/cron/sync-mint-burn.ts` tracks `budget.count` and `budget.limit` internally but never exposes utilization. When a single hot config consumes 60% of the lane budget, operators can't see it. Surface `subrequestBudgetUsed` and `subrequestBudgetLimit` in metadata.

**Files:**
- Modify: `worker/src/cron/sync-mint-burn.ts`
- Modify: `worker/src/cron/mint-burn/run-completion.ts`

- [ ] **Step 1: After the run completes, capture `budget.count` and `budget.limit`.**

- [ ] **Step 2: Pass to `completeMintBurnRun(...)` and add to the metadata object.**

- [ ] **Step 3: Test that the field appears in metadata. Commit.**

```bash
git add worker/src/cron/sync-mint-burn.ts worker/src/cron/mint-burn/run-completion.ts
git commit -m "feat(mint-burn): emit subrequest budget utilization in cron metadata"
```

---

## Phase 5: Multi-Chain EVM Groundwork

### Task 5.1: Audit chain genericity post-Arbitrum

**Why:** The April 8 USDai work made the pipeline accept `arbitrum` configs. Before adding Base/BSC/Polygon/Optimism configs, verify that *no remaining hardcodes* assume Ethereum or Arbitrum specifically. Blockers identified by the April 8 plan (sync-mint-burn ETH-only, run-configs filtering, backfill ETH-only, status reconciliation) were addressed; this task is a regression sweep.

**Files:**
- Modify: `worker/src/cron/mint-burn/chain-context.ts` (audit; possibly no changes)
- Modify: `worker/src/cron/mint-burn/run-configs.ts` (audit)
- Create: `worker/src/cron/__tests__/sync-mint-burn-multichain.test.ts`

- [ ] **Step 1: Search for hardcoded chain references**

Use the Grep tool (project convention — CLAUDE.md mandates Grep over shell `grep`/`rg`):

- Pattern: `chainId\s*===\s*"(ethereum|arbitrum)"`
- Path: `worker/src`
- Output mode: `content`, `-n: true`

Also search for string-literal chain IDs in SQL or route handling:

- Pattern: `"ethereum"|"arbitrum"`
- Glob: `worker/src/**/*mint-burn*`
- Output mode: `content`

Review each match and classify as legitimate (USDT Issue/Redeem, reUSD-Ethereum-only bindings, etc.) vs. generalization gap.

- [ ] **Step 2: For each hit, judge:**
  - **Legitimate** (e.g., USDT-Issue/Redeem only fires on Ethereum): document with a comment, no change.
  - **Hardcode that must generalize**: file an inline TODO or fix in this task.

- [ ] **Step 3: Write a multi-chain integration test** that loads two stub configs on different chains, runs `syncMintBurn`, and asserts both produce events. This locks the genericity invariant.

```typescript
describe("syncMintBurn — multi-chain", () => {
  it("processes configs from two chains in a single run", async () => {
    // Stub MINT_BURN_CONFIGS with one Ethereum + one Optimism config (use real Optimism chain definition)
    // Stub Alchemy responses for both chain IDs
    // Run syncMintBurn
    // Assert events table has rows for both chain_id values
  });
});
```

- [ ] **Step 4: Test + commit**

```bash
cd worker && npx vitest run src/cron/__tests__/sync-mint-burn-multichain.test.ts
git add worker/src/cron/__tests__/sync-mint-burn-multichain.test.ts worker/src/cron/mint-burn/chain-context.ts worker/src/cron/mint-burn/run-configs.ts
git commit -m "test(mint-burn): lock multi-chain ingestion invariant; audit residual ETH/Arb hardcodes"
```

---

### Task 5.2: Per-chain mcap helper coverage tests

**Why:** Task 1.6 added `getMintBurnTrackedChains` and `sumMcapForTrackedChains`. As multi-chain configs land, these helpers' return values change. Lock the contract with explicit tests so silent expansion doesn't reweight the gauge unintentionally.

**Files:**
- Create: `worker/src/lib/__tests__/mint-burn-tracked-chains.test.ts`

- [ ] **Step 1: Write coverage tests**

```typescript
import { getMintBurnTrackedChains } from "../mint-burn-canonical-chain";

describe("getMintBurnTrackedChains — coverage snapshot", () => {
  // This test pins the current single-chain-per-coin contract.
  // When multi-chain configs land, update the assertions deliberately.
  it("USDC tracks ethereum only (until Base/CCTP expansion)", () => {
    expect(getMintBurnTrackedChains("usdc-circle")).toEqual(["ethereum"]);
  });
  it("USDai tracks arbitrum only", () => {
    expect(getMintBurnTrackedChains("usdai-usd-ai")).toEqual(["arbitrum"]);
  });
  it("USDT tracks ethereum only (until Tron support)", () => {
    expect(getMintBurnTrackedChains("usdt-tether")).toEqual(["ethereum"]);
  });
});
```

- [ ] **Step 2: Test + commit**

```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-tracked-chains.test.ts
git add worker/src/lib/__tests__/mint-burn-tracked-chains.test.ts
git commit -m "test(mint-burn): pin per-coin tracked-chain contract for gauge weighting"
```

---

## Phase 6: Methodology, Docs, Cleanup

### Task 6.1: Bump methodology version to v6.0

**Why:** Task 1.1 (CCIP/CCTP bridge mints), 1.2 (LayerZero endpoint-only), and 1.6 (gauge canonical-chain weighting) materially change published numbers. Per the project's numeric (not semver) rule, v5.2 → v5.3 would understate the change. Bump to v6.0.

**Version format note:** `shared/lib/mint-burn-flow-version.ts` uses `createMethodologyVersion({ currentVersion: "5.2", ... })` from `shared/lib/methodology-version.ts`. The `currentVersion` string is stored WITHOUT the `v` prefix (the prefix is auto-added by `versionLabel = \`v${currentVersion}\``). Changelog entries use plain numeric strings too (e.g., `"5.2"`, `"5.1"`). Every entry must supply ALL fields from `MethodologyChangelogEntry`: `version`, `title`, `date`, `effectiveAt`, `summary`, `impact[]`, `commits[]`, `reconstructed`.

**Coordination sequencing (critical):** The v6.0 label will surface on `/methodology/mint-burn-flow-changelog/` immediately on deploy. But historical rows are NOT yet reclassified at that moment — Task 1.7's operator playbook runs AFTER merge. Until the playbook completes, aggregate gauge numbers will be a mix of pre-fix (historical) and post-fix (new) rows. Two acceptable approaches:
(a) Delay merging Task 6.1 until Task 1.7 reclassification completes in production. Recommended.
(b) Merge Task 6.1 immediately and note in the v6.0 `summary` field that "Historical row reclassification is in-progress via backfill replay".

Pick (a). The plan's Final Validation gates on the backfill completion.

**Files:**
- Modify: `shared/lib/mint-burn-flow-version.ts`
- Modify: `src/app/methodology/mint-burn-flow-changelog/page.tsx` (verify structure first — Next.js 16 page; the content may be rendered from the changelog array or hardcoded in JSX)
- No dedicated version test file exists (the generic `shared/lib/__tests__/methodology-version.test.ts` covers `createMethodologyVersion` mechanics). We rely on typecheck + integration tests; add a narrow assertion test only if coverage drops.

- [ ] **Step 1: Update `shared/lib/mint-burn-flow-version.ts`**

Change `currentVersion: "5.2"` (line 6) to `currentVersion: "6.0"`.

Prepend a new entry at the top of the `changelog` array (line 8, before the `"5.2"` entry). Use the effective-at Unix second of the merge day (operator substitutes the real timestamp):

```typescript
  {
    version: "6.0",
    title: "Bridge classifier parity, LayerZero endpoint-only signal, canonical-chain gauge weighting",
    date: "2026-04-<DD>",           // set to merge date
    effectiveAt: <merge_unix_seconds>,
    summary:
      "Bridge classification now tags both mint and burn rows for CCIP/CCTP transactions, the LayerZero classifier recognizes endpoint-only fingerprints, and the Bank Run Gauge weights coins by their tracked-chain supply rather than global supply. Atomic-roundtrip detection now requires mint/burn totals to match within 0.5%, and custom-event counterparty extraction supports unindexed address parameters.",
    impact: [
      "CCIP and CCTP bridge mints now tag as `flow_type='bridge_transfer'` (previously leaked into economic mint flow for USDC, EURC, USDO, USD1, avUSD, ZCHF)",
      "LayerZero classifier accepts endpoint-emitter signal alone, catching Executor-only mint patterns previously missed on USDai-Arbitrum",
      "Bank Run Gauge weights each coin's intensity by its circulating supply on tracked-chain scope only (e.g., USDC weighted by Ethereum supply, not global $36B+ total)",
      "Atomic-roundtrip detection requires sum(mint) and sum(burn) to match within 0.5% — partial same-tx mix is preserved as economic flow rather than erased",
      "Custom-event counterparty extraction now supports unindexed address parameters (reUSD `Deposited` user address no longer null)",
      "Historical rows reclassified via `/api/backfill-mint-burn` replay after deploy — see operator playbook in Task 1.7",
    ],
    commits: [],
    reconstructed: false,
  },
```

- [ ] **Step 2: Update the public changelog page**

Read `src/app/methodology/mint-burn-flow-changelog/page.tsx` first. If it renders directly from `MINT_BURN_FLOW_METHODOLOGY_CHANGELOG` (likely), no edit is needed beyond step 1. If it hardcodes version copy, add a matching v6.0 section with the same summary/impact copy as above.

- [ ] **Step 3: Run existing tests + typecheck + doc-count check**

```bash
npm test -- --run shared/lib/__tests__/methodology-version.test.ts
cd worker && npx tsc --noEmit
cd .. && npm run typecheck
npm run check:doc-counts
```

If any test asserts the current version string as "5.2", update the assertion to "6.0" in the same commit.

- [ ] **Step 4: Commit**

```bash
git add shared/lib/mint-burn-flow-version.ts src/app/methodology/mint-burn-flow-changelog/page.tsx
git commit -m "docs(mint-burn): bump methodology to v6.0 (gauge & classifier corrections)"
```

---

### Task 6.2: Update internal docs and timeline

**Files:**
- Modify: `docs/mint-burn-flows.md`
- Modify: `docs/mint-burn-flows-timeline.md`

- [ ] **Step 1: Update `docs/mint-burn-flows.md`**

Sections to update:
- Methodology version → `v6.0`
- "Bridge Classifier" / classifier behavior subsection → describe new mint-tagging behavior, LayerZero endpoint-only signal, validator at config load
- "Bank Run Gauge" → describe canonical-chain mcap weighting + cite `getMintBurnTrackedChains` helper
- "Atomic Roundtrip" → mention 0.5% amount tolerance, empty-tx guard
- "Sync Algorithm" → add config deferral step, recalc-failure status downgrade, cache-purge on success
- "API Endpoints" → document the updated `/api/backfill-mint-burn` response (new `reclassified` counter fields) and the extended `/api/reclassify-atomic-roundtrips` (now reverse-flips tolerance-violating rows). No new endpoint was added — Task 1.7 reused the existing surface.
- "Database Schema" → add `mint_burn_config_deferral` table; add `idx_mbe_flow_type_ts` index

- [ ] **Step 2: Update `docs/mint-burn-flows-timeline.md`**

Prepend a v6.0 entry summarizing the change (mirror the version-file highlights).

- [ ] **Step 3: Run doc-count check**

```bash
npm run check:doc-counts
```

- [ ] **Step 4: Commit**

```bash
git add docs/mint-burn-flows.md docs/mint-burn-flows-timeline.md
git commit -m "docs(mint-burn): document v6.0 bridge/gauge/roundtrip changes and new ops endpoints"
```

---

### Task 6.3: Retire the stale coverage-expansion draft

**Why:** `agents/plans/mint-burn-coverage-expansion.md` (untracked file) was the prior plan. Tier 1 (6 ETH coins) shipped via commit `29accf66`; Tier 2 (CCTP) shipped via `831812bb`. The draft is obsolete. Move it to `agents/plans/historical/` for provenance.

**Files:**
- Move: `agents/plans/mint-burn-coverage-expansion.md` → `agents/plans/historical/2026-04-16-mint-burn-coverage-expansion-draft.md`

- [ ] **Step 1: Move and add a header note**

```bash
mv agents/plans/mint-burn-coverage-expansion.md agents/plans/historical/2026-04-16-mint-burn-coverage-expansion-draft.md
```

Edit the moved file's first lines to add:

```markdown
> **Status (2026-04-17):** Superseded by `agents/plans/2026-04-17-mint-burn-comprehensive-remediation.md`.
> Tier 1 (6 Ethereum coins) shipped in commit 29accf66.
> Tier 2 (CCTP for USDC and EURC) shipped in commit 831812bb.
> Multi-chain EVM expansion is now Phase 5 of the comprehensive plan.
```

- [ ] **Step 2: Commit**

```bash
git add agents/plans/historical/2026-04-16-mint-burn-coverage-expansion-draft.md
git commit -m "chore(plans): retire superseded mint-burn coverage-expansion draft"
```

---

## Final Validation

After all phases ship:

- [ ] **Run merge gate**

```bash
npm run test:merge-gate
```

- [ ] **Run pre-fix queries again** (Phase 0 Q1-Q5) and capture deltas in `agents/research/2026-04-17-mint-burn-post-fix-results.md`. Expected:
  - Q1: CCIP coin standard mints reduced (volume that was bridge-mint moved to `bridge_transfer`)
  - Q2: USDC/EURC effective_burn rows from TokenMinterV2 reduced to ≈0
  - Q3: reUSD null-counterparty for `direction='mint'` drops to ≈0
  - Q4: mismatched roundtrip groups drops to ≈0 after backfill (or stays elevated, indicating real ongoing issues)
  - Q5: NULL-price backlog tracked over time

- [ ] **Run live API smoke tests**

```bash
curl -s 'https://api.pharos.watch/api/mint-burn-flows' | jq '.gauge'
curl -s 'https://api.pharos.watch/api/mint-burn-flows?stablecoin=usdc-circle' | jq '.netFlowUsd, .scope'
```

Expected: gauge band changes due to weighting fix; USDC's 24h volumes should be lower (bridge mints removed).

- [ ] **Verify DEWS continues to consume `mint_burn_hourly` correctly**

```bash
npx wrangler d1 execute pharos-db --remote --command \
  "SELECT COUNT(*) FROM mint_burn_hourly WHERE hour_ts >= strftime('%s','now')-86400;"
# Cross-check against
curl -s 'https://api.pharos.watch/api/dews' | jq '.flowSignal'
```

DEWS reads `mint_burn_hourly` (which is rebuilt by recalc on every cron and after backfill), so the bridge-mint reclassification automatically propagates. No DEWS code change needed; this validates the contract.

---

## Appendix A: Future Work (separate plans)

### A1. Tron TRC-20 adapter for USDT (~$80B)
Largest single expansion target by market cap. Requires:
- TronGrid (or BitQuery/etherscan-tron) RPC adapter
- TRC-20 event decoder (similar to ERC-20 Transfer but Base58 addresses)
- USDT-Tron Issue/Redeem custom event handling (mirror ETH USDT logic)
- Bridge detection for Stargate, deBridge, JustLink (TRX cross-chain)
Estimated effort: 50-60 hours. **Defer to a dedicated plan.**

### A2. Solana SPL adapter
USDC ($15B), USDT ($5B), PYUSD ($1B), USDS ($300M+).
- Helius/QuickNode RPC, parse Anchor logs / mint authority calls
- SPL-token instruction decoding (different mental model from EVM Transfer events)
- Wormhole NTT detection
Estimated effort: 50-70 hours. **Defer to a dedicated plan.**

### A3. Per-chain EVM coin configs (Base, BSC, Polygon, Optimism, Avalanche)
Once Phase 5 groundwork is in, each chain expansion is a separate plan:
- Base: USDC native (CCTP), USD0, EURC, MNEE — verify CCTP detection extends
- BSC: FDUSD natively issued (currently only tracked from ETH side, missing the actual issuance chain), LISUSD, USDT
- Polygon: USDC native, USDT, EURs
- Optimism: USDC native, USDT
- Avalanche: USDC, USDT, EURC

Each chain plan should include: Alchemy chain enabling, per-token configs, native-bridge detection (Optimism/Arbitrum/Base portal contracts), backfill operation, doc updates.

### A4. Additional bridge protocols (gated on volume validation)
Run Phase 0-style queries to check whether undetected bridges produce material volume:
- Stargate v2 (LayerZero-based; if any tracked coin uses it natively)
- Across v3 (intent-based; mechanism unclear)
- Fraxferry (FRAX, FRXUSD)
- Hop Protocol, Synapse Protocol
- Native L2 bridge contracts (Optimism Portal, Arbitrum Inbox, Base Bridge)

Only build detection for protocols where the validation query shows >$1M/30d misclassification.

### A5. Sensitivity analysis on scoring constants
- `DENOM_SCALE = 0.3`, `Z_MULTIPLIER = 50`, `DENOM_FLOOR = $1M`, `MIN_ACTIVITY_USD = $50K`, `FTQ_THRESHOLD = $100M`
- Backtest against historical depeg events (USDC SVB, USDR collapse, USDe depegs) to confirm thresholds fire on real stress and stay quiet during normal volatility.
- Document chosen values in `docs/mint-burn-flows.md` with justifications.
