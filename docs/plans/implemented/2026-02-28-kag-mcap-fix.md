# KAG Market Cap Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix KAG (Kinesis Silver) market cap reporting by validating CoinGecko's `usd_market_cap` against `circulating_supply × price`, and backfill the corrupt Feb 17–28 supply_history rows.

**Architecture:** Add a `resolveMarketCap` pure helper in `worker/src/lib/` that both the sync cron and the backfill handler import. `fetchSilverTokens` fetches CG `/coins/markets` in parallel with the existing DL price fetch to get `circulating_supply`. `backfillCommodity` fetches `/coins/{geckoId}` for the same field. Both apply the same 20% divergence sanity check.

**Tech Stack:** TypeScript, Cloudflare Workers, CoinGecko API, Vitest

---

### Task 1: Add and test the `resolveMarketCap` helper

**Files:**
- Create: `worker/src/lib/resolve-market-cap.ts`
- Create: `worker/src/lib/__tests__/resolve-market-cap.test.ts`

**Step 1: Write the failing test**

Create `worker/src/lib/__tests__/resolve-market-cap.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveMarketCap } from "../resolve-market-cap";

describe("resolveMarketCap", () => {
  it("returns cgMcap when values agree within threshold", () => {
    // supply=3.7M oz × $97.95/oz = ~$364.4M computed, cgMcap=$364M (within 20%)
    expect(resolveMarketCap(364_000_000, 3_721_963, 97.95)).toBe(364_000_000);
  });

  it("returns computed when cgMcap is frozen/corrupt (KAG scenario)", () => {
    // Real case: supply=3.7M, price=$97.95, cgMcap frozen at $16.4M (~95% divergence)
    const result = resolveMarketCap(16_405_596, 3_721_963, 97.95);
    expect(result).toBeCloseTo(3_721_963 * 97.95, -3);
  });

  it("returns computed when cgMcap is undefined", () => {
    expect(resolveMarketCap(undefined, 3_721_963, 97.95)).toBeCloseTo(
      3_721_963 * 97.95,
      -3
    );
  });

  it("returns cgMcap when circulatingSupply is undefined", () => {
    expect(resolveMarketCap(364_000_000, undefined, 97.95)).toBe(364_000_000);
  });

  it("returns 0 when both cgMcap and circulatingSupply are undefined", () => {
    expect(resolveMarketCap(undefined, undefined, 97.95)).toBe(0);
  });

  it("returns cgMcap when price is zero (cannot compute)", () => {
    expect(resolveMarketCap(364_000_000, 3_721_963, 0)).toBe(364_000_000);
  });

  it("respects the divergenceThreshold parameter", () => {
    // 8% divergence: within 20% default → use cgMcap; above 5% custom → use computed
    const cgMcap = 100_000;
    const supply = 1_000;
    const price = 108; // computed = 108_000, divergence ≈ 8%
    expect(resolveMarketCap(cgMcap, supply, price, 0.20)).toBe(cgMcap);
    expect(resolveMarketCap(cgMcap, supply, price, 0.05)).toBeCloseTo(108_000, -3);
  });

  it("returns 0 when cgMcap is zero and no supply provided", () => {
    expect(resolveMarketCap(0, undefined, 97.95)).toBe(0);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npm test -- --reporter=verbose resolve-market-cap
```

Expected: multiple failures — `resolveMarketCap` not found.

**Step 3: Implement the helper**

Create `worker/src/lib/resolve-market-cap.ts`:

```typescript
/**
 * Returns the best market cap estimate for a commodity token.
 *
 * CoinGecko's usd_market_cap can become frozen/corrupted when the upstream
 * data source (e.g. DefiLlama) stops tracking a token. In that case,
 * circulating_supply × price gives a reliable independent value.
 *
 * Falls back to cgMcap when circulatingSupply is unavailable.
 * Falls back to computed when cgMcap is unavailable but supply+price are present.
 */
export function resolveMarketCap(
  cgMcap: number | undefined,
  circulatingSupply: number | undefined,
  price: number,
  divergenceThreshold = 0.20,
): number {
  const hasSupply = circulatingSupply != null && circulatingSupply > 0;
  const hasPrice = price > 0;

  if (!hasSupply || !hasPrice) {
    return cgMcap ?? 0;
  }

  const computed = circulatingSupply * price;

  if (!cgMcap || cgMcap <= 0) {
    return computed;
  }

  const divergence = Math.abs(cgMcap - computed) / computed;
  if (divergence > divergenceThreshold) {
    return computed;
  }

  return cgMcap;
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- --reporter=verbose resolve-market-cap
```

Expected: all 8 tests pass.

**Step 5: Commit**

```bash
git add worker/src/lib/resolve-market-cap.ts worker/src/lib/__tests__/resolve-market-cap.test.ts
git commit -m "feat(worker): add resolveMarketCap helper with sanity check"
```

---

### Task 2: Fix `fetchSilverTokens` in the sync cron

**Files:**
- Modify: `worker/src/cron/sync-stablecoins.ts` — `fetchSilverTokens` function (lines 27–80)

**Step 1: Add the parallel CG `/coins/markets` fetch and apply `resolveMarketCap`**

At the top of `sync-stablecoins.ts`, add the import:

```typescript
import { resolveMarketCap } from "../lib/resolve-market-cap";
```

Replace the entire `fetchSilverTokens` function body with the following (the function signature stays the same):

```typescript
async function fetchSilverTokens(cgData: CoinGeckoMcapData): Promise<unknown[]> {
  if (SILVER_METAS.length === 0) return [];
  try {
    const coinIds = SILVER_METAS.map((t) => `coingecko:${t.geckoId}`).join(",");
    const cgIds = SILVER_METAS.map((t) => t.geckoId).filter(Boolean).join(",");

    // Fetch DL prices + CG circulating_supply in parallel
    const [priceRes, cgMarketsRes] = await Promise.all([
      fetchWithRetry(`${DEFILLAMA_COINS}/prices/current/${coinIds}`),
      cgIds
        ? fetchWithRetry(
            cgUrl(`/coins/markets?vs_currency=usd&ids=${cgIds}`),
            { headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }) },
          )
        : Promise.resolve(null),
    ]);

    if (!priceRes || !priceRes.ok) {
      console.error(`[silver] Price fetch failed: ${priceRes?.status ?? "no response"}`);
      return [];
    }
    const priceData = (await priceRes.json()) as { coins: Record<string, DefiLlamaCoinPrice> };

    // Parse circulating_supply per geckoId from CG markets response
    const cgSupplyMap = new Map<string, number>();
    if (cgMarketsRes?.ok) {
      const cgMarketsData = (await cgMarketsRes.json()) as {
        id: string;
        circulating_supply?: number;
      }[];
      for (const item of cgMarketsData) {
        if (item.circulating_supply != null && item.circulating_supply > 0) {
          cgSupplyMap.set(item.id, item.circulating_supply);
        }
      }
    } else {
      console.warn(`[silver] CG markets fetch failed (${cgMarketsRes?.status ?? "no response"}), falling back to cgData mcap`);
    }

    // Build mcap map — validate cgData.usd_market_cap against supply×price
    const mcapMap: Record<string, number> = {};
    for (const t of SILVER_METAS) {
      if (!t.geckoId) continue;
      const cgMcap = cgData[t.geckoId]?.usd_market_cap;
      const circulatingSupply = cgSupplyMap.get(t.geckoId);
      const priceInfo = priceData.coins[`coingecko:${t.geckoId}`];
      const price = priceInfo?.price ?? 0;
      const mcap = resolveMarketCap(cgMcap, circulatingSupply, price);
      if (mcap > 0) {
        if (circulatingSupply && cgMcap && Math.abs(cgMcap - mcap) / mcap > 0.01) {
          console.warn(
            `[silver] ${t.symbol}: cgMcap=${cgMcap.toFixed(0)} rejected, using computed=${mcap.toFixed(0)} (supply=${circulatingSupply.toFixed(0)} × price=${price.toFixed(2)})`,
          );
        }
        mcapMap[t.id] = mcap;
      }
    }

    return SILVER_METAS
      .map((meta) => {
        const priceInfo = priceData.coins[`coingecko:${meta.geckoId}`];
        if (!priceInfo) return null;

        const mcap = mcapMap[meta.id] ?? 0;
        if (!mcap) {
          console.warn(`[silver] No mcap for ${meta.symbol}, including with mcap=0`);
        }

        const pKey = pegTypeKey(meta);
        return {
          id: meta.id,
          name: meta.name,
          symbol: meta.symbol,
          geckoId: meta.geckoId,
          pegType: pKey,
          pegMechanism: "rwa-backed",
          price: priceInfo.price,
          priceSource: "defillama",
          circulating: { [pKey]: mcap },
          circulatingPrevDay: null,
          circulatingPrevWeek: null,
          circulatingPrevMonth: null,
          chainCirculating: {},
          chains: ["Ethereum"],
          commodityOunces: meta.commodityOunces,
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  } catch (err) {
    console.error("[silver] fetchSilverTokens failed:", err);
    return [];
  }
}
```

**Step 2: Type-check the worker**

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors. If there are errors, they will be in the new function — fix them before continuing.

**Step 3: Run all tests**

```bash
cd .. && npm test
```

Expected: all tests pass (including the new resolve-market-cap tests).

**Step 4: Commit**

```bash
git add worker/src/cron/sync-stablecoins.ts
git commit -m "fix(worker): validate silver mcap via circulating_supply×price sanity check

Adds parallel CG /coins/markets fetch inside fetchSilverTokens to get
circulating_supply. Uses resolveMarketCap to reject frozen/corrupt
usd_market_cap values (>20% divergence from supply×price).

Fixes KAG showing $16.4M instead of ~$364M after DL dropped the token."
```

---

### Task 3: Fix `backfillCommodity` in the backfill handler

**Files:**
- Modify: `worker/src/api/backfill-supply-history.ts` — `backfillCommodity` function (lines 25–71)

**Step 1: Add the import and extend the function**

At the top of `backfill-supply-history.ts`, add:

```typescript
import { resolveMarketCap } from "../lib/resolve-market-cap";
```

Replace the body of `backfillCommodity` (from `const cgRes = await fetch(...)` through `return { rows: stmts.length }`) with:

```typescript
  // Fetch market_chart (prices + market_caps) and current circulating_supply in parallel
  const [cgRes, coinRes] = await Promise.all([
    fetch(
      cgUrl(`/coins/${config.geckoId}/market_chart?vs_currency=usd&days=max`),
      { headers: cgHeaders({ "User-Agent": USER_AGENT }) },
    ),
    fetch(
      cgUrl(`/coins/${config.geckoId}?market_data=true&localization=false&tickers=false&community_data=false&developer_data=false`),
      { headers: cgHeaders({ "User-Agent": USER_AGENT }) },
    ),
  ]);

  if (cgRes.ok) {
    const cgData = (await cgRes.json()) as {
      market_caps: [number, number][];
      prices?: [number, number][];
    };

    // Extract circulating_supply for sanity check
    let circulatingSupply: number | undefined;
    if (coinRes.ok) {
      const coinData = (await coinRes.json()) as {
        market_data?: { circulating_supply?: number };
      };
      circulatingSupply = coinData.market_data?.circulating_supply ?? undefined;
    }

    const mcaps = cgData.market_caps ?? [];
    if (mcaps.length > 0) {
      const priceMap = new Map<number, number>();
      if (cgData.prices) {
        for (const [ts, p] of cgData.prices) {
          const snapshotDate = Math.floor(ts / 1000 / 86400) * 86400;
          priceMap.set(snapshotDate, p);
        }
      }

      const stmts: D1PreparedStatement[] = [];
      for (const [ts, mcap] of mcaps) {
        if (mcap <= 0) continue;
        const snapshotDate = Math.floor(ts / 1000 / 86400) * 86400;
        const price = priceMap.get(snapshotDate) ?? null;

        // Validate historical mcap via supply×price when price is available
        const resolvedMcap = price != null
          ? resolveMarketCap(mcap, circulatingSupply, price)
          : mcap;

        stmts.push(
          db
            .prepare(
              "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
            )
            .bind(id, snapshotDate, resolvedMcap, price),
        );
      }

      if (stmts.length > 0) {
        await batchExecute(db, stmts);
      }
      return { rows: stmts.length };
    }
  }
```

Everything from `// Fallback: protocol TVL` onwards stays unchanged.

**Step 2: Type-check the worker**

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors.

**Step 3: Run all tests**

```bash
cd .. && npm test
```

Expected: all tests pass.

**Step 4: Commit**

```bash
git add worker/src/api/backfill-supply-history.ts
git commit -m "fix(worker): apply supply×price sanity check in backfillCommodity

Uses resolveMarketCap to reject corrupted historical market_cap values
from CG market_chart, falling back to circulating_supply×price when
they diverge >20%. Enables repair of corrupt KAG supply_history rows."
```

---

### Task 4: Deploy and trigger the backfill

**Step 1: Build the frontend to catch any type errors**

```bash
npm run build
```

Expected: build succeeds with no TypeScript errors.

**Step 2: Deploy the worker**

```bash
cd worker && npx wrangler deploy
```

Expected: deployment succeeds. Note the deployed version URL in the output.

**Step 3: Trigger the KAG supply history backfill**

Replace `<ADMIN_SECRET>` with the value from your `ADMIN_SECRET` env var:

```bash
curl -X POST "https://api.pharos.watch/api/backfill-supply-history?stablecoin=silver-kag" \
  -H "X-Admin-Secret: <ADMIN_SECRET>"
```

Expected response:
```json
{"coinsProcessed": 1, "rowsInserted": <N>}
```
where `N` is the number of historical rows written (likely 900+).

**Step 4: Verify the fix in production**

```bash
curl -s "https://api.pharos.watch/api/stablecoin/silver-kag" | python3 -c "
import json, sys, datetime
data = json.load(sys.stdin)
tokens = data.get('tokens', [])
print('Last 5 data points:')
for t in tokens[-5:]:
    dt = datetime.datetime.fromtimestamp(t['date']).strftime('%Y-%m-%d')
    usd = sum(t.get('totalCirculatingUSD', {}).values())
    print(f'  {dt}: USD={usd:,.0f}')
"
```

Expected: Feb 17–28 values should now show ~$350–370M (not $16.4M).

**Step 5: Wait for next sync cron (~15 min) and verify live mcap**

```bash
curl -s "https://api.pharos.watch/api/stablecoins" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assets = data.get('data', data.get('peggedAssets', []))
kag = next((a for a in assets if a.get('symbol') == 'KAG'), None)
if kag:
    circ = kag.get('circulating', {})
    print('KAG circulating:', circ)
    print('Expected: ~364000000')
"
```

Expected: `circulating.peggedSILVER` ≈ 364,000,000.
