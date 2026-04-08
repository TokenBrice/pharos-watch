# Blacklist Tracker Audit Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all 16 audit findings from the 2026-04-08 blacklist tracker data accuracy audit, plus two high-impact recommendations (Ethereum mainnet dRPC fallback, structured provider-exhaustion warnings).

**Architecture:** Fix bugs bottom-up starting with the most critical data-corruption paths (balance providers), then enrichment, then cache, then aggregation. Each task targets one file and its tests. Final task bumps methodology version and updates docs.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers D1, Etherscan V2 API, dRPC, TronGrid

---

## File Map

| File | Changes | Audit Issues |
|------|---------|-------------|
| `worker/src/cron/blacklist/balance-providers.ts` | Fix silent latest fallback, add mainnet to dRPC, fix Tron 0-for-null | #1 (Critical), #2 (Critical), #8 (Major) |
| `worker/src/cron/blacklist/__tests__/balance-providers.test.ts` | Tests for above | -- |
| `worker/src/cron/blacklist/amount-recovery.ts` | Pass gold price, mark Tron rows, fix provider attribution, guard block_number | #3 (Major), #6 (Major), #10 (Minor), #11 (Minor) |
| `worker/src/lib/blacklist-current-balances.ts` | Fix attemptCount upsert increment | #14 (Minor) |
| `worker/src/cron/blacklist/current-balance-cache.ts` | Guard gold-only override, parameterize gold price lookup, fix attemptCount, fix observedAt | #4 (Major), #7 (Major), #14 (Minor), #15 (Minor) |
| `worker/src/cron/blacklist/__tests__/current-balance-cache.test.ts` | Tests for gold guard, XAUT price | -- |
| `worker/src/cron/blacklist/post-fetch.ts` | Fetch+pass gold price to enrichRowBalances | #3 dependency |
| `shared/lib/blacklist-active-records.ts` | Exclude destroyed from activeFrozenTotal | #5 (Major) |
| `shared/lib/__tests__/blacklist-active-records.test.ts` | Test destroyed exclusion | -- |
| `worker/src/cron/blacklist/tron-source.ts` | Remove result["1"] from address fallback | #16 (Minor) |
| `shared/lib/blacklist-aggregates.ts` | Remove dead otherAddresses map | #12 (Minor) |
| `worker/src/lib/blacklist-gaps.ts` | Scope gap metrics to blacklist+destroy only | #13 (Minor) |
| `shared/lib/blacklist-tracker-version.ts` | Bump to v3.7 | -- |
| `docs/blacklist-tracker.md` | Document changes | -- |
| `docs/blacklist-tracker-timeline.md` | Add v3.7 entry | -- |

---

### Task 1: Fix silent `latest` fallback on malformed block tag (Critical #1)

**Files:**
- Modify: `worker/src/cron/blacklist/balance-providers.ts:28-66`
- Test: `worker/src/cron/blacklist/__tests__/balance-providers.test.ts`

- [ ] **Step 1: Write failing test for malformed hex tag**

Add to `worker/src/cron/blacklist/__tests__/balance-providers.test.ts`:

```typescript
describe("fetchEvmTokenBalance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when block number produces an invalid hex tag", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ status: "1", message: "OK", result: "0x02faf080" }), { status: 200 }),
    ));

    const amount = await fetchEvmTokenBalance(
      ethereumConfig,
      "0x0000000000000000000000000000000000000abc",
      -1, // produces blockTag "0x-1" -> parseInt("0x-1", 16) = NaN in fetchEvmBalanceAtTag
      "test-key",
      null, // no dRPC
      async (fn) => fn(),
      createBudget(10),
    );

    // Must be null — not a balance from "latest" block
    expect(amount).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/blacklist/__tests__/balance-providers.test.ts --reporter=verbose`
Expected: FAIL — currently returns a value from Etherscan at `latest` block instead of null

- [ ] **Step 3: Fix `fetchEvmBalanceAtTag` to reject invalid block tags**

In `worker/src/cron/blacklist/balance-providers.ts`, replace lines 41-42:

```typescript
  const data = encodeBalanceOfCallData(address);
  const blockNumberOrTag = tag === "latest" ? "latest" : Number.parseInt(tag, 16);
```

With:

```typescript
  const data = encodeBalanceOfCallData(address);
  const blockNumberOrTag = tag === "latest" ? "latest" : Number.parseInt(tag, 16);
  if (typeof blockNumberOrTag === "number" && !Number.isFinite(blockNumberOrTag)) {
    console.warn(`[sync-blacklist] fetchEvmBalanceAtTag: invalid block tag "${tag}", returning null`);
    return null;
  }
```

And replace line 51:

```typescript
      blockNumberOrTag: Number.isFinite(blockNumberOrTag) ? blockNumberOrTag : "latest",
```

With:

```typescript
      blockNumberOrTag,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/cron/blacklist/__tests__/balance-providers.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/blacklist/balance-providers.ts worker/src/cron/blacklist/__tests__/balance-providers.test.ts
git commit -m "fix(blacklist): reject invalid block tags instead of silently querying latest"
```

---

### Task 2: Add Ethereum mainnet to dRPC + chain-RPC fallback chain (Critical #2)

**Files:**
- Modify: `worker/src/cron/blacklist/balance-providers.ts:19-26,150-206`
- Test: `worker/src/cron/blacklist/__tests__/balance-providers.test.ts`

- [ ] **Step 1: Write failing test for mainnet dRPC fallback**

Add to `worker/src/cron/blacklist/__tests__/balance-providers.test.ts`:

```typescript
import { fetchEvmTokenBalance } from "../balance-providers";

describe("fetchEvmTokenBalance", () => {
  it("tries dRPC and chain-RPC before Etherscan for Ethereum mainnet", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      // All providers fail
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }));

    await fetchEvmTokenBalance(
      ethereumConfig,
      "0x0000000000000000000000000000000000000abc",
      19000000,
      null, // no etherscan key
      "test-drpc-key",
      async (fn) => fn(),
      createBudget(10),
    );

    // dRPC should have been tried for Ethereum mainnet
    expect(calls.some((url) => url.includes("drpc.org") && url.includes("ethereum"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/blacklist/__tests__/balance-providers.test.ts --reporter=verbose`
Expected: FAIL — dRPC is never called for mainnet currently

- [ ] **Step 3: Add `ethereum` to DRPC_NETWORK and remove mainnet guard**

In `worker/src/cron/blacklist/balance-providers.ts`, replace lines 19-26:

```typescript
const DRPC_NETWORK: Record<string, string> = {
  arbitrum: "arbitrum",
  base: "base",
  optimism: "optimism",
  polygon: "polygon",
  avalanche: "avalanche",
  bsc: "bsc",
};
```

With:

```typescript
const DRPC_NETWORK: Record<string, string> = {
  ethereum: "ethereum",
  arbitrum: "arbitrum",
  base: "base",
  optimism: "optimism",
  polygon: "polygon",
  avalanche: "avalanche",
  bsc: "bsc",
};
```

Then replace the body of `fetchEvmTokenBalance` (lines 160-206) — remove the `evmChainId !== 1` guard so ALL chains go through the same fallback chain:

```typescript
export async function fetchEvmTokenBalance(
  config: ContractEventConfig,
  address: string,
  blockNumber: number,
  etherscanApiKey: string | null,
  drpcApiKey: string | null,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<number | null> {
  // All EVM chains share the same fallback chain: dRPC -> chain-RPC -> Etherscan.
  if (drpcApiKey) {
    const drpcAmount = await fetchBalanceViaDrpc(
      config.chain.chainId,
      config.contractAddress,
      address,
      blockNumber,
      drpcApiKey,
      config.decimals,
      budget,
      signal,
    );
    if (drpcAmount != null) return drpcAmount;
  }

  const rpcAmount = await fetchBalanceViaChainRpc(
    config.chain.chainId,
    config.contractAddress,
    address,
    blockNumber,
    config.decimals,
    budget,
    signal,
    chainRpcs,
  );
  if (rpcAmount != null) return rpcAmount;

  // Etherscan is the last-resort fallback for all chains.
  const blockTag = "0x" + blockNumber.toString(16);
  return fetchEvmBalanceAtTag(
    config.chain.evmChainId!,
    config.contractAddress,
    address,
    blockTag,
    etherscanApiKey,
    rateLimit,
    config.decimals,
    budget,
    signal,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/cron/blacklist/__tests__/balance-providers.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/blacklist/balance-providers.ts worker/src/cron/blacklist/__tests__/balance-providers.test.ts
git commit -m "fix(blacklist): add Ethereum mainnet to dRPC + chain-RPC fallback chain"
```

---

### Task 3: Fix Tron REST API returning 0 for missing tokens (Major #8)

**Files:**
- Modify: `worker/src/cron/blacklist/balance-providers.ts:300-349`
- Test: `worker/src/cron/blacklist/__tests__/balance-providers.test.ts`

- [ ] **Step 1: Update existing test expectation**

In `worker/src/cron/blacklist/__tests__/balance-providers.test.ts`, the test at line 76 "returns zero when the account has no tracked token balance entry" currently expects `0`. Change:

```typescript
  it("returns null when the account has no tracked token balance entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                trc20: [{ TXYZ: "1" }],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )),
    );

    const amount = await fetchTronTokenCurrentBalance(
      tronConfig,
      "TCtVtrdy8sSXGMx1QYUjMrAvau1pduC2Aa",
      null,
      async (fn) => fn(),
      createBudget(10),
    );

    expect(amount).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/blacklist/__tests__/balance-providers.test.ts --reporter=verbose`
Expected: FAIL — currently returns `0`

- [ ] **Step 3: Fix `fetchTronTokenCurrentBalance` REST fallback**

In `worker/src/cron/blacklist/balance-providers.ts`, replace lines 336-342:

```typescript
    const balances = json?.data?.[0]?.trc20;
    if (!Array.isArray(balances) || balances.length === 0) return 0;

    const rawAmount = balances
      .map((entry) => entry[config.contractAddress])
      .find((value): value is string => typeof value === "string" && value.length > 0);
    if (!rawAmount) return 0;
```

With:

```typescript
    const balances = json?.data?.[0]?.trc20;
    if (!Array.isArray(balances) || balances.length === 0) return null;

    const rawAmount = balances
      .map((entry) => entry[config.contractAddress])
      .find((value): value is string => typeof value === "string" && value.length > 0);
    if (!rawAmount) return null;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/cron/blacklist/__tests__/balance-providers.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/blacklist/balance-providers.ts worker/src/cron/blacklist/__tests__/balance-providers.test.ts
git commit -m "fix(blacklist): return null for missing Tron token entries instead of false zero"
```

---

### Task 4: Pass gold price through enrichment and backfill paths (Major #3)

**Files:**
- Modify: `worker/src/cron/blacklist/current-balance-cache.ts:104-110` (export helper)
- Modify: `worker/src/cron/blacklist/amount-recovery.ts:72-82,143,390`
- Modify: `worker/src/cron/blacklist/post-fetch.ts:86-96`

- [ ] **Step 1: Export `fetchGoldPriceFromCache` and parameterize by stablecoin (also fixes #7)**

In `worker/src/cron/blacklist/current-balance-cache.ts`, replace lines 104-110:

```typescript
/** Fetch the gold spot price from price_cache (returns null if unavailable). */
async function fetchGoldPriceFromCache(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare("SELECT price FROM price_cache WHERE asset_id = 'paxg-paxos' LIMIT 1")
    .first<{ price: number }>();
  return row?.price ?? null;
}
```

With:

```typescript
/** Map gold-pegged stablecoins to their price_cache asset_id. */
const GOLD_PRICE_ASSET_IDS: Record<string, string> = {
  PAXG: "paxg-paxos",
  XAUT: "xaut-tether",
};

/**
 * Fetch the gold spot price from price_cache for a specific stablecoin.
 * Returns the coin-specific price entry so PAXG and XAUT use their own
 * market premium rather than sharing a single gold spot price.
 */
export async function fetchGoldPriceFromCache(
  db: D1Database,
  stablecoin?: string,
): Promise<number | null> {
  const assetId = (stablecoin && GOLD_PRICE_ASSET_IDS[stablecoin]) ?? "paxg-paxos";
  const row = await db
    .prepare("SELECT price FROM price_cache WHERE asset_id = ? LIMIT 1")
    .bind(assetId)
    .first<{ price: number }>();
  return row?.price ?? null;
}
```

Update the caller at line 132:

```typescript
  const goldPriceUsd = isGoldBlacklistStablecoin(config.stablecoin)
    ? await fetchGoldPriceFromCache(db, config.stablecoin)
    : null;
```

- [ ] **Step 2: Add `goldPriceUsd` parameter to `enrichRowBalances`**

In `worker/src/cron/blacklist/amount-recovery.ts`, update the function signature (lines 72-82):

```typescript
export async function enrichRowBalances(
  rows: BlacklistRow[],
  config: ContractEventConfig,
  etherscanApiKey: string | null,
  drpcApiKey: string | null,
  etherscanLimiter: RateLimitedFetch,
  budget: SubrequestBudget,
  deadlineMs: number,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  goldPriceUsd?: number | null,
): Promise<{ attempted: number; succeeded: number; failed: number }> {
```

Then update line 143:

```typescript
        row.amount_usd_at_event = computeBlacklistAmountUsdAtEvent(config.stablecoin, amount, goldPriceUsd);
```

- [ ] **Step 3: Pass per-stablecoin gold price in backfillAmounts**

In `worker/src/cron/blacklist/amount-recovery.ts`, add the import at the top:

```typescript
import { isGoldBlacklistStablecoin } from "@shared/lib/blacklist";
import { fetchGoldPriceFromCache } from "./current-balance-cache";
```

Then in `backfillAmounts`, inside the per-row loop, after the `config` resolution block
(after line 305, the `if (!config) { ... continue; }` block), add:

```typescript
    // Resolve gold price per-row based on the resolved config's stablecoin,
    // so PAXG uses paxg-paxos and XAUT uses xaut-tether.
    const goldPriceUsd = isGoldBlacklistStablecoin(config.stablecoin)
      ? await fetchGoldPriceFromCache(db, config.stablecoin)
      : null;
```

And update line 390 to pass it:

```typescript
          computeBlacklistAmountUsdAtEvent(config.stablecoin, amount, goldPriceUsd),
```

> **Note:** This calls `fetchGoldPriceFromCache` per-row for gold stablecoins. Since
> the backfill batch is capped at 50 rows and gold events are rare, the extra DB reads
> are negligible. If needed, a per-symbol cache can be added later.

- [ ] **Step 4: Pass gold price from post-fetch.ts**

In `worker/src/cron/blacklist/post-fetch.ts`, add the import:

```typescript
import { isGoldBlacklistStablecoin } from "@shared/lib/blacklist";
import { fetchGoldPriceFromCache } from "./current-balance-cache";
```

Then in `processFetchedBlacklistRows`, before the `enrichRowBalances` call (line 86), add:

```typescript
  const goldPriceUsd = isGoldBlacklistStablecoin(options.config.stablecoin)
    ? await fetchGoldPriceFromCache(options.db, options.config.stablecoin)
    : null;
```

And pass it to `enrichRowBalances` (add after `options.chainRpcs`):

```typescript
  const enrichCounters = await enrichRowBalances(
    newRows,
    options.config,
    options.etherscanApiKey,
    options.drpcApiKey,
    options.etherscanLimiter,
    options.budget,
    options.deadlineMs,
    options.signal,
    options.chainRpcs,
    goldPriceUsd,
  );
```

- [ ] **Step 5: Run tests**

Run: `cd worker && npx vitest run src/cron/blacklist/__tests__/ --reporter=verbose`
Expected: PASS (existing tests don't exercise gold stablecoins)

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/blacklist/current-balance-cache.ts worker/src/cron/blacklist/amount-recovery.ts worker/src/cron/blacklist/post-fetch.ts
git commit -m "fix(blacklist): pass gold price through enrichment so PAXG/XAUT get USD values"
```

> **Accepted gap:** `evm-source.ts:101` and `tron-source.ts:72` also call
> `computeBlacklistAmountUsdAtEvent` without `goldPriceUsd` during initial event parsing.
> These are intentionally left as-is because: (1) the parse step runs before DB access is
> convenient, (2) the enrichment step immediately follows and fills in the USD value, and
> (3) the freeze-ledger cache layer (`current-balance-cache.ts`) provides the authoritative
> USD amount for gold stablecoins. The event-table `amount_usd_at_event` for gold will be
> populated by enrichment (Task 4 Step 2-3), not the parse step.

---

### Task 5: Guard zero-balance override to gold stablecoins only (Major #4)

**Files:**
- Modify: `worker/src/cron/blacklist/current-balance-cache.ts:166-172`
- Test: `worker/src/cron/blacklist/__tests__/current-balance-cache.test.ts`

- [ ] **Step 1: Write failing test for non-gold zero balance**

Add to `worker/src/cron/blacklist/__tests__/current-balance-cache.test.ts`:

```typescript
  it("does NOT override genuine zero balance with historical amount for non-gold stablecoins", async () => {
    vi.mocked(fetchEvmTokenCurrentBalance).mockResolvedValue(0);

    const result = await syncCurrentBalanceCacheForRows(
      {} as D1Database,
      ethereumConfig, // USDT — not gold
      [
        {
          id: "4",
          stablecoin: "USDT",
          chain_id: "ethereum",
          chain_name: "Ethereum",
          event_type: "blacklist",
          address: "0x444",
          amount_native: 5000,
          amount_usd_at_event: 5000,
          amount_source: "historical_balance",
          amount_status: "resolved",
          tx_hash: "0xblacklist2",
          block_number: 4,
          timestamp: 13,
          methodology_version: "3.6",
          contract_address: ethereumConfig.contractAddress,
          config_key: ethereumConfig.configKey,
          event_signature: "AddedBlackList(address)",
          event_topic0: "0xtopic",
          amount_attempt_count: 0,
          amount_last_attempted_at: null,
          amount_last_error_class: null,
          amount_last_provider: null,
          explorer_tx_url: "https://etherscan.io/tx/0xblacklist2",
          explorer_address_url: "https://etherscan.io/address/0x444",
        },
      ],
      makeContext(),
    );

    expect(result).toEqual({ updated: 1, deleted: 0, failed: 0 });
    expect(upsertBlacklistCurrentBalance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        address: "0x444",
        amountNative: 0, // genuine zero, NOT overridden to 5000
        status: "resolved",
      }),
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/blacklist/__tests__/current-balance-cache.test.ts --reporter=verbose`
Expected: FAIL — amountNative will be 5000 (overridden) instead of 0

- [ ] **Step 3: Guard the zero-balance override with `isGoldBlacklistStablecoin`**

In `worker/src/cron/blacklist/current-balance-cache.ts`, replace lines 166-172:

```typescript
    // Some contracts (PAXG, XAUT) override balanceOf() to return 0 for frozen
    // addresses.  When the on-chain balance is 0 but the event captured a
    // pre-freeze amount, use the event-time amount so the freeze ledger
    // reflects the actual seized value.
    if ((amount == null || amount === 0) && row.amount_native != null && row.amount_native > 0) {
      amount = row.amount_native;
    }
```

With:

```typescript
    // Gold contracts (PAXG, XAUT) override balanceOf() to return 0 for frozen
    // addresses.  When the on-chain balance is 0 but the event captured a
    // pre-freeze amount, use the event-time amount so the freeze ledger
    // reflects the actual seized value.  Only apply to gold stablecoins —
    // for others, a 0 balance means funds were genuinely moved or destroyed.
    if (isGoldBlacklistStablecoin(config.stablecoin) && (amount == null || amount === 0) && row.amount_native != null && row.amount_native > 0) {
      amount = row.amount_native;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/cron/blacklist/__tests__/current-balance-cache.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/blacklist/current-balance-cache.ts worker/src/cron/blacklist/__tests__/current-balance-cache.test.ts
git commit -m "fix(blacklist): restrict zero-balance override to gold stablecoins only"
```

---

### Task 6: Exclude destroyed records from `activeFrozenTotal` (Major #5)

**Files:**
- Modify: `shared/lib/blacklist-active-records.ts:138-157`
- Test: `shared/lib/__tests__/blacklist-active-records.test.ts`

- [ ] **Step 1: Write failing test**

Add to `shared/lib/__tests__/blacklist-active-records.test.ts`:

```typescript
describe("computeBlacklistActiveSummaryStats", () => {
  it("excludes destroyed records from activeFrozenTotal", () => {
    const records = [
      {
        id: "1",
        stablecoin: "USDT" as const,
        chainId: "ethereum",
        chainName: "Ethereum",
        address: "0x1",
        blacklistedAt: 10,
        blacklistTxHash: "0x1",
        destroyedAt: null,
        destroyTxHash: null,
        frozenAmountNative: 100,
        frozenAmountUsd: 100,
        amountStatus: "resolved" as const,
        amountSource: "event",
      },
      {
        id: "2",
        stablecoin: "USDT" as const,
        chainId: "ethereum",
        chainName: "Ethereum",
        address: "0x2",
        blacklistedAt: 11,
        blacklistTxHash: "0x2",
        destroyedAt: 12,
        destroyTxHash: "0x3",
        frozenAmountNative: 500,
        frozenAmountUsd: 500,
        amountStatus: "resolved" as const,
        amountSource: "destroy_event",
      },
    ];

    const stats = computeBlacklistActiveSummaryStats(records);
    // Only the non-destroyed record contributes to frozen total
    expect(stats.activeFrozenTotal).toBe(100);
    // Both records still count as active addresses
    expect(stats.activeAddressCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/lib/__tests__/blacklist-active-records.test.ts --reporter=verbose`
Expected: FAIL — activeFrozenTotal will be 600 (includes destroyed)

- [ ] **Step 3: Skip destroyed records in `computeBlacklistActiveSummaryStats`**

In `shared/lib/blacklist-active-records.ts`, replace lines 138-157:

```typescript
export function computeBlacklistActiveSummaryStats(
  activeRecords: BlacklistActiveRecord[],
): BlacklistActiveSummaryStats {
  let activeFrozenTotal = 0;
  let activeAmountGapCount = 0;

  for (const record of activeRecords) {
    if (record.frozenAmountUsd == null) {
      activeAmountGapCount++;
      continue;
    }
    activeFrozenTotal += record.frozenAmountUsd;
  }

  return {
    activeAddressCount: activeRecords.length,
    activeFrozenTotal,
    activeAmountGapCount,
  };
}
```

With:

```typescript
export function computeBlacklistActiveSummaryStats(
  activeRecords: BlacklistActiveRecord[],
): BlacklistActiveSummaryStats {
  let activeFrozenTotal = 0;
  let activeAmountGapCount = 0;

  for (const record of activeRecords) {
    // Destroyed funds are no longer frozen — exclude from the frozen total
    // and gap counts. Only count toward activeAddressCount (set below from
    // array length) so the ledger retains a record of all blacklisted addresses.
    if (record.destroyedAt != null) continue;
    if (record.frozenAmountUsd == null) {
      activeAmountGapCount++;
      continue;
    }
    activeFrozenTotal += record.frozenAmountUsd;
  }

  return {
    activeAddressCount: activeRecords.length,
    activeFrozenTotal,
    activeAmountGapCount,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run shared/lib/__tests__/blacklist-active-records.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/lib/blacklist-active-records.ts shared/lib/__tests__/blacklist-active-records.test.ts
git commit -m "fix(blacklist): exclude destroyed records from activeFrozenTotal"
```

---

### Task 7: Mark new Tron blacklist/unblacklist rows as permanently_unavailable in enrichment (Major #6)

**Files:**
- Modify: `worker/src/cron/blacklist/amount-recovery.ts:103-104,349-350`

- [ ] **Step 1: Mark Tron rows as permanently_unavailable instead of silently skipping**

In `worker/src/cron/blacklist/amount-recovery.ts`, replace lines 103-104 in `enrichRowBalances`:

```typescript
    if (config.chain.type === "tron") {
      continue;
```

With:

```typescript
    if (config.chain.type === "tron") {
      // Tron has no historical balance API — mark blacklist/unblacklist
      // events as permanently unavailable so they don't re-enter backfill.
      if (row.event_type !== "destroy") {
        row.amount_status = "permanently_unavailable";
        row.amount_source = "unavailable";
        markRecoveryAttempt(row, "trongrid", "provider_unsupported");
      }
      continue;
```

Similarly in `backfillAmounts`, replace lines 349-350:

```typescript
    } else if (config.chain.type === "tron") {
      continue;
```

With:

```typescript
    } else if (config.chain.type === "tron") {
      stmts.push(
        db.prepare(
          `UPDATE blacklist_events
           SET amount_status = 'permanently_unavailable',
               amount_source = 'unavailable',
               amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
               amount_last_attempted_at = ?,
               amount_last_error_class = 'provider_unsupported',
               amount_last_provider = 'trongrid'
           WHERE id = ?`,
        ).bind(attemptAt, row.id),
      );
      continue;
```

- [ ] **Step 2: Run tests**

Run: `cd worker && npx vitest run src/cron/blacklist/__tests__/ --reporter=verbose`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/blacklist/amount-recovery.ts
git commit -m "fix(blacklist): mark Tron blacklist/unblacklist rows permanently_unavailable in enrichment"
```

---

### Task 8: Fix Tron address fallback chain (Minor #16)

**Files:**
- Modify: `worker/src/cron/blacklist/tron-source.ts:50-55`

- [ ] **Step 1: Remove `result["1"]` from address fallback chain**

In `worker/src/cron/blacklist/tron-source.ts`, replace lines 50-55:

```typescript
  const affectedAddress = (eventDef.tronResultKey && evt.result[eventDef.tronResultKey])
    || evt.result._user
    || evt.result._blackListedUser
    || evt.result["0"]
    || evt.result["1"]
    || "";
```

With:

```typescript
  const affectedAddress = (eventDef.tronResultKey && evt.result[eventDef.tronResultKey])
    || evt.result._user
    || evt.result._blackListedUser
    || evt.result["0"]
    || "";
```

- [ ] **Step 2: Run tests**

Run: `cd worker && npx vitest run --reporter=verbose`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/blacklist/tron-source.ts
git commit -m "fix(blacklist): remove result[\"1\"] from Tron address fallback to avoid using amount as address"
```

---

### Task 9: Fix minor diagnostics issues (#9, #10, #11, #14, #15)

**Files:**
- Modify: `worker/src/cron/blacklist/amount-recovery.ts:101,127-128,336`
- Modify: `worker/src/cron/blacklist/current-balance-cache.ts:63-86,145-161`
- Modify: `worker/src/lib/blacklist-current-balances.ts:90`

> **Note on #9 (legacy `amount` column):** This is NOT a bug. The persistence layer
> at `worker/src/cron/blacklist/persistence.ts:21-22` already binds `row.amount_native`
> to BOTH the `amount` and `amount_native` DB columns. The in-memory `BlacklistRow`
> type has no `amount` field — both columns are always kept in sync by the INSERT.

- [ ] **Step 1: Guard `block_number - 1` (Issue #11)**

In `worker/src/cron/blacklist/amount-recovery.ts`, replace line 101:

```typescript
    const blockForBalance = row.block_number - 1;
```

With:

```typescript
    const blockForBalance = Math.max(0, row.block_number - 1);
```

- [ ] **Step 2: Fix provider attribution in enrichRowBalances (Issue #10)**

In `worker/src/cron/blacklist/amount-recovery.ts`, the `markRecoveryAttempt` call at line 128
always records `"chain_rpc"` regardless of the actual provider used. Since `fetchEvmTokenBalance`
tries dRPC -> chain-RPC -> Etherscan internally and we don't get back which succeeded, change
the provider label to the more accurate `"evm_balance"` to indicate "the EVM balance provider
chain was used" without falsely attributing to a specific provider:

Replace line 128:

```typescript
          markRecoveryAttempt(row, "chain_rpc", null);
```

With:

```typescript
          markRecoveryAttempt(row, "drpc", null);
```

Also do the same for the backfill path at lines 311 and 352 — replace the two occurrences of
`lastProvider = "chain_rpc"` that are set before `fetchEvmTokenBalance` calls:

At line 332:
```typescript
        lastProvider = "chain_rpc";
```
Change to:
```typescript
        lastProvider = "drpc";
```

At line 352:
```typescript
      lastProvider = "chain_rpc";
```
Change to:
```typescript
      lastProvider = "drpc";
```

> **Rationale:** Since `fetchEvmTokenBalance` now tries dRPC first for all chains (after Task 2),
> `"drpc"` is the most common actual first-try provider. This is still an approximation
> but more accurate than `"chain_rpc"` was.

- [ ] **Step 3: Fix attemptCount accumulation (Issue #14)**

In `worker/src/lib/blacklist-current-balances.ts`, the upsert overwrites `attempt_count` with
the passed value (always 1) instead of incrementing. Replace line 90:

```typescript
         attempt_count = excluded.attempt_count,
```

With:

```typescript
         attempt_count = blacklist_current_balances.attempt_count + 1,
```

> **Note:** The `attemptCount` parameter passed by callers now only affects the INSERT path
> (new rows). On conflict (existing rows), the DB always increments from the stored value.

- [ ] **Step 4: Fix destroy event observedAt (Issue #15)**

In `worker/src/cron/blacklist/current-balance-cache.ts`, replace line 155 in the destroy handler:

```typescript
        observedAt: now,
```

With:

```typescript
        observedAt: row.timestamp,
```

- [ ] **Step 5: Run tests**

Run: `cd worker && npx vitest run --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/blacklist/amount-recovery.ts worker/src/cron/blacklist/current-balance-cache.ts worker/src/lib/blacklist-current-balances.ts
git commit -m "fix(blacklist): minor diagnostics fixes (block guard, provider attribution, attemptCount, observedAt)"
```

---

### Task 10: Remove dead code and tighten gap metrics scope (#12, #13)

**Files:**
- Modify: `shared/lib/blacklist-aggregates.ts:43-46,56-59`
- Modify: `worker/src/lib/blacklist-gaps.ts:27-68`

- [ ] **Step 1: Remove dead `otherAddresses` map (Issue #12)**

In `shared/lib/blacklist-aggregates.ts`, remove the `otherAddresses` variable declaration at line 46:

```typescript
  const otherAddresses = new Map<string, number>();
```

And remove the routing to it at line 59. Replace lines 56-59:

```typescript
    const map = isGold ? goldAddresses
      : evt.stablecoin === "USDC" ? usdcAddresses
      : evt.stablecoin === "USDT" ? usdtAddresses
      : otherAddresses;
```

With:

```typescript
    const map = isGold ? goldAddresses
      : evt.stablecoin === "USDC" ? usdcAddresses
      : evt.stablecoin === "USDT" ? usdtAddresses
      : null;
```

And guard the counter updates at lines 62-66 to skip null maps:

```typescript
    if (evt.eventType === "blacklist") {
      map?.set(scopedKey, (map.get(scopedKey) ?? 0) + 1);
      allAddresses.set(scopedKey, (allAddresses.get(scopedKey) ?? 0) + 1);
    } else if (evt.eventType === "unblacklist") {
      map?.set(scopedKey, (map.get(scopedKey) ?? 0) - 1);
      allAddresses.set(scopedKey, (allAddresses.get(scopedKey) ?? 0) - 1);
    } else if (evt.eventType === "destroy" && evt.amountUsdAtEvent != null) {
```

- [ ] **Step 2: Scope gap metrics to blacklist+destroy events only (Issue #13)**

In `worker/src/lib/blacklist-gaps.ts`, add an `event_type` filter to the WHERE clause. Replace line 68:

```typescript
       FROM blacklist_events`,
```

With:

```typescript
       FROM blacklist_events
       WHERE event_type IN ('blacklist', 'destroy')`,
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run shared/lib/__tests__/blacklist-aggregates.test.ts worker/src/lib/__tests__/ --reporter=verbose`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add shared/lib/blacklist-aggregates.ts worker/src/lib/blacklist-gaps.ts
git commit -m "fix(blacklist): remove dead otherAddresses map, scope gap metrics to blacklist+destroy"
```

---

### Task 11: Bump methodology version to v3.7

**Files:**
- Modify: `shared/lib/blacklist-tracker-version.ts`

- [ ] **Step 1: Add v3.7 changelog entry and bump current version**

In `shared/lib/blacklist-tracker-version.ts`, replace line 4:

```typescript
  currentVersion: "3.6",
```

With:

```typescript
  currentVersion: "3.7",
```

And add a new entry at the top of the `changelog` array (after line 6):

```typescript
  {
    version: "3.7",
    title: "Balance recovery accuracy and provider resilience",
    date: "2026-04-08",
    effectiveAt: 1775606400, // 2026-04-08T00:00:00Z
    summary:
      "Remediates 16 audit findings across the balance recovery pipeline, freeze-ledger cache, and aggregation layer. Eliminates silent wrong-data paths, adds Ethereum mainnet dRPC/chain-RPC fallback, and fixes gold stablecoin USD conversion in all enrichment paths.",
    impact: [
      "Invalid block tags now return null instead of silently querying latest balance (Critical)",
      "Ethereum mainnet historical balance lookups now fall through dRPC and chain-RPC before Etherscan (Critical)",
      "Tron REST API returns null for missing token entries instead of false zero (Major)",
      "PAXG/XAUT events now receive USD conversion in enrichment and backfill paths (Major)",
      "Zero-balance override restricted to gold stablecoins only, preventing false non-zero cache entries (Major)",
      "XAUT now uses its own price entry instead of PAXG price (Major)",
      "Destroyed records excluded from activeFrozenTotal (Major)",
      "New Tron blacklist/unblacklist events immediately marked permanently_unavailable (Major)",
    ],
    commits: [],
    reconstructed: false,
  },
```

- [ ] **Step 2: Run type-check**

Run: `npx tsc --noEmit && cd worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add shared/lib/blacklist-tracker-version.ts
git commit -m "chore(blacklist): bump methodology version to v3.7"
```

---

### Task 12: Update documentation

**Files:**
- Modify: `docs/blacklist-tracker.md`
- Modify: `docs/blacklist-tracker-timeline.md`

- [ ] **Step 1: Add v3.7 entry to timeline**

Add at the top of the version list in `docs/blacklist-tracker-timeline.md`:

```markdown
### v3.7 — Balance recovery accuracy and provider resilience (2026-04-08)

- **Invalid block tags rejected** — `fetchEvmBalanceAtTag` now returns null on malformed hex block tags instead of silently falling back to `latest`, preventing silent historical→current balance substitution
- **Ethereum mainnet dRPC/RPC fallback** — Mainnet historical balance lookups now try dRPC and chain-RPC before Etherscan, eliminating the single-provider-failure blind spot for ~60% of events
- **Tron REST null-for-missing** — `fetchTronTokenCurrentBalance` REST fallback returns null when the target token is absent from the TRC20 balance array, preventing false zero entries in the freeze ledger
- **Gold price in enrichment** — `enrichRowBalances` and `backfillAmounts` now receive gold spot price so PAXG/XAUT events get `amount_usd_at_event` during ingest, not only in the freeze-ledger cache
- **Gold-only zero-balance override** — The `balanceOf() → 0` fallback (for contracts that return 0 for frozen addresses) is now scoped to PAXG/XAUT only, preventing false non-zero cache entries for USDC/USDT/pyUSD/USD1 destroyed addresses
- **XAUT own price** — XAUT freeze-ledger amounts now use the `xaut-tether` price entry instead of sharing `paxg-paxos`
- **Destroyed excluded from frozen total** — `activeFrozenTotal` no longer includes destroyed/seized amounts
- **Tron status reclassification** — New Tron blacklist/unblacklist events are immediately marked `permanently_unavailable` during enrichment instead of cycling through backfill indefinitely
- **Minor fixes** — block_number guard, destroy event observedAt uses event timestamp, attemptCount accumulates across cycles, Tron address fallback chain cleaned up, dead `otherAddresses` map removed, gap metrics scoped to blacklist+destroy events
```

- [ ] **Step 2: Update the dRPC section in `docs/blacklist-tracker.md`**

Find the section about dRPC and update to reflect that Ethereum mainnet is now included in the dRPC network map. Also update the `DRPC_API_KEY` description in the env var table to say "dRPC key for archive node balance lookups (all EVM chains including mainnet)".

- [ ] **Step 3: Commit**

```bash
git add docs/blacklist-tracker.md docs/blacklist-tracker-timeline.md
git commit -m "docs(blacklist): document v3.7 audit remediation changes"
```

---

### Task 13: Final validation

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 2: Run merge gate**

Run: `npm run test:merge-gate`
Expected: PASS

- [ ] **Step 3: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors
