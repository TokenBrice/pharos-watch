# Reserve Sync Remediation & Expansion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close correctness/robustness gaps in the live reserve sync pipeline, raise adapter quality so more coins qualify for scoring-eligible live evidence, and expand coverage via ready-to-use adapter wiring plus a targeted set of new integrations.

**Architecture:** Work in phases, each independently shippable. Phase 0 fixes *visible-wrong data* in production. Phase 1 hardens the framework. Phase 2 fixes adapter-specific correctness. Phase 3 closes test-coverage invariants. Phase 4 ships coverage expansion via existing adapters. Phase 5 tackles the larger rewrites. Phase 6 documents methodology decisions.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (SQLite), Vitest, Zod, Viem (one adapter), Multicall3 (new).

**Sources:**
- `agents/audits/2026-04-15-live-reserve-sync-full-adapter-audit.md`
- `agents/audits/live-reserve-configured-promotion-audit-2026-04-15.md`
- `agents/audits/live-reserve-remaining-candidates-audit-2026-04-15.md`
- `agents/audits/2026-04-16-live-reserve-sync-infrastructure-audit.md`
- `agents/research/2026-04-16-dola-live-reserve-adapter.md`
- `agents/research/2026-04-16-ethena-live-reserve-adapter.md`
- April 16 parallel audits (infrastructure, on-chain adapters × 2, HTTP/HTML adapters × 2, coverage expansion)

---

## Ground Rules

1. **Surgical changes only.** Every code change must trace back to a finding or task here.
2. **No backward-compat shims.** If a field's semantics change, change the downstream readers too, not feature flags.
3. **Real-fixture tests.** No hand-crafted mocks for new/changed external-API parsing; record a fixture from the live endpoint first. (See MEMORY: "Real API fixtures, not hand-crafted mocks".)
4. **Verify-before-complete loop.** Each task ends with `npm test` (scoped) + `cd worker && npx tsc --noEmit`. Critical adapter changes also run the live-smoke check.
5. **Methodology version bumps.** Any change to scoring-eligible freshness, evidence class, or reserve semantics increments `shared/lib/live-reserve-*.ts` policy version numerically (not semver). Update `/methodology` page and `docs/live-reserves.md`.
6. **Commit granularity.** One task = one commit (Conventional Commits, prefix `fix(reserves):` / `feat(reserves):` / `refactor(reserves):` as appropriate).

---

## Phase 0 — Production Data Correctness (Critical, Ship First)

These fixes address data currently visible in production that is misleading or will become wrong soon. Ship before any expansion.

### Task 0.1: Fix `usd1-bundle-oracle` misleading `collateralizationRatio`

**Problem:** The USD1 Chainlink bundle oracle at `0x691b...D4c4` reports **WLFI aggregate fund reserves** across multiple products, not USD1-earmarked collateral. `collateralizationRatio = totalReserveUsd / supplyUsd = ~2.66` surfaces in `metadata` and `/api/stablecoin-reserves/usd1-world-liberty-financial`. Consumers (display, scoring, report cards) receive a misleading 266% ratio for a 1:1 backed stablecoin.

**Files:**
- Modify: `worker/src/cron/reserve-adapters/usd1-bundle-oracle.ts:95-116`
- Modify: `worker/src/cron/reserve-adapters/__tests__/usd1-bundle-oracle.test.ts`
- Modify: `docs/live-reserves.md` (update the note on usd1-bundle-oracle)

- [ ] **Step 1: Write the failing test** asserting the adapter no longer emits `collateralizationRatio` but instead emits `fundBackingTotalRatio` (or omits entirely) to avoid misleading semantics.

```ts
it("does not emit misleading collateralizationRatio when oracle reports fund-wide reserves", () => {
  const result = adaptUsd1BundleOracle({
    bundle: { timestamp: 1_776_000_000n, reserves: 100_000_000n * 10n ** 18n },
    latestTimestamp: 1_776_000_000n,
    totalSupplyRaw: 37_500_000n * 10n ** 18n, // ~$37.5M USD1 supply
    reserveDecimals: 18,
  });
  expect(result.metadata?.collateralizationRatio).toBeUndefined();
  expect(result.metadata?.fundBackingTotalRatio).toBeCloseTo(2.666, 3);
  expect(result.metadata?.details?.fundScope).toBe(
    "WLFI aggregate fund reserves; denominator is USD1 supply only",
  );
});
```

- [ ] **Step 2: Run test to verify it fails.**

`cd worker && npm test -- reserve-adapters/__tests__/usd1-bundle-oracle.test.ts`
Expected: FAIL (`collateralizationRatio` still emitted).

- [ ] **Step 3: Update adapter to drop `collateralizationRatio` and rename to `fundBackingTotalRatio` with provenance note.**

```ts
// usd1-bundle-oracle.ts (in adapt function)
return {
  slices: [ /* unchanged */ ],
  metadata: {
    // ... existing fields ...
    // REMOVED: collateralizationRatio
    fundBackingTotalRatio: totalReserveUsd / supplyUsd,
    totalReserveUsd,
    supplyUsd,
    details: {
      fundScope: "WLFI aggregate fund reserves; denominator is USD1 supply only",
      ...existingDetails,
    },
    // ... redemption telemetry unchanged ...
  },
};
```

- [ ] **Step 4: Run test to verify it passes.**

`cd worker && npm test -- reserve-adapters/__tests__/usd1-bundle-oracle.test.ts`
Expected: PASS.

- [ ] **Step 5: Update downstream consumers.** Search for `collateralizationRatio` from usd1 source:

```bash
rg "collateralizationRatio" worker/src shared/lib src
```

Any place that reads `metadata.collateralizationRatio` and assumes 1:1 semantic must either (a) tolerate its absence, or (b) reject usd1 source explicitly.

- [ ] **Step 6: Bump docs.**

Edit `docs/live-reserves.md` section on `usd1-bundle-oracle` to explain the fund-scope disclaimer.

- [ ] **Step 7: Commit.**

```bash
git add worker/src/cron/reserve-adapters/usd1-bundle-oracle.ts \
        worker/src/cron/reserve-adapters/__tests__/usd1-bundle-oracle.test.ts \
        docs/live-reserves.md
git commit -m "fix(reserves): drop misleading collateralizationRatio from USD1 bundle oracle"
```

---

### Task 0.2: Fix `chainlink-por` multichain supply aggregation (TUSD is the canonical case)

**Problem:** Any `chainlink-por`-configured coin with multichain issuance suffers the same bug: supply denominator uses `input.chain` only. TUSD surfaces `1.59` in production because Tron (+ Avalanche + Polygon + Arbitrum + Optimism + BSC) supply is omitted. Warning fires only under-0.995, so over-collateralization anomalies are silent.

**Scope:** Generalize the fix to aggregate supply across all EVM chains listed in `coin.contracts`. Tron (requires base58→hex — see MEMORY gotcha) is skipped with an info-severity `por-supply-chain-omitted` warning.

**Files:**
- Modify: `worker/src/cron/reserve-adapters/chainlink-por.ts:151-169`
- Modify: `worker/src/cron/reserve-adapters/__tests__/chainlink-por.test.ts`

- [ ] **Step 1: Write failing test** for multi-chain coin. Use a synthetic coin with `contracts` on multiple chains and assert the aggregate supply matches all chains (or ratio suppressed when aggregation unsupported).

```ts
it("sums totalSupply across all configured chains for the ratio denominator", async () => {
  const coin = {
    id: "tusd-test",
    contracts: [
      { chain: "ethereum", address: "0xeth", decimals: 18 },
      { chain: "tron", address: "Ttron" /* ... */ },
    ],
  } as StablecoinMeta;
  mockEvmCalls({
    ethereum: { totalSupply: 300_000_000n * 10n ** 18n },
  });
  mockTronCall({ totalSupply: 200_000_000n * 10n ** 18n });
  const result = await fetchChainlinkPorReserves(coin, configEth, signal, ctx);
  // ratio should be ~1.0, not 1.59
  expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.0, 2);
});

it("emits over-collateralization warning when ratio > 1.1", () => {
  const result = adaptChainlinkPorResponse(data, params, { raw, decimals: 18, tokenAddress: "0x..." });
  expect(result.warnings?.some((w) => w.code === "por-reserve-over-supply")).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify failure.**

Expected: FAIL.

- [ ] **Step 3: Implement multichain supply aggregation.** Since Tron requires base58→hex (flagged in MEMORY as unsupported), for this task aggregate only EVM chains in `coin.contracts`. If non-EVM contracts exist, skip the cross-check and emit an `info`-severity warning explaining the omission.

```ts
// chainlink-por.ts (replace lines 151-170)
const allEvmContracts = coin.contracts?.filter((c) => c.chain !== "tron" && c.chain !== "solana") ?? [];
const supplyReads = await Promise.all(allEvmContracts.map(async (c) => ({
  chain: c.chain,
  contract: c.address,
  raw: await fetchErc20TotalSupply(
    { ...input, chain: c.chain },
    c.address,
    signal,
    ctx,
    params.rpcUrl,
    params.fallbackRpcUrl,
  ),
  decimals: c.decimals ?? 18,
})));

const missingSupply = supplyReads.filter((r) => r.raw == null);
if (missingSupply.length > 0 && missingSupply.length === supplyReads.length) {
  throw new Error(`chainlink-por: totalSupply() call failed on all chains for ${coin.id}`);
}

const multichainSupplyUsd = supplyReads
  .filter((r) => r.raw != null)
  .reduce((acc, r) => acc + decimalNumberFromBigInt(r.raw!, r.decimals), 0);

const hasNonEvm = (coin.contracts ?? []).some((c) => c.chain === "tron" || c.chain === "solana");
```

- [ ] **Step 4: Add over-collateralization warning.** In `adaptChainlinkPorResponse`:

```ts
const overCollatWarning = collateralizationRatio != null && collateralizationRatio > 1.1
  ? reserveDegradedWarning(
      "por-reserve-over-supply",
      `Chainlink PoR reserves cover ${(collateralizationRatio * 100).toFixed(2)}% of multichain token supply (possible scope mismatch)`,
    )
  : null;
```

Pass `hasNonEvm` through so a non-EVM chain omission emits an info warning.

- [ ] **Step 5: Run tests, verify pass.**

- [ ] **Step 6: Commit.**

```bash
git commit -m "fix(reserves): aggregate multichain supply in chainlink-por ratio"
```

---

### Task 0.3: Fix `river-protocol-info` timestamp selection across historical series

**Problem:** `river-protocol-info.ts:33-36` passes historical `tvlData[].timestamp + circulatingData[].timestamp` arrays through `summarizeSourceTimestamps(...)` and uses `.sourceTimestamp` (MIN). For time-series data this picks the OLDEST point, making a fresh "right now" TVL look days/weeks stale. Current single-point tests don't catch this. Weak-live-probe impact is limited to `/status` + `/api/stablecoin-reserves/satusd-river` display, but it's visibly wrong.

Important: `summarizeSourceTimestamps` **already returns both MIN and MAX** (see `freshness.ts:55-62` → `{sourceTimestamp, latestSourceTimestamp}`). No new helper needed.

**Files:**
- Modify: `worker/src/cron/reserve-adapters/river-protocol-info.ts:33-52` (and the `verifiedFreshnessMetadata(...)` call-site)
- Modify: `worker/src/cron/reserve-adapters/__tests__/river-protocol-info.test.ts`

- [ ] **Step 1: Write failing test** with multi-point series:

```ts
it("uses the latest point for snapshot timestamp (not min)", () => {
  const payload = {
    tvlData: [
      { timestamp: 1_775_000_000, tvlInUsd: 1000 },
      { timestamp: 1_776_000_000, tvlInUsd: 2000 },
    ],
    circulatingData: [
      { timestamp: 1_775_500_000, circulatingSupply: 500 },
      { timestamp: 1_776_500_000, circulatingSupply: 1500 },
    ],
  };
  const result = adaptRiverProtocolInfo(payload);
  expect(result.metadata?.sourceTimestamp).toBe(1_776_500_000);
  expect(result.metadata?.freshnessMode).toBe("verified");
});
```

Expected: FAIL (currently returns 1_775_000_000).

- [ ] **Step 2: One-line fix** in `river-protocol-info.ts`: swap `.sourceTimestamp` → `.latestSourceTimestamp` at the `verifiedFreshnessMetadata(...)` call. Keep the spread warning logic as-is (spread detection still works regardless of which endpoint is authoritative). Retain the existing `oldestSourceTimestamp` breadcrumb for diagnostics.

- [ ] **Step 3: Apply the same fix pattern to point-in-time adapters** that aggregate time-series data. Audit `solstice-attestation.ts:34-41` (local `sort desc`) and `usdai-proof-of-reserves.ts:97` (local `Math.max`) — these can migrate to `summarizeSourceTimestamps(...).latestSourceTimestamp` for consistency, but only if the semantics match point-in-time latest (verify first). If they don't need aggregation, leave untouched.

- [ ] **Step 4: Run tests.** `cd worker && npm test -- reserve-adapters/__tests__/river-protocol-info.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git commit -m "fix(reserves): river point-in-time timestamp uses latest, not min"
```

**Phase placement note:** While `weak-live-probe` adapters do not gate scoring, stale-looking display on `/status` is still a production issue. Keeping in Phase 0 for correctness visibility.

---

### Task 0.4: Cap-vault — null RPC responses must fail closed

**Problem:** `cap-vault.ts:267-270` treats null `totalSupplies`/`totalBorrows`/`available`/`paused` as zero without warning. A partially failing RPC silently drops slices. `decimals()` null defaults to 18 (incorrect for USDC/USDT by 10^12). `paused ?? false` over-reports redemption capacity.

**Files:**
- Modify: `worker/src/cron/reserve-adapters/cap-vault.ts:203-270`
- Modify: `worker/src/cron/reserve-adapters/__tests__/cap-vault.test.ts`

- [ ] **Step 1: Write failing tests:**

```ts
it("fails closed when totalSupplies RPC returns null", async () => {
  mockRpc({ totalSupplies: null });
  await expect(fetchCapVaultReserves(coin, config, signal, ctx))
    .rejects.toThrow(/cap-vault: failed to read totalSupplies/);
});

it("fails closed when decimals RPC returns null", async () => {
  mockRpc({ decimals: null });
  await expect(fetchCapVaultReserves(coin, config, signal, ctx))
    .rejects.toThrow(/cap-vault: failed to read decimals/);
});

it("treats paused decode-null as paused (conservative)", async () => {
  mockRpc({ paused: null });
  const result = await fetchCapVaultReserves(coin, config, signal, ctx);
  const warning = result.warnings?.find((w) => w.code === "cap-vault-asset-status-unavailable");
  expect(warning).toBeDefined();
  // paused-treated-as-true must exclude from immediateRedeemable
  expect(result.metadata?.immediateRedeemableUsd).toBe(0);
});
```

- [ ] **Step 2: Rewrite per-asset read block to throw on null.**

```ts
// cap-vault.ts replacement for lines 257-270
const rawDecimals = await fetchOnchainUint256({ ...callBase, data: DECIMALS_SELECTOR });
if (rawDecimals == null) {
  throw new Error(`cap-vault: failed to read decimals() for asset ${asset.address}`);
}
const decimals = Number(rawDecimals);

const [totalSuppliesRaw, totalBorrowsRaw, availableRaw, pausedHex] = await Promise.all([
  fetchOnchainUint256({ ...callBase, data: TOTAL_SUPPLIES_SELECTOR }),
  fetchOnchainUint256({ ...callBase, data: TOTAL_BORROWS_SELECTOR }),
  fetchOnchainUint256({ ...callBase, data: AVAILABLE_SELECTOR }),
  fetchOnchainRawCall({ ...callBase, data: PAUSED_SELECTOR }),
]);

if (totalSuppliesRaw == null) {
  throw new Error(`cap-vault: failed to read totalSupplies() for asset ${asset.address}`);
}
if (totalBorrowsRaw == null) {
  throw new Error(`cap-vault: failed to read totalBorrows() for asset ${asset.address}`);
}
if (availableRaw == null) {
  throw new Error(`cap-vault: failed to read available() for asset ${asset.address}`);
}

// Conservative: treat decode failure as paused.
const pausedDecoded = pausedHex != null ? decodeBool(pausedHex) : null;
const paused = pausedDecoded ?? true;
const pausedStatusUnavailable = pausedDecoded == null;
```

Record `pausedStatusUnavailable` per asset, and push a `cap-vault-asset-status-unavailable` info warning when true.

- [ ] **Step 3: Run tests. Expected: PASS.**

- [ ] **Step 4: Commit.**

```bash
git commit -m "fix(reserves): cap-vault fails closed on null RPC reads, conservative paused fallback"
```

**Note:** The USD-peg assumption for cap-vault asset valuation (treating asset units directly as USD) is deferred to Phase 2 Task 2.21 because it's a schema change, not a data-correctness fix.

---

### Task 0.5: `usdai-proof-of-reserves` — scope timestamp MAX to proof-row payload

**Problem:** `extractUsdAiProofPageTimestamp` at `usdai-proof-of-reserves.ts:92-97` scans the entire Next.js hydration payload for `timeLastUpdated` via a **JSON-escaped** regex `/\\?"timeLastUpdated\\?"\s*:\s*\\?"([^"\\]+)\\?"/g` (NOT HTML attributes). `Math.max(...)` across all matches can pick unrelated new rows (activity feed, news, inactive proofs). Currently scoring-live, so a wrong-timestamp risk directly affects report-card scoring.

**Files:**
- Modify: `worker/src/cron/reserve-adapters/usdai-proof-of-reserves.ts:92-98`
- Modify: `worker/src/cron/reserve-adapters/__tests__/usdai-proof-of-reserves.test.ts`

- [ ] **Step 0 (prerequisite):** WebFetch `https://app.usd.ai/reserves` and save a recent HTML dump. Inspect the Next.js `__NEXT_DATA__` or equivalent payload to identify the **structural parent key** of `timeLastUpdated` entries that belong to the canonical proof rows (e.g., `"proofs":[{...,"timeLastUpdated":"..."}]` vs. `"activity":[...]`). The exact key name drives Step 2.

- [ ] **Step 1: Write failing test** against a real or representative hydration-payload string. The fixture must contain ≥1 `timeLastUpdated` inside the proof section and ≥1 OUTSIDE it (e.g., under `activity` or `news`). Expected: MAX of only the in-section timestamps.

```ts
it("picks the latest timeLastUpdated from the proof-rows payload only", () => {
  const html = `
    ...{"activity":[{"timeLastUpdated":"1800000000"}],
       "proofs":[
         {"timeLastUpdated":"1770000000"},
         {"timeLastUpdated":"1771000000"}
       ]}...
  `;
  expect(extractUsdAiProofPageTimestamp(html)).toBe(1771000000);
});
```

- [ ] **Step 2: Rewrite extractor to first isolate the proofs-array substring, then match `timeLastUpdated` within it.** The existing helper `extractEscapedJsonValueAfterKey(html, key, adapterName)` at `html.ts:15` throws a `layout-changed` error when the key is missing; wrap it in try/catch so the extractor degrades instead of failing the whole adapter. Example shape (adjust key name per Step 0):

```ts
export function extractUsdAiProofPageTimestamp(html: string): number | null {
  let proofsSlice: string;
  try {
    // Depth-balanced extraction via existing helper; throws if key missing.
    proofsSlice = extractEscapedJsonValueAfterKey(html, "proofs", "usdai-proof-of-reserves");
  } catch {
    return null; // Step 3 info-warning fallback in the caller handles this
  }

  const timestamps = Array.from(proofsSlice.matchAll(/\\?"timeLastUpdated\\?"\s*:\s*\\?"([^"\\]+)\\?"/g))
    .map((m) => parseTimestampLikeToUnixSeconds(m[1]))
    .filter((v): v is number => v != null);

  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}
```

If Step 0 reveals the proof rows live under a different key (e.g., `reserves`), adjust the key name — do not invent it.

- [ ] **Step 3: If the proof-slice extraction fails, fall through to the current whole-page MAX** with an info warning (`usdai-proof-scope-fallback`) so operators see the degradation rather than silently trust a broader scan.

- [ ] **Step 4: Run test. Expected: PASS.**

- [ ] **Step 5: Commit.**

```bash
git commit -m "fix(reserves): scope USDai page-timestamp extraction to proof rows"
```

---

### Task 0.6: `btcfi` — emit per-symbol slices (attribution, not yet risk differentiation)

**Problem:** Every BTC-variant handler (BTC/WBTC/cbBTC/tBTC/LBTC/BTCB/etc.) collapses into a single medium-risk slice labeled `"BTC / WBTC / BTCB / cbBTC"` (`btcfi.ts:54-60`). Lost attribution: display, blacklist attribution, and dependency edges cannot distinguish bridged (BitGo custody) from trustless (threshold-sig) variants.

**Scope note:** The canonical risk map at `shared/lib/reserve-asset-risk.ts:36-46` currently assigns `medium` uniformly to all BTC wrappers. This task narrows scope to **per-symbol attribution** (preserves variant identity in slice names + coinId). A separate methodology task (out of scope here) would decide whether to split WBTC/cbBTC/tBTC risk tiers.

**Files:**
- Modify: `worker/src/cron/reserve-adapters/btcfi.ts:35-75`
- Modify: `worker/src/cron/reserve-adapters/__tests__/btcfi.test.ts`

- [ ] **Step 1: Write failing test** asserting distinct slices by observed symbol, all at `medium` risk (per current canonical map), with `coinId` populated where a tracked canonical coin exists.

```ts
it("emits distinct slices per BTC variant with per-symbol attribution", () => {
  const result = adaptBtcfiPayload(payloadWithMixedVariants);
  const sliceNames = result.slices.map((s) => s.name).sort();
  expect(sliceNames).toContain("WBTC");
  expect(sliceNames).toContain("TBTC");
  expect(sliceNames).toContain("CBBTC");
  // Today all at medium; promotion to per-symbol risk is a separate methodology task.
  expect(result.slices.every((s) => s.risk === "medium")).toBe(true);
});
```

- [ ] **Step 2: Import `getCanonicalReserveAssetRisk` from `@shared/lib/reserve-asset-risk`** and emit one slice per observed symbol, using the canonical risk mapping. Unknown symbols fall into a single `"Unmapped BTC variants"` slice at `high` risk with `unknownExposurePct` tracked.

- [ ] **Step 3: Run test. Commit.**

```bash
git commit -m "fix(reserves): btcfi emits per-symbol slices for attribution"
```

---

## Phase 1 — Framework Hardening (Critical/High)

### Task 1.1: Harden `parseReserveCompositionRow` against unknown adapter keys

**Problem:** `resolveSnapshotSourceModel` / `resolveSnapshotEvidenceClass` call `getLiveReserveAdapterDefinition(adapterKey)`, which throws TypeError on unknown key. Legacy/removed adapter rows in `reserve_composition.source` cascade into API 5xx, cron crashes, scoring/drift crashes.

**Files:**
- Modify: `shared/lib/live-reserve-adapters.ts` (harden accessor)
- Modify: `worker/src/lib/live-reserves-store-row-decoding.ts:286-304`
- Modify: `worker/src/lib/__tests__/live-reserves-store.test.ts`

- [ ] **Step 1: Write failing test**:

```ts
it("treats unknown stored adapter key as corrupt data, not a crash", async () => {
  await db.prepare(`INSERT INTO reserve_composition (stablecoin_id, slices, fetched_at, source, metadata, warning_count, attempt_id)
    VALUES ('test-coin', '[{"name":"X","pct":100,"risk":"low"}]', 1776000000, 'removed-adapter-key', '{}', 0, 'attempt-1')`).run();
  await db.prepare(`INSERT INTO reserve_sync_state (stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_success_at, last_status, warning_count, metadata, last_attempt_id, last_success_attempt_id)
    VALUES ('test-coin', 'removed-adapter-key', 'bk', 1776000000, 1776000000, 'ok', 0, '{}', 'attempt-1', 'attempt-1')`).run();
  const result = await resolveReserveResult(db, 'test-coin');
  // Should gracefully fall through to corrupt/missing; must not throw
  expect(result).toBeDefined();
});
```

- [ ] **Step 2: Change `getLiveReserveAdapterDefinition` in shared to return `null` for unknown keys; callers must handle.**

```ts
// shared/lib/live-reserve-adapters.ts
export function getLiveReserveAdapterDefinition(
  adapterKey: string,
): (typeof LIVE_RESERVE_ADAPTER_DEFINITIONS)[LiveReserveAdapterKey] | null {
  return LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey as LiveReserveAdapterKey] ?? null;
}
```

- [ ] **Step 3: Update `resolveSnapshotSourceModel` / `resolveSnapshotEvidenceClass`** to return a neutral default when the definition is absent, and set an `issue: { code: "unknown-adapter-source" }` so `parseReserveCompositionRow` returns `{ record: null, issue }`.

- [ ] **Step 4: Audit all other callers** of `getLiveReserveAdapterDefinition` (should be ~3) and apply null-handling.

- [ ] **Step 5: Run test + full worker test suite. Commit.**

```bash
git commit -m "fix(reserves): harden adapter-definition lookup against legacy stored keys"
```

---

### Task 1.2: Enforce attempt-id fencing on `reserve_composition` upsert (covers C5 + C6)

**Problem:** Two related races exist in `finalizeReserveSyncSuccess`:
1. **C5 — Orphan history:** composition_history INSERT runs before the fenced state UPDATE; if the UPDATE is rejected (late attempt, deadline passed), history carries a rejected attempt row.
2. **C6 — Clobber:** a late-running attempt's composition upsert (no fencing on its WHERE) can overwrite a newer attempt's composition row, even though the sync_state row still points to the newer attempt_id.

**Files:**
- Modify: `worker/src/lib/live-reserves-store-statements.ts:10-51` (add fencing to composition upsert)
- Modify: `worker/src/lib/live-reserves-store-write.ts:31-58` (reorder writes; prefer `db.batch`)
- Modify: `worker/src/lib/__tests__/live-reserves-store.test.ts`

- [ ] **Step 1: Add fencing to composition upsert.** Accept only newer or equal `fetched_at`, and require matching attempt_id on conflict (treat historical rows as immutable).

```sql
INSERT INTO reserve_composition (...) VALUES (...)
ON CONFLICT(stablecoin_id) DO UPDATE SET
  slices = excluded.slices,
  fetched_at = excluded.fetched_at,
  source = excluded.source,
  attempt_id = excluded.attempt_id,
  metadata = excluded.metadata,
  warning_count = excluded.warning_count,
  warnings = excluded.warnings,
  adapter_source_model = excluded.adapter_source_model,
  adapter_evidence_class = excluded.adapter_evidence_class
WHERE reserve_composition.fetched_at < excluded.fetched_at
   OR (reserve_composition.fetched_at = excluded.fetched_at AND reserve_composition.attempt_id IS NULL)
```

- [ ] **Step 2: Reorder writes via `db.batch` for atomicity:**

```ts
// live-reserves-store-write.ts
export async function finalizeReserveSyncSuccess(...) {
  const [compositionRes, finalizeRes] = await db.batch([
    buildReserveCompositionUpsertStatement(db, composition),
    buildReserveSyncFinalizeSuccessStatement(db, syncState, finalizeDeadlineMs),
  ]);
  const finalized = (finalizeRes.meta.changes ?? 0) > 0;
  const compositionApplied = (compositionRes.meta.changes ?? 0) > 0;

  // Guard: the state UPDATE may succeed while the composition UPSERT no-ops (a newer row already exists).
  // Treat that as a failed finalize — do not insert history.
  if (finalized && compositionApplied) {
    await db.batch([
      buildReserveCompositionHistoryInsertStatement(db, composition),
      buildReserveSyncAttemptHistoryInsertStatement(db, { ... }),
    ]);
    return { finalized: true };
  }
  return { finalized: false };
}
```

- [ ] **Step 3: Write tests** for:
  - Late attempt A cannot overwrite earlier-fetchedAt row owned by B (composition stays at B's slices).
  - Late attempt where state UPDATE succeeds but composition UPSERT no-ops → function returns `finalized: false` and no history rows insert.
  - History rows are only inserted when both fenced UPDATE and composition UPSERT succeed.

- [ ] **Step 4: Run tests, typecheck. Commit.**

```bash
git commit -m "fix(reserves): fence composition upsert and defer history writes on finalize"
```

---

### Task 1.3: Per-run budget guard for sync-live-reserves

**Problem:** `ADAPTER_TIMEOUT_MS = 20_000` × 140 coins = 46 min vs the 12-min lease. A batch of slow/breaker-not-yet-open adapters can hit the lease abort mid-coin, leaving `pending_attempt_id` dangling.

**Files:**
- Modify: `worker/src/cron/sync-live-reserves.ts:197-246`
- Modify: `worker/src/cron/__tests__/sync-live-reserves.test.ts`

- [ ] **Step 1: Add a new `recordReserveSyncDeferred` helper** in `worker/src/lib/live-reserves-store-write.ts`. It does a single UPSERT setting `last_status = 'skipped'`, `last_error = 'run-budget-exhausted'`, `metadata.failureCategory = 'run-budget-exhausted'`, and leaves `pending_attempt_id = NULL` + `last_success_*` untouched. This avoids the dangling-attempt hazard (the skip path must NOT call `beginReserveSyncAttempt`, which would write a dangling `pending_attempt_id`).

- [ ] **Step 2: Add the per-run budget guard** at the top of each coin iteration; when remaining budget is below the per-coin timeout, flush all remaining coins via the helper and break:

```ts
const SYNC_RUN_BUDGET_MS = 11 * 60 * 1000; // leave 1 min safety before lease
const runStartedMs = Date.now();

for (const [index, coin] of CONFIGURED_COINS.entries()) {
  if (signal?.aborted) throw signal.reason ?? new Error("sync-live-reserves aborted");
  
  const elapsed = Date.now() - runStartedMs;
  const budgetRemaining = SYNC_RUN_BUDGET_MS - elapsed;
  if (budgetRemaining < ADAPTER_TIMEOUT_MS) {
    console.warn(`[sync-live-reserves] Run budget exhausted at coin ${index}/${total}, deferring remaining`);
    for (const remaining of CONFIGURED_COINS.slice(index)) {
      const remainingConfig = remaining.liveReservesConfig!;
      const remainingBreakerKey = breakerKeyForConfig(remainingConfig);
      await recordReserveSyncDeferred(db, {
        stablecoinId: remaining.id,
        adapterKey: remainingConfig.adapter,
        breakerKey: remainingBreakerKey,
        attemptedAt: Math.floor(Date.now() / 1000),
        reason: "run-budget-exhausted",
      });
      skipped++;
    }
    break;
  }
  // ... existing per-coin loop ...
}
```

- [ ] **Step 3: Test** that a simulated slow run marks later coins as skipped, and verify `pending_attempt_id` stays NULL for the deferred coins.

- [ ] **Step 4: Commit.**

- [ ] **Step 3: Commit.**

```bash
git commit -m "fix(reserves): add per-run budget guard to avoid mid-coin lease abort"
```

---

### Task 1.4: Atomic stale-artifact cleanup via single DELETE

**Problem:** Per-row DELETEs inside a loop; lease loss mid-cleanup leaves partial state. Consolidate into one DELETE and use `db.batch`.

**Files:**
- Modify: `worker/src/cron/sync-live-reserves.ts:39-65`
- Modify: `worker/src/cron/__tests__/sync-live-reserves.test.ts`

- [ ] **Step 1: Replace loop with single NOT IN DELETE, wrapped in `db.batch`:**
  - DELETE from `reserve_sync_state` WHERE `stablecoin_id NOT IN (...)`
  - DELETE from `cache` WHERE `key LIKE 'circuit:live-reserves:%'` AND `key NOT IN (...)`
  - DELETE from `reserve_composition` WHERE `stablecoin_id NOT IN (...)` ← M8 fix explicitly (orphan composition rows on delisting)

  Handle `IN (...)` param chunking for >999 ids (D1 limit). The orphan `reserve_composition` cleanup is safe because delisted coins 404 at the API layer via `ACTIVE_IDS.has(id)`, but the rows were otherwise unreachable (no retention cap outside 90-day history prune).

- [ ] **Step 2: History retention pruning stays separate** (see `pruneLiveReserveHistory`). Confirm no contention between the two delete paths.

- [ ] **Step 3: Test + commit.**

```bash
git commit -m "refactor(reserves): atomic stale-artifact cleanup via batched DELETE"
```

---

### Task 1.5: Improve `classifyFailure` coverage for adapter-config errors

**Problem:** Zod adapter-params errors ("`${adapterKey} adapter params invalid.<path>: <zod message>`") and `requireXxxInput` errors fall through to `"unknown"`.

**Files:**
- Modify: `worker/src/cron/sync-live-reserves-shared.ts:92-113`
- Add: `worker/src/cron/__tests__/classify-failure.test.ts` (new)

- [ ] **Step 1: Write table-driven test** covering all 8 categories + adapter-config + edge cases (AbortError, TypeError from non-Error throws).

- [ ] **Step 2: Add keyword matches:**

```ts
if (message.includes("adapter params invalid") || message.includes("adapter requires")) {
  return "adapter-config";
}
if (reason === "adapter-exception" && (lastError ?? "").toLowerCase().includes("invalid reserve output")) {
  return "validation";
}
```

- [ ] **Step 3: Commit.**

```bash
git commit -m "fix(reserves): classify adapter-config failures distinctly"
```

---

### Task 1.6: Overview counter consistency

**Problem:** `writeTimeoutUncertain` double-counts with `missingCoins`/`errorCoins`.

**Files:**
- Modify: `worker/src/lib/live-reserves-store-overview.ts:58-115`
- Modify: `worker/src/lib/__tests__/live-reserves-store.test.ts`

- [ ] **Step 1: Move `writeTimeoutUncertain++` into the appropriate primary-bucket branch** (either `errorCoins` or `missingCoins`) so it's a sub-classifier, not a cross-bucket count.

- [ ] **Step 2: Test** a coin with `uncertainWrite=true` + no composition row: should count in one bucket only.

- [ ] **Step 3: Commit.**

```bash
git commit -m "fix(reserves): overview writeTimeoutUncertain is a sub-bucket, not cross-counted"
```

---

### Task 1.7: Decouple scheduled cascade (hourly handler)

**Problem:** If `sync-live-reserves` throws catastrophically, `kinesis supply` and `drift check` are skipped.

**Files:**
- Modify: `worker/src/handlers/scheduled/hourly-live-reserves.ts:16-67`

- [ ] **Step 1: Wrap each block in independent try/catch so later blocks always run.**

- [ ] **Step 2: Test** (vitest with mocked cron wrappers) that a thrown sync error still triggers the other blocks.

- [ ] **Step 3: Commit.**

```bash
git commit -m "fix(reserves): decouple hourly cascade so downstream blocks always run"
```

---

### Task 1.8: Stable-stringify for shared source cache key

**Problem:** `JSON.stringify` insertion-order dependent; benign today but fragile.

**Files:**
- Modify: `worker/src/cron/sync-live-reserves-shared.ts:34-57`

- [ ] **Step 1: Import or implement a tiny canonical stringifier (recursive key-sort).** Apply in `buildSharedSourceCacheKey`.

- [ ] **Step 2: Test** two coins with identical params in different key order hit the same cache entry.

- [ ] **Step 3: Commit.**

```bash
git commit -m "refactor(reserves): canonical stringify for shared source cache key"
```

---

### Task 1.9: Source cache — retain failure for rest of run

**Problem:** Current code evicts the failing promise from `sharedSourceResults`, causing each remaining coin to refetch.

**Files:**
- Modify: `worker/src/cron/sync-live-reserves.ts:148-168`

- [ ] **Step 1: Keep the rejected promise cached for the run** (so subsequent coins see the same failure without new fetches). Let the breaker handle cross-run retry suppression.

- [ ] **Step 2: Test** that a single upstream failure results in exactly one fetch for all sharing coins.

- [ ] **Step 3: Commit.**

```bash
git commit -m "fix(reserves): retain source-cache failure for the run to avoid retry fan-out"
```

---

### Task 1.10: Emit `primary-fallback-used` info warning

**Problem:** Silent primary-to-fallback transitions leave operators blind to primary degradation.

**Files:**
- Modify: `worker/src/cron/sync-live-reserves.ts:170-195`

- [ ] **Step 1: When a fallback succeeds after primary failed, attach an info warning** to the AdapterResult indicating the primary error.

- [ ] **Step 2: Test.** Commit.

```bash
git commit -m "feat(reserves): surface primary-fallback-used info warning"
```

---

### Task 1.11: Capture per-adapter `durationMs` in attempt metadata

**Problem:** No observability for adapter latency.

**Files:**
- Modify: `worker/src/cron/sync-live-reserves-core.ts:60-236`

- [ ] **Step 1: Measure** `Date.now()` before `runAdapter` and after, include `durationMs` in `reserve_composition.metadata` and `reserve_sync_attempt_history.metadata`.

- [ ] **Step 2: Test** that successful syncs emit `durationMs`.

- [ ] **Step 3: Commit.**

```bash
git commit -m "feat(reserves): capture adapter durationMs in metadata"
```

---

### Task 1.12: Tighten `breakerScope` schema validation

**Files:**
- Modify: `shared/lib/live-reserve-adapters-schemas.ts:302`

- [ ] **Step 1: Add `.min(1)`** so empty-string breakerScope is rejected at schema time.

- [ ] **Step 2: Commit.**

```bash
git commit -m "fix(reserves): reject empty breakerScope via schema"
```

---

### Task 1.17: Paginate `pruneLiveReserveHistory` to stay inside D1 statement limits

**Problem (N5):** Two unbounded DELETEs run in the hourly cron. 90d × 140 coins × hourly ≈ 302K composition rows + 302K attempt rows. A retention shortening (e.g., 90d → 7d) would schedule one cron to delete ~280K rows, risking D1's 30s per-statement limit.

**Files:**
- Modify: `worker/src/lib/live-reserves-store-write.ts:85-105`
- Modify: `worker/src/lib/__tests__/live-reserves-store.test.ts`

- [ ] **Step 1: Paginate the DELETEs via `LIMIT`** (default 5000 rows per statement; loop until `meta.changes === 0`). Skip pagination on steady-state runs (when rows deleted <= 5000) to keep one-statement happy path.

- [ ] **Step 2: Test** for the "first retention-shortening run" case with 10K+ rows — assert no statement exceeds the 5000-row budget.

- [ ] **Step 3: Commit.**

```bash
git commit -m "fix(reserves): paginate history pruning to stay within D1 statement limits"
```

---

### Task 1.18: 3-tier cache control policy (live / live-stale / fallback)

**Problem (M14):** API cache-control ternary only distinguishes `live` vs everything-else. `live-stale` gets the same 5-minute CDN TTL as bootstrap/unavailable, doubling refresh traffic for the 'slightly stale' case.

**Files:**
- Modify: `worker/src/api/stablecoin-reserves.ts:6-42`
- Modify: `worker/src/api/__tests__/stablecoin-reserves.test.ts`

- [ ] **Step 1: Add `LIVE_STALE_CACHE_CONTROL = "public, s-maxage=1800, max-age=120"` (30 min CDN / 2 min browser).** Route `live-stale` to this intermediate tier; keep `live` at 1h and fallback modes at 5 min.

- [ ] **Step 2: Test all three tiers against their modes.**

- [ ] **Step 3: Commit.**

```bash
git commit -m "fix(reserves): 3-tier cache-control for live/live-stale/fallback modes"
```

---

### Task 1.13: Validate.ts `validateRedemptionTelemetry` collects all fatals

**Problem:** Returns on first fatal; multiple simultaneous violations are hidden.

**Files:**
- Modify: `worker/src/cron/reserve-adapters/validate.ts:93-177`

- [ ] **Step 1: Collect all fatals and degraded into one array, return at end.**

- [ ] **Step 2: Test** multi-violation case.

- [ ] **Step 3: Commit.**

```bash
git commit -m "fix(reserves): validateRedemptionTelemetry collects all fatals"
```

---

### Task 1.15: Eliminate double `recordFailure` on storage-write-timeout

**Problem (M6):** `sync-live-reserves-core.ts:180-216` — when `finalizeReserveSyncSuccess` times out, `recordFailure` writes a `storage-write-timeout` failure row. Then the post-timeout verification branch (`getReserveSyncState` → `didReserveSyncAttemptFinalizeAsSuccess` returns false) calls `recordFailure` a second time with `success-finalize-rejected`. Result: two `reserve_sync_attempt_history` rows for the same `attempt_id` with different `failureCategory`, polluting analytics.

**Files:**
- Modify: `worker/src/cron/sync-live-reserves-core.ts:180-216`
- Modify: `worker/src/cron/__tests__/sync-live-reserves.test.ts`

- [ ] **Step 1: Track a `failureAlreadyRecorded` boolean** across the timeout path. If the first `recordFailure("storage-write-timeout")` landed, short-circuit the post-timeout verification write but still return the correct status.

- [ ] **Step 2: Test** that a D1 write timeout produces exactly one `reserve_sync_attempt_history` row.

- [ ] **Step 3: Commit.**

```bash
git commit -m "fix(reserves): avoid double recordFailure on storage-write-timeout"
```

---

### Task 1.16: Preserve NAV `sourceTimestamp` in superstate-liquidity redemption overlay

**Problem:** `superstate-liquidity.ts:39-54` overwrites the chainlink-nav-derived `metadata.redemption` block with the Superstate liquidity API payload. The NAV `sourceTimestamp` from the underlying oracle is lost inside the new redemption block (`freshnessKind: "same-run-api"` is set but `sourceTimestamp` is dropped). Consumers of `redemption.sourceTimestamp` see null.

**Files:**
- Modify: `worker/src/cron/reserve-adapters/superstate-liquidity.ts:39-54`
- Modify: `worker/src/cron/reserve-adapters/__tests__/superstate-liquidity.test.ts`

- [ ] **Step 1: Pull `navResult.metadata.sourceTimestamp` through to the overlaid redemption block.** Preserve `same-run-api` as the freshness kind (liquidity was fetched this run) but include the timestamp from the oracle for trace-ability.

- [ ] **Step 2: Test + commit.**

```bash
git commit -m "fix(reserves): superstate redemption overlay preserves NAV sourceTimestamp"
```

---

### Task 1.14: Defensive `Math.max(0, ...)` in `normalizeSlices`

**Files:**
- Modify: `worker/src/cron/reserve-adapters/slice-math.ts:61-66`

- [ ] **Step 1: Clamp negative adjustment to 0 to avoid losing the largest slice** if upstream sum is wildly off (defense-in-depth after validation).

- [ ] **Step 2: Test + commit.**

```bash
git commit -m "fix(reserves): clamp negative remainder in normalizeSlices"
```

---

## Phase 2 — Adapter Quality Fixes

### Task 2.1: `erc4626-single-asset` — asset-mismatch → fatal

**Files:**
- Modify: `worker/src/cron/reserve-adapters/erc4626-single-asset.ts:96-105`
- Modify: `worker/src/cron/reserve-adapters/__tests__/erc4626-single-asset.test.ts`

- [ ] **Step 1: Upgrade `asset-mismatch` to a thrown fatal error** (scoring-live adapter can't tolerate silent drift).

- [ ] **Step 2: Add `totalSupply() + convertToAssets` NAV cross-check** emitting `collateralizationRatio`.

- [ ] **Step 3: Test + commit.**

```bash
git commit -m "fix(reserves): erc4626 asset-mismatch is fatal, add NAV cross-check"
```

---

### Task 2.2: `branch-balances` — warn on $1 USD-peg fallback

**Problem:** Depegged wrapper collateral silently valued at par.

**Files:**
- Modify: `worker/src/cron/reserve-adapters/branch-balances.ts:64-140`

- [ ] **Step 1: Replace the unconditional $1 USD-peg fallback** with a DefiLlama live price lookup for the wrapper's underlying coin. DO NOT clamp the resulting price — feed the real market value through so the reserve USD total reflects depegs. If DefiLlama returns a price <$0.50 or >$1.50 for a coin declared USD-pegged, emit a fatal `wrapper-extreme-depeg` warning (the run fails closed rather than publishing implausible slice weights). Moderate deviations (0.80–1.20 outside $1±5%) emit a `wrapper-depeg-detected` degraded warning so scoring is kept out of passthrough until the depeg resolves. No silent clamp.

- [ ] **Step 2: Test** cases at $1.00 (no warning), $0.90 (degraded), $0.70 (degraded+fatal-adjacent), $0.40 (fatal).

- [ ] **Step 3: Commit.**

```bash
git commit -m "fix(reserves): branch-balances uses live wrapper prices with warning"
```

---

### Task 2.3: Consolidate timestamp parsing across adapters

**Problem:** 4+ adapters bypass `parseTimestampLikeToUnixSeconds`:
- `falcon.ts:186` (`payload.snapshot_date > 0`)
- `frax.ts:117` (`new Date(...).getTime() / 1000`)
- `mento.ts:83` (local ms/s branch)
- `usdd-data-platform.ts:179-181` (unconditional `/1000`)

**Files:**
- Modify: each listed adapter

- [ ] **Step 1: Wire each adapter through `parseTimestampLikeToUnixSeconds`.** Add tests covering both seconds and milliseconds payloads.

- [ ] **Step 2: Run `npm test -- worker/src/cron/reserve-adapters`.** Commit.

```bash
git commit -m "refactor(reserves): unify timestamp parsing across adapters"
```

---

### Task 2.4: `asymmetry` — clamp redemption capacity to collateral

**Files:**
- Modify: `worker/src/cron/reserve-adapters/asymmetry.ts:85-105`

- [ ] **Step 1: Clamp `capacityUsd` to `min(total_bold_supply, totalReserveUsd)`** and emit `capacityRatioOfSupply`. If supply > reserve, emit `under-collateralization` warning.

- [ ] **Step 2: Test.** Commit.

```bash
git commit -m "fix(reserves): asymmetry clamps redemption capacity to collateral"
```

---

### Task 2.5: `gho` — residual bucket risk decomposition

**Files:**
- Modify: `worker/src/cron/reserve-adapters/gho.ts:401-428`

- [ ] **Step 1: Decompose residual into named facilitator slices where possible** (Aave V3 → medium, flashminter → high, direct-minter labels → per-facilitator). Use the `getFacilitator()` decoded `label` to bucket.

- [ ] **Step 2: Emit `unknownExposurePct` for remaining residual** so the standard `material-unknown-exposure` validator applies.

- [ ] **Step 3: Cap `FACILITATOR_READ_CONCURRENCY` at `RESERVE_ADAPTER_MAX_PARALLEL_IO`** (the shared cap) to avoid queue explosion.

- [ ] **Step 4: Test + commit.**

```bash
git commit -m "fix(reserves): gho decomposes residual facilitator risk explicitly"
```

---

### Task 2.6: `chainlink-nav` — wrap `getAssetPrice` parse failures as warnings

**Files:**
- Modify: `worker/src/cron/reserve-adapters/chainlink-nav.ts:201-212`

- [ ] **Step 1: Try/catch `parseOndoPriceData` and emit a specific warning** when a wrapper oracle returns malformed data (vs. silently falling back to unverified).

- [ ] **Step 2: Test + commit.**

```bash
git commit -m "fix(reserves): chainlink-nav surfaces wrapper-oracle parse failures"
```

---

### Task 2.7: `liquity-v1` — add ETH/USD valuation + collateralization ratio

**Files:**
- Modify: `worker/src/cron/reserve-adapters/liquity-v1.ts:88-117`

- [ ] **Step 1: Fetch ETH/USD from DefiLlama.** Compute `totalCollateralUsd`, `collateralizationRatio = totalCollateralUsd / totalDebtUsd`, emit in metadata. Warn when ratio < 1.2 (system stress).

- [ ] **Step 2: Test + commit.**

```bash
git commit -m "feat(reserves): liquity-v1 emits collateralization ratio"
```

---

### Task 2.8: `frax.test.ts` — replace live network fetch with fixture

**Files:**
- Modify: `worker/src/cron/reserve-adapters/__tests__/frax.test.ts:85-95`
- Add: `worker/src/cron/reserve-adapters/__tests__/fixtures/frax-balance-sheet.json`

- [ ] **Step 1: Record a live response** from `https://api.frax.finance/v2/frxusd/balance-sheet/latest`, save to fixture, reshape test.

- [ ] **Step 2: Commit.**

```bash
git commit -m "test(reserves): replace live frax fetch with recorded fixture"
```

---

### Task 2.9: Encode USSD → frxUSD wrapper relationship

**Files:**
- Modify: `shared/data/stablecoins/usd-minor.json` (ussd-sonic-labs entry)
- Verify: `shared/lib/stablecoins/schema.ts`

- [ ] **Step 1: Add a `wrapperOf: "frxusd-frax"` metadata field** (or equivalent `depType: "wrapper"` slice) so downstream consumers do not double-count USSD's reserves against frxUSD.

- [ ] **Step 2: Ensure schema allows the field; update docs. Commit.**

```bash
git commit -m "docs(reserves): mark ussd-sonic-labs as frxusd wrapper"
```

---

### Task 2.10: `collateral-positions-api` — explicit unknown slice (not "Other")

**Files:**
- Modify: `worker/src/cron/reserve-adapters/collateral-positions-api.ts:161-210`

- [ ] **Step 1: When a position asset is not in `PROTOCOL_ASSET_CONFIG`, emit it as an "Unknown assets" slice with `risk: "high"` and contribute to `unknownExposurePct`.**

- [ ] **Step 2: Test + commit.**

```bash
git commit -m "fix(reserves): collateral-positions-api surfaces unknown assets as explicit slice"
```

---

### Task 2.11: `jupusd` — propagate snapshots/oracle fetch failures as warnings

**Files:**
- Modify: `worker/src/cron/reserve-adapters/jupusd.ts:174-190`

- [ ] **Step 1: Instead of silent `.catch(() => null)`, emit info warnings when the timestamp/oracle feeds fail so operators see the degradation.**

- [ ] **Step 2: Test + commit.**

```bash
git commit -m "fix(reserves): jupusd surfaces snapshot/oracle fetch failures as warnings"
```

---

### Task 2.12: `ethena` — drop hardcoded URL constant

**Files:**
- Modify: `worker/src/cron/reserve-adapters/ethena.ts:29,190`

- [ ] **Step 1: Drop `ETHENA_COLLATERAL_API_URL` constant** in favor of passing `primaryInput.url` through. Already partially done per April 16 research; verify.

- [ ] **Step 2: Commit.**

```bash
git commit -m "refactor(reserves): ethena drops hardcoded source URL"
```

---

### Task 2.13: `m0` — cash-scale sanity check

**Files:**
- Modify: `worker/src/cron/reserve-adapters/m0.ts:66-110`

- [ ] **Step 1: Add a sanity assertion that `totalCash` is within ~10% of the expected 1000× scale relative to treasury totals.** If the assertion fails, emit a `cash-scale-anomaly` fatal warning so we catch M0 dashboard unit changes before they silently 1000× our reserves.

- [ ] **Step 2: Test + commit.**

```bash
git commit -m "fix(reserves): m0 adds cash-scale anomaly detection"
```

---

### Task 2.14: Externalize hardcoded contract addresses to params

**Files:**
- Modify: `worker/src/cron/reserve-adapters/anzen-usdz.ts:13` (SPCT_POOL_CONTRACT)
- Modify: `worker/src/cron/reserve-adapters/usd1-bundle-oracle.ts` (oracle address)
- Modify: `shared/lib/live-reserve-adapters-schemas.ts` (add params fields)
- Modify: `shared/data/stablecoins/*.json` (add addresses to params)

- [ ] **Step 1: For each adapter, move the hardcoded address into its params schema, then populate from JSON config.** Breaking config change — coordinate a single commit that updates both code and config.

- [ ] **Step 2: Test + commit.**

```bash
git commit -m "refactor(reserves): move hardcoded addresses to adapter params"
```

---

### Task 2.15: Circle — scope "As of" regex to reserve block

**Files:**
- Modify: `worker/src/cron/reserve-adapters/circle-transparency.ts:62-65`

- [ ] **Step 1: Extract the "As of" match within a sub-container** (the reserve canvas block, id=`usdc-in-circulation` / `euro-in-circulation`), not from anywhere on the page.

- [ ] **Step 2: Test with adversarial HTML containing multiple "As of" dates.** Commit.

```bash
git commit -m "fix(reserves): scope Circle 'As of' regex to reserve block"
```

---

### Task 2.16: Duplicate `parseCollateral`/`parseDebt` in sky-makercore

**Files:**
- Modify: `worker/src/cron/reserve-adapters/sky-makercore.ts:55-63`

- [ ] **Step 1: Collapse into one `parseNumericString(raw)` helper; update callers.** Commit.

```bash
git commit -m "refactor(reserves): sky-makercore dedup numeric parser"
```

---

### Task 2.17: Reservoir — broaden immediateRedeemable + fatal on liabilities>assets

**Files:**
- Modify: `worker/src/cron/reserve-adapters/reservoir.ts:108-112,168-178`

- [ ] **Step 1:** `immediateRedeemableUsd` should include all stable buckets (`usdc + usdt + pyusd`), not only USDC.

- [ ] **Step 2:** Emit a fatal warning when `totalLiabilitiesUsd > totalAssetsUsd`.

- [ ] **Step 3: Test + commit.**

```bash
git commit -m "fix(reserves): reservoir broadens redemption bucket, rejects insolvent state"
```

---

### Task 2.18: OpenEden — document ratio heuristic

**Files:**
- Modify: `worker/src/cron/reserve-adapters/openeden.ts:51`

- [ ] **Step 1: Replace the `ratio > 2 ? /100 : ratio` heuristic with an explicit check** against OpenEden's API contract. If OpenEden returns percent-scale, accept it; otherwise reject (fatal).

- [ ] **Step 2: Commit.**

---

### Task 2.19: Redemption double-degrade for unverified-only adapters

**Files:**
- Modify: `worker/src/cron/reserve-adapters/validate.ts:144-149`
- Modify: `worker/src/cron/reserve-adapters/infinifi.ts`, `reservoir.ts`

- [ ] **Step 1: Suppress `redemption-capacity-unverified` warning when the adapter's allowed freshness mode is already `UNVERIFIED_ONLY_FRESHNESS`** to avoid double-degrading what's already policy-degraded.

- [ ] **Step 2: Commit.**

```bash
git commit -m "fix(reserves): avoid double-degrading for unverified-only adapters"
```

---

### Task 2.21: cap-vault USD-peg assumption schema

**Problem:** `cap-vault.ts:103-107,119` treats `asset.totalSupplied` (in asset units) directly as USD. Works today because cUSD's configured assets are USD stablecoins, but silent failure mode if a non-stable asset is added.

**Files:**
- Modify: `shared/lib/live-reserve-adapters-schemas.ts` (`capVaultAssetSchema`)
- Modify: `worker/src/cron/reserve-adapters/cap-vault.ts` (use priceUsd when present)
- Modify: `shared/data/stablecoins/usd-minor.json` (cusd-cap asset entries — add explicit priceUsd or mark each as USD peg)

- [ ] **Step 1: Add to `capVaultAssetSchema`:**

```ts
priceUsd: z.number().positive().optional(),
```

- [ ] **Step 2: At `cap-vault.ts:119`, multiply by `asset.priceUsd ?? 1.0`.** Add a `cap-vault-peg-assumed` info warning when fallback (`?? 1.0`) is used.

- [ ] **Step 3: Migrate cUSD config** to explicitly mark each asset (or leave fallback — emit info warning). Tests. Commit.

```bash
git commit -m "feat(reserves): cap-vault supports per-asset priceUsd with peg-assumed warning"
```

---

### Task 2.22: evm-branch-balances optional debt/supply reconciliation

**Files:**
- Modify: `worker/src/cron/reserve-adapters/branch-balances.ts` (add optional `debtSelector`/`debtDecimals` params)
- Modify: `shared/lib/live-reserve-adapters-schemas.ts` (`evmBranchBalancesParamsSchema` extend)
- Modify: `worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts`

- [ ] **Step 1: Extend schema with optional debt probe (mirroring `liquity-v2-branches`):** the adapter can fetch a system-wide debt/supply total and emit `collateralizationRatio`. Emit degraded warning if ratio <1.0.

- [ ] **Step 2: Test + commit.**

```bash
git commit -m "feat(reserves): evm-branch-balances supports optional debt/supply reconciliation"
```

---

### Task 2.23: curated-validated route status from coin metadata

**Problem:** `curated-validated.ts:32-38` hardcodes `routeStatus: "unknown"`. Coins with a known paused/frozen redemption state (via `coin.redemption` / `coin.flags`) would still show "unknown" on status surfaces.

**Files:**
- Modify: `worker/src/cron/reserve-adapters/curated-validated.ts:32-38`
- Modify: `worker/src/cron/reserve-adapters/__tests__/curated-validated.test.ts`

- [ ] **Step 1: Derive route status from `coin.redemption.mechanism` / `coin.flags.flags`** where present. Fall back to `"unknown"` only when truly unknown.

- [ ] **Step 2: Test + commit.**

```bash
git commit -m "fix(reserves): curated-validated derives route status from coin metadata"
```

---

### Task 2.24: sky-makercore PSM slice multi-stable attribution

**Problem:** `sky-makercore.ts:44` hardcodes `coinId: "usdc-circle"` for the PSM slice, but Sky PSM holds USDC + USDT + USDP in varying proportions.

**Files:**
- Modify: `worker/src/cron/reserve-adapters/sky-makercore.ts:43-51`
- Modify: `worker/src/cron/reserve-adapters/__tests__/sky-makercore.test.ts`

- [ ] **Step 1: If the Sky groups API exposes per-stable breakdown under `stablecoins`**, split into per-stable slices. If not, emit a single PSM slice without `coinId` (attribution unknown) and surface the known multi-stable composition as a short note in the metadata `details`.

- [ ] **Step 2: Test + commit.**

```bash
git commit -m "fix(reserves): sky-makercore PSM slice reflects multi-stable composition"
```

---

### Task 2.25: reservoir rule-order ambiguity

**Problem:** `reservoir.ts:35-84` uses `rules.find()` ordering. Multi-token labels like `"USDC/USDT0"` match the first rule. Currently USDT comes before USDC (intentional prioritization of USDT0 wrapping). This isn't documented; future reorders could silently change attribution.

**Files:**
- Modify: `worker/src/cron/reserve-adapters/reservoir.ts:35-84`

- [ ] **Step 1: Document the ordering intent with a code comment** near the rules array, AND change the rules to use token-exclusive regex patterns to remove ordering dependence.

- [ ] **Step 2: Test with multi-token labels. Commit.**

```bash
git commit -m "refactor(reserves): reservoir rules use exclusive patterns to avoid order dependence"
```

---

### Task 2.26: Unify browser-header factory

**Problem:** Identical browser-style header objects in `ethena.ts:35-39`, `openeden.ts:26-30`, `reservoir.ts:29-33`.

**Files:**
- Add: `worker/src/cron/reserve-adapters/request.ts` — export `buildBrowserHeaders` factory
- Modify: the 3 adapters to import from the factory

- [ ] **Step 1: Add factory `buildBrowserHeaders(originUrl: string)` that returns the canonical Origin/Referer/Accept-Language triple.** Migrate 3 adapters. Commit.

```bash
git commit -m "refactor(reserves): share browser-style header factory across adapters"
```

---

### Task 2.20: Drop legacy `fetchFraxReserves` if unused

**Files:**
- Modify: `worker/src/cron/reserve-adapters/frax.ts`
- Modify: `worker/src/cron/reserve-adapters/index.ts`
- Verify: no `adapter: "frax"` in any config JSON

- [ ] **Step 1: Confirm no live config uses `"frax"` (only `"frax-balance-sheet"`).** Remove `fetchFraxReserves`, the `frax` registry entry, and its schema. Update `LIVE_RESERVE_ADAPTER_KEYS`.

- [ ] **Step 2: Run all tests; commit.**

```bash
git commit -m "refactor(reserves): drop unused legacy frax adapter"
```

---

## Phase 3 — Test Coverage Invariants

### Task 3.1: Classify-failure table test

See Task 1.5 for file; add parameterized test covering all 8 categories + adapter-config + edge cases.

---

### Task 3.2: Per-adapter input-kind parameterized registry test

**Files:**
- Modify: `worker/src/cron/reserve-adapters/__tests__/registry.test.ts`

- [ ] **Step 1: Add a loop over all 43 adapters** that asserts the LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS entry matches the runtime fetchFn's input handling (positive + negative case).

- [ ] **Step 2: Commit.**

---

### Task 3.3: API cache-control — all 5 modes

**Files:**
- Modify: `worker/src/api/__tests__/stablecoin-reserves.test.ts`

- [ ] **Step 1: Add tests for `live-stale`, `curated-fallback`, `template-fallback`, `unavailable` cache-control.**

- [ ] **Step 2: Commit.**

---

### Task 3.4: Overview edge-case tests

**Files:**
- Modify: `worker/src/lib/__tests__/live-reserves-store.test.ts`

- [ ] **Step 1: Add tests for:**
  - `uncertainWrite + no composition` → counted once (Task 1.6).
  - error-status + stale composition → `errorCoins`, not `staleCoins`.
  - corrupt JSON in composition → `corruptCoins`, not `freshCoins`.

- [ ] **Step 2: Commit.**

---

### Task 3.5: Stale-artifact cleanup test

After Task 1.4. Assert a single DELETE runs per cleanup.

---

### Task 3.6: Fencing concurrency test

After Task 1.2. Test that a late attempt cannot overwrite a newer run's composition, and history rows aren't inserted on a failed fenced UPDATE.

---

### Task 3.7: Breaker deferred-outcome mixed scenarios

**Files:**
- Modify: `worker/src/cron/__tests__/sync-live-reserves.test.ts`

- [ ] **Step 1: Add test for first-fail/later-success** (stays false), first-success/later-fail (flips to false), undefined interspersed, pure-success all-success.

- [ ] **Step 2: Commit.**

---

### Task 3.8a: Adapter test-depth triage (thin-test adapters)

**Problem:** 7 adapter tests are <60 lines and lack stale/future/drift/parse-fail scenarios: `fdusd-transparency` (36), `river-protocol-info` (28), `fx` (39), `tether` (41), `solstice-attestation` (40), `asymmetry` (45), `usdgo-transparency` (48).

**Files:** `worker/src/cron/reserve-adapters/__tests__/*.test.ts` (the 7 listed)

- [ ] **Step 1: For each thin test file, add minimum viable coverage:**
  - Happy path (already present)
  - Missing sourceTimestamp fallback
  - Future-timestamp rejected by global guard (integration via `validateAdapterOutput`)
  - Stale-source threshold boundary (if adapter has `maxSourceAgeSec`)
  - Parse-failure path (HTTP 5xx, invalid JSON, layout drift)

- [ ] **Step 2: Run each test suite, commit per file** to keep reviewable-sized commits.

```bash
git commit -m "test(reserves): expand <adapter> coverage for drift/stale/future scenarios"
```

---

### Task 3.8: HTML fixture refresh tooling

**Files:**
- Add: `scripts/refresh-reserve-html-fixtures.ts`

- [ ] **Step 1: Script that curls the 5 tracked HTML sources** (circle, eurc, fdusd, mento, re-metrics, sgforge) and writes fresh fixtures with a generated `<!-- captured-at: ISO8601 -->` header.

- [ ] **Step 2: Add `npm run refresh:html-fixtures` script. Document in docs/testing.md.**

- [ ] **Step 3: Commit.**

---

## Phase 4 — Coverage Expansion (Quick Wins via Existing Adapters)

### Task 4.1: AZND verification cycle

- [ ] **Step 1: Verify next cron cycle self-promotes.** If not, check D1 sync state and circuit state rather than adapter code.
- [ ] **Step 2: No code changes expected.**

---

### Task 4.2: re-metrics `liusd-4w` mapping

**Files:** `worker/src/cron/reserve-adapters/re-metrics.ts`, shared/data

- [ ] **Step 1: Verify mapping is in place** (April 15 audit says landed). If gap remains, extend `SYMBOL_CONFIG` and test.

---

### Task 4.3: YZUSD riskMap extension

**Files:** `shared/data/stablecoins/usd-minor.json` (yzusd-yuzu entry)

- [ ] **Step 1: Extend `riskMap`/`renameMap`** to cover the currently-unmapped 23.30% of buckets reported in the April 15 promotion audit. Use `reserve-research` skill to identify exact bucket names from `https://api.accountable.capital/api/v1/public-protocols/yzusd`.

- [ ] **Step 2: Commit.**

---

### Task 4.4: OpenEden USDO transport resilience

**Files:** `worker/src/cron/reserve-adapters/openeden.ts`

- [ ] **Step 1: Verify browser headers are in place** (per April 16 docs). Add a retry on parse-failure with alternative endpoint if applicable.

---

### Task 4.5: MIM via `abracadabra` adapter — Ethereum-only initial rollout

**Scoping decision:** The current `abracadabra.ts` adapter reads `input.chain` from a single `onchain-evm` primary input (see `abracadabra.ts:112,126`) and applies it to every cauldron. MIM is multi-chain (Ethereum + Arbitrum + BSC + Avalanche). **Two options:**

- **Option A (ship first):** limit MIM config to the Ethereum cauldron set in this task. Most MIM supply + TVL is on Ethereum; covering just Ethereum still delivers useful live data. Cross-chain coverage deferred.
- **Option B (larger):** rework the adapter to support `cauldrons[].chain` (per-cauldron chain). Blocked on downstream questions about how `input.chain` / `rpcMode` interact with per-cauldron overrides.

**This task pursues Option A.** Option B can be a follow-up once Option A is in production for 2+ weeks.

**Files:**
- Modify: `worker/src/cron/reserve-adapters/abracadabra.ts` (add BentoBox.toAmount share→amount conversion)
- Modify: `shared/lib/live-reserve-adapters-schemas.ts` (add `bentoBoxAddress` param; add `cauldron[].version` for V2/V3/V4 selector nuance)
- Modify: `shared/data/stablecoins/usd-minor.json` (mim-abracadabra entry, Ethereum cauldrons only)
- Modify: `worker/src/cron/reserve-adapters/__tests__/abracadabra.test.ts`

- [ ] **Step 1: Implement share-to-amount conversion** via `BentoBox.toAmount(token, share, false)` before pricing. Call sequence: cauldron `totalCollateralShare()` → BentoBox `toAmount(collateralToken, share, false)`. Cache the BentoBox response per `(token, share)` within a run via `ctx.requestCache` to avoid double calls.

- [ ] **Step 2: Enumerate current Ethereum MIM cauldrons** from `dev.abracadabra.money/deployment-addresses/ethereum-mainnet`. Prune archived markets (FTT, SHIB, AGLD) and any cauldron with `totalCollateralShare() == 0`.

- [ ] **Step 3: Add mim-abracadabra config** with `adapter: "abracadabra"`, `inputs.primary.chain = "ethereum"`, `params.bentoBoxAddress = "0xf5bce5077908a1b7370b9ae04adc565ebd643966"`, and the pruned cauldron list.

- [ ] **Step 4: Test. Commit.**

```bash
git commit -m "feat(reserves): configure mim-abracadabra via abracadabra adapter"
```

---

### Task 4.6: LisUSD via `lista` adapter

**Files:**
- Modify: `worker/src/cron/reserve-adapters/lista.ts` (if protocol-specific params needed)
- Modify: `shared/data/stablecoins/usd-minor.json` (lisusd-lista entry)
- Modify: `worker/src/cron/reserve-adapters/__tests__/lista.test.ts`

- [ ] **Step 1: Verify current Lista CDPs + PSM contracts on BSC via BscScan** and enumerate holders/gemjoins. Update config with branch list.

- [ ] **Step 2: Test. Commit.**

```bash
git commit -m "feat(reserves): configure lisusd-lista via lista adapter"
```

---

### Task 4.7: BUIDL via `chainlink-nav` — feasibility check first

**Decision gate:** `buidl-blackrock` lives at `shared/data/stablecoins/usd-major.json:1863` (not usd-minor). Chainlink has NAV feeds for some BlackRock funds; **a BUIDL-specific NAV feed is not confirmed to exist yet.** Before writing any config:

- [ ] **Step 1: Verify a Chainlink BUIDL NAV feed address on Ethereum.** Check `https://docs.chain.link/data-feeds/price-feeds/addresses?network=ethereum` and `https://app.chain.link/` for a BUIDL NAV feed. If none exists, STOP — promote this task to "monitor for announcement" under Phase 7.3 tracker and skip the config change.

- [ ] **Step 2 (only if Step 1 found a feed):** update `shared/data/stablecoins/usd-major.json` (BUIDL entry), swap `adapter: "single-asset"` → `"chainlink-nav"`. Use `oracleMethod: "latestRoundData"`. Set `assetLabel: "U.S. Treasury Bills (BUIDL)"`, `assetRisk: "very-low"`. Update `breakerScope` to preserve/recycle state if the old breaker key differs.

- [ ] **Step 3: After swap, Phase 1.4's cleanup removes** the old `single-asset` breaker state automatically. Verify in staging.

- [ ] **Step 4: Test. Commit.**

```bash
git commit -m "feat(reserves): promote buidl-blackrock to chainlink-nav"
```

**Fallback:** if no Chainlink NAV feed exists, evaluate `erc4626-single-asset` against BUIDL's ERC-4626 vault variant (BUIDL-I), OR leave at `single-asset` weak-live-probe and add to Phase 7.3 tracker.

---

### Task 4.8: PYUSD via `chainlink-por`

**Files:**
- Modify: `shared/data/stablecoins/usd-major.json` (pyusd-paypal entry)

- [ ] **Step 1: Identify PYUSD Chainlink PoR feed address** on Ethereum. Swap `single-asset` for `chainlink-por`.

- [ ] **Step 2: Test. Commit.**

```bash
git commit -m "feat(reserves): promote pyusd-paypal to chainlink-por"
```

---

### Task 4.9: pUSD via `erc4626-single-asset`

**Files:**
- Modify: `shared/data/stablecoins/usd-minor.json` (pusd-plume entry)

- [ ] **Step 1: Identify Nucleus BoringVault address for pUSD.** Verify `asset()` returns the expected underlying. Swap `single-asset` for `erc4626-single-asset`.

- [ ] **Step 2: Test. Commit.**

```bash
git commit -m "feat(reserves): promote pusd-plume to erc4626-single-asset"
```

---

### Task 4.10: USDat via `m0` adapter extension

**Files:**
- Modify: `shared/data/stablecoins/usd-minor.json` (usdat-saturn entry)

- [ ] **Step 1: Add `usdat-saturn` with `adapter: "m0"` config.** Validate it rides M0's source-invariant shared source cache correctly.

- [ ] **Step 2: Commit.**

```bash
git commit -m "feat(reserves): configure usdat-saturn via m0 adapter"
```

---

### Task 4.11: USDtb promotion decision

**Current state:** `usdtb-ethena` is configured with `adapter: "curated-validated"`. Reserves description: "90% BUIDL" (per curated metadata).

**Decision gate (not a code task — answer this first):**
- (a) **Does Ethena's `/api/positions/current/collateral` endpoint surface USDtb-specific positions distinctly from USDe's?** WebFetch `https://app.ethena.fi/api/positions/current/collateral` and inspect whether rows carry a `product` / `collateral_for` / similar discriminator.
- (b) **If yes** (USDtb-scoped rows available): swap `adapter: "curated-validated"` → `adapter: "ethena"` with params filtering to USDtb-scoped rows only. Extend `ethena.ts` to accept a `productFilter` param. Promotes to `independent` / `dynamic-mix`.
- (c) **If no** (endpoint is USDe-only): swap to a BUIDL-scoped adapter instead. Use `chainlink-nav` against the BUIDL NAV oracle (same oracle as Task 4.7 if that lands). This reflects USDtb as a BUIDL-backed pass-through.

**Do NOT ship this task until the decision in (a) is made explicitly.** Acceptance criterion: `usdtb-ethena` response moves from `mode: "live"` `evidenceClass: "static-validated"` → `mode: "live"` `evidenceClass: "independent"` with scoring-eligible freshness.

**Files (for option (b) — revise as needed):**
- Modify: `worker/src/cron/reserve-adapters/ethena.ts` (productFilter param)
- Modify: `shared/lib/live-reserve-adapters-schemas.ts` (ethena params schema)
- Modify: `shared/data/stablecoins/usd-minor.json` (usdtb-ethena entry)

- [ ] **Step 1: WebFetch the Ethena endpoint and inspect payload shape.** Document findings inline.

- [ ] **Step 2: Implement the chosen path.**

- [ ] **Step 3: For USDM (mega)**, verify it's a pass-through on USDtb; if so, encode as `curated-validated` with a USDtb dependency. Otherwise, leave for manual issuer research (do not block usdtb on usdm).

- [ ] **Step 4: Commit.**

```bash
git commit -m "feat(reserves): configure usdtb-ethena via ethena adapter"
```

---

### Task 4.12: FPI via `frax-balance-sheet` extension

**Files:**
- Modify: `shared/data/stablecoins/usd-minor.json` (fpi-frax entry)

- [ ] **Step 1: Verify `facts.frax.finance` exposes FPI balance-sheet compatibly.** Add fpi-frax with `adapter: "frax-balance-sheet"`.

- [ ] **Step 2: Commit.**

---

### Task 4.13: CJPY via `liquity-v1` reuse

**Files:**
- Modify: `shared/data/stablecoins/non-usd.json` (cjpy-yamato entry)

- [ ] **Step 1: Verify Yamato TroveManager ABI matches Liquity-v1.** If matched, swap curated for liquity-v1 with ETH collateral semantics adapted to JPY reporting.

- [ ] **Step 2: Test. Commit.**

---

### Task 4.14a: USDK-orki via `liquity-v2-branches`

- [ ] **Step 1: Verify Orki-Liquity fork ABI compatibility.** Check active branches, debt selector (override if non-default), shutdown selector. Inspect on-chain via BscScan/Etherscan.
- [ ] **Step 2: Write config + test against a recorded RPC fixture. Commit.**

### Task 4.14b: ebUSD-ebisu via `liquity-v2-branches`

- [ ] **Step 1: Verify Ebisu fork ABI.** Same checklist as 4.14a.
- [ ] **Step 2: Config + test + commit.**

### Task 4.15: Breaker cleanup coordination after adapter swaps

**Problem:** Tasks 4.7/4.8/4.9/4.14 swap adapter kinds for existing coins. Old breaker keys (e.g., `live-reserves:single-asset` scoped via `breakerScope: "buidl-blackrock"`) may linger in `reserve_sync_state` and `cache` until the Phase 1.4 cleanup runs.

- [ ] **Step 1: After each adapter swap, deploy Phase 1.4's cleanup** OR manually delete the stale breaker-scope row for that coin (if Phase 1.4 hasn't shipped yet). Document in the PR description.

- [ ] **Step 2: Add a post-swap smoke assertion** that the coin's `reserve_sync_state.adapter_key` reflects the new adapter before relying on the scoring pipeline.

---

## Phase 5 — New HTML/API Adapters

### Task 5.1: `buck-io-transparency` HTML adapter for buck-buck-assets

**Files:**
- Add: `worker/src/cron/reserve-adapters/buck-io-transparency.ts`
- Add: `worker/src/cron/reserve-adapters/__tests__/buck-io-transparency.test.ts`
- Add: `worker/src/cron/reserve-adapters/__tests__/fixtures/buck-io.html`
- Modify: `worker/src/cron/reserve-adapters/index.ts` (register)
- Modify: `shared/types/live-reserves.ts` (add key)
- Modify: `shared/lib/live-reserve-adapters-definitions.ts` (define)
- Modify: `shared/lib/live-reserve-adapters-schemas.ts` (params schema)
- Modify: `shared/data/stablecoins/usd-minor.json` (buck-buck-assets entry)

- [ ] **Step 1: Record live HTML fixture** from buck.io/transparency.
- [ ] **Step 2: Write parser** — extract "Last updated" date (Apr 9, 2026 pattern), USDC %, STRC %. Emit `attestation-mix` semantics with `risk: low` for USDC and `medium` for STRC (BTC-backed preferred equity).
- [ ] **Step 3: Add evidence class `independent`** with validation `VERIFIED_OR_UNVERIFIED_FRESHNESS`.
- [ ] **Step 4: Tests. Commit.**

```bash
git commit -m "feat(reserves): add buck-io-transparency adapter for buck-buck-assets"
```

---

### Task 5.2: `mxnb-transparency` HTML adapter (DEFERRED — low ROI)

**Decision:** MXNB's transparency page only discloses aggregate MXN reserves vs MXNB circulation — no asset breakdown. The resulting adapter would deliver strictly less than a `single-asset` liveness probe plus a curated reserve slice.

- [ ] **Step 1: Leave mxnb-juno at `curated-validated` or `single-asset` with curated reserve metadata.** Add MXNB to Phase 7.3 tracker for re-evaluation if Juno publishes a breakdown.

No code change in this phase.

---

### Task 5.3: `usdh-native-markets` — HTML link scraper (PDF parsing deferred)

**Scoping:** Native Markets publishes PDF attestations monthly. Full PDF table parsing inside a Worker has no precedent in this codebase and would materially increase scope (PDF.js or a Worker-compatible parser + content-extraction complexity). **This task ships only the HTML link scraper:**

- Read `https://usdh.com/reserves`, find the latest month's PDF link and attestation date.
- Emit a single-bucket reserve slice with risk `low` (attestation-backed cash/T-Bills pool).
- Use the PDF's dated month as `sourceTimestamp` via `parseTimestampLikeToUnixSeconds`.
- Classify `evidenceClass: weak-live-probe` until PDF tables are parseable.

**PDF table parsing is out of scope** (add to out-of-scope list). If a future task introduces a Worker-safe PDF parser, promotion to `attestation-mix` with per-asset slices becomes feasible.

**Files & steps:** similar structure to Task 5.1 (Buck Assets). HTML scraper + regex for "As of <Month YYYY>" pattern. Scope: **M** (single-bucket weak-probe, not L).

---

## Phase 6 — Major Rewrites

### Task 6.1: crvUSD full on-chain rewrite

**Scope: L** (~400-600 LOC + Multicall3 helper). See `agents/audits/live-reserve-remaining-candidates-audit-2026-04-15.md` section "crvUSD implementation path" for the concrete design.

**Files:**
- Add: `worker/src/lib/evm-multicall.ts` (new shared helper using Multicall3 `aggregate3`)
- Modify: `worker/src/cron/reserve-adapters/crvusd.ts` (replace `prices.curve.finance` leg with on-chain reads)
- Modify: `shared/lib/live-reserve-adapters-schemas.ts` (add `markets[]` params)
- Modify: `shared/data/stablecoins/usd-major.json` (crvusd-curve params with Controller/LLAMMA/collateral addresses)
- Modify: `worker/src/cron/reserve-adapters/__tests__/crvusd.test.ts`

Subtasks:
- [ ] **6.1a: Build `evm-multicall.ts` helper.** `aggregate3(calls)` batch with result parsing. Canonical address `0xcA11bde05977b3631167028862bE2a173976CA11` on every tracked EVM chain.
- [ ] **6.1b: Curate market registry** (or add discovery from `ControllerFactory.n_collaterals()`). Start with curated: WBTC, WETH, wstETH, sfrxETH, tBTC, LBTC, and Yield Basis markets.
- [ ] **6.1c: Per-market:** read `Controller.amm()`, `Controller.collateral_token()`, `LLAMMA.min_band()/max_band()`, batched `bands_y(i)` over range.
- [ ] **6.1d: Keep Yield Basis leg unchanged** (already on-chain).
- [ ] **6.1e: Methodology decision**: should `bands_x` (crvUSD side of soft-liquidation) count as reserve, be netted against debt, or be ignored? Document choice.
- [ ] **6.1f: Emit `freshnessMode = "not-applicable"`** once all value legs are current-state on-chain. Bump adapter version to 3.
- [ ] **6.1g: Tests** with multicall mocks; add a live-smoke script (not in CI).
- [ ] **6.1h: Bump methodology version.** Update `docs/live-reserves.md` and `/methodology` page.

```bash
git commit -m "feat(reserves): crvusd on-chain LLAMMA collateral reads via Multicall3"
```

---

### Task 6.2: fxUSD on-chain rewrite

**Scope: M.** Replace `api.aladdin.club` with direct `FxPool` contract reads on Ethereum.

Subtasks:
- [ ] **Verify FxPool ABI** exposes `totalBaseToken()` / `totalFToken()` / per-collateral balances.
- [ ] **Move TOKEN_META to params** so new collateral additions don't require adapter changes.
- [ ] **Emit `freshnessMode = "not-applicable"`**; bump adapter version to 2.
- [ ] **Test + commit.**

---

### Task 6.3: ZCHF / DEURO on-chain rewrite

**Scope: L.** Read `MintingHub`/`Position` contracts directly for current balances. Requires multi-chain fanout (Ethereum + Polygon).

Subtasks:
- [ ] **Position enumeration strategy:** since positions are numerous, rely on the existing API for discovery only, then batch on-chain balance reads via Multicall3.
- [ ] **Handle redemptionBridge sub-adapter** (already exists; extend it).
- [ ] **Tests + commit.**

---

### Task 6.4: wsrUSD cross-chain on-chain rewrite

**Scope: L.** Multi-chain balance fanout (each chain × each labeled address from the API). Currently capped at 2 concurrent IO; keep within budget.

---

### Task 6.5: IUSD on-chain

**Scope: M.** Read `infinifi-vault` ERC-4626 `totalAssets()` / `totalSupply()` directly.

---

### Task 6.6: BtcUSD on-chain

**Scope: M.** Read BTCfi handler contracts for `deposit_amount`/`borrow_amount` directly.

---

## Phase 7 — Methodology & Policy

### Task 7.1: GHO — Path A + Path D

**Scope: S (Path A) + M (Path D).**

- [ ] **7.1a: Path A policy change.** Make `aggregated-residual-issuance` warning effect configurable (degraded vs info). Default to `info` with methodology note explaining the trade-off.
- [ ] **7.1b: Document in `/methodology`** that GHO passes scoring with a named residual slice; residual risk is currently `medium` and will tighten as Path D progresses.
- [ ] **7.1c: Path D — remote GSM / GhoReserve reads.** Identify contract addresses for `GhoDirectFacilitator` / `GhoReserve` per Aave RemoteGSM governance proposal. Add per-facilitator classification rules keyed by facilitator address/label.
- [ ] **7.1d: Re-measure residual.** Verify residual% drops below the `maxUnknownExposurePct` threshold.
- [ ] **7.1e: Bump methodology version.**

---

### Task 7.2: USDz / SPCT evidence gate

**Scope: Decision only.**

- [ ] **7.2a: Document the evidence requirement** (`agents/plans/usdz-spct-promotion-gate.md`): promotion requires per-asset SPCT portfolio + attestation timestamp via Chainlink PoR / rwa.xyz / monthly audit PDF. None exists today.
- [ ] **7.2b: Do NOT change `anzen-usdz` classification** from `weak-live-probe` until one of those evidence paths ships.

---

### Task 7.3: Coverage expansion tracker

**Scope:** Track open coverage candidates that are NOT being shipped in Phase 4, PLUS issuer/source items waiting on external action.

- [ ] **7.3a: Create tracker** `agents/tasks/reserve-coverage-tracker.md`. Sections:
  - **Waiting on issuer** (Chainlink PoR for Solstice USX / BUIDL if not found in Task 4.7, Ondo USDY alt oracle, FDUSD fresh attestation, UTY upstream refresh)
  - **Weak-probe ceiling by data availability** (kau-kinesis, pmUSD, CGO, MXNB, USDz/SPCT)
  - **Requires manual issuer research** (Avalon USDA, Astherus USDF, StandX DUSD)
  - **Requires new chain adapter infrastructure** (buck-bucket-protocol on Sui, uusd-youves on Tezos, silk on Secret, hollar on Hydration)
  - **Candidate but deferred** (xaut/paxg via chainlink-por; eurs/xsgd via issuer attestation scrapers; alUSD/msUSD/USDp new adapters)

- [ ] **7.3b: Do NOT include coins in active Phase 4 tasks** (MIM, LisUSD, BUIDL-if-feed-exists, PYUSD, pUSD, USDat, USDtb, FPI, CJPY, USDK, ebUSD) to avoid duplication.

- [ ] **7.3c: Review monthly** for new data sources or issuer announcements.

---

### Task 7.4: Persistent-stale source monitoring (FDUSD / UTY / AZND-style)

**Scope: S.** Data-access: derive from `reserve_sync_state.metadata.failureCategory = 'validation'` plus the existing `last_success_at`. No schema change required.

- [ ] **7.4a: Add a query to `live-reserves-store-overview.ts`** that returns coins where `(now - last_success_at) > 14 * DAY_SECONDS AND last_status IN ('degraded', 'error') AND adapter.evidenceClass === 'independent'`. This detects "configured-live but persistently source-stale" independent coins separately from sync-failing coins.

- [ ] **7.4b: Surface on `/status` as `persistentlyStaleIndependentCoins` metric** alongside `degradedCoins`.

- [ ] **7.4c: Wire to alert** at threshold >3 coins or any single coin stale >21d.

- [ ] **7.4d: Test + commit.**

---

## Verification / Pre-Ship Checklist

For each shipped task:

- [ ] `cd worker && npx tsc --noEmit` clean.
- [ ] Scoped `npm test` clean.
- [ ] For UI-affecting changes: manual browser check on `/api/stablecoin-reserves/:id` for the changed coin.
- [ ] Doc updates committed alongside code.
- [ ] Methodology version bumped when scoring-eligible semantics change.

For the full plan:

- [ ] Pre-push: `npm run test:merge-gate` clean.
- [ ] Production smoke: after each major deploy, curl `/api/stablecoin-reserves/` for affected coins and verify `metadata` / `mode` / `sync` match expectations.
- [ ] `/status` shows no regressions in `corruptCoins` / `writeTimeoutUncertain`.

---

## Dependencies / Ordering Rules

- Phase 0 tasks can all ship in parallel; they're adapter-local or isolated helpers.
- Phase 1.2 (fencing) should land before Phase 1.3 (budget guard) so fencing handles the new "deferred" state cleanly.
- Phase 4.5 (MIM) depends on Phase 0 / Phase 2 abracadabra BentoBox fix.
- Phase 5 new adapters depend on Task 2.3 (unified timestamp parsing).
- Phase 6.1 (crvUSD) depends on the Multicall3 helper landing first, reusable by Phase 6.3.

---

## Out of Scope (Flagged, Not Planned Here)

- crvUSD `bands_x` methodology call — resolved in Task 6.1e.
- Chainlink USDY oracle replacement (requires Ondo issuer cooperation).
- TUSD TRON supply (requires base58-to-hex conversion tooling; see MEMORY).
- Sui / Tezos / Secret / Hydration chain adapter infrastructure.
- Kinesis KAU / pmUSD / Comtech CGO commodity-audit adapter (PDF-only; weak-probe ceiling).
- Avalon USDA / Astherus USDF / StandX DUSD — require manual issuer outreach.
- Solstice USX Chainlink PoR — monitor for issuer announcement (tracker Task 7.3).
- **PDF table parsing inside Workers** — Task 5.3 downgraded to HTML-link scraper; PDF extraction deferred.
- **Abracadabra per-cauldron multi-chain fan-out** — Task 4.5 ships Ethereum-only (Option A). Cross-chain deferred.
- **WBTC vs tBTC risk differentiation** — Task 0.6 does attribution only; risk tier split is a methodology decision.
- **MXNB transparency adapter** — Task 5.2 deferred; insufficient data granularity.
- **M6 finalize-timeout interlock doc comment** — nit; leave the three-way-timing existing commentary as-is.
