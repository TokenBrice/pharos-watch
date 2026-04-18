# Funding Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a stealth-released `/funding` page that renders live multi-chain donations vs costs (Ethereum/Base/OP/Arbitrum/Polygon via Alchemy + Gnosis via Gnosisscan), an ENS-resolved donor wall, and non-pushy support CTAs — backed by a daily worker cron and a single API endpoint.

**Architecture:** New worker subsystem under `worker/src/lib/funding/` and `worker/src/cron/sync-funding-donations.ts`, four/five new D1 tables, three manual JSON files in `shared/data/funding/`, one cached `/api/funding-summary` endpoint, and a small set of frontend components in `src/components/funding/` rendered by `src/app/funding/page.tsx` via a TanStack Query hook.

**Tech Stack:** Cloudflare Worker (TypeScript) + D1 + cron triggers; Next.js 16 static export with TanStack Query and Recharts on the frontend; Alchemy `alchemy_getAssetTransfers` for EVM chains; Gnosisscan REST for Gnosis; CoinGecko historical pricing; ENS L1 forward-verified resolution; vitest for tests.

**Spec:** `agents/plans/2026-04-18-funding-page-design.md`

---

## Pre-flight

Before starting, confirm assumptions hold:

- [ ] **Verify next migration number is 0106**

```bash
ls worker/migrations/ | grep -E '^0[0-9]+_' | tail -3
```

Expected: `0103_blacklist_backfill_indexes.sql`, `0104_blacklist_mirror_zero_permanently_unavailable.sql`, `0105_depeg_event_provenance.sql`. If anything ≥0106 exists, renumber the new migration accordingly throughout the plan.

- [ ] **Confirm Alchemy API key is in `worker/.dev.vars` for local dev**

```bash
grep -c '^ALCHEMY_API_KEY=' worker/.dev.vars 2>/dev/null
```

Expected: `1`. If 0, add it before running the cron locally.

- [ ] **Confirm Gnosisscan free key is available** (sign up at https://gnosisscan.io/myapikey if needed; Wrangler vars hold non-sensitive `GNOSISSCAN_API_KEY` per CLAUDE.md memory)

```bash
grep -c '^GNOSISSCAN_API_KEY=' worker/.dev.vars 2>/dev/null
```

Expected: `1`.

- [ ] **Confirm CoinGecko Analyst key is in `worker/.dev.vars`**

```bash
grep -c '^COINGECKO_API_KEY=' worker/.dev.vars 2>/dev/null
```

Expected: `1`.

---

## Task 1: D1 migration — funding tables

**Files:**
- Create: `worker/migrations/0106_funding_tables.sql`
- Modify: `worker/migrations/MANIFEST.md`

- [ ] **Step 1: Write the migration**

Create `worker/migrations/0106_funding_tables.sql`:

```sql
-- Funding subsystem (donations vs costs page).
-- All five tables are additive; no existing data is touched.

CREATE TABLE IF NOT EXISTS funding_donations (
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_timestamp INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  asset_symbol TEXT NOT NULL,
  asset_address TEXT,
  amount_raw TEXT NOT NULL,
  amount_decimal REAL NOT NULL,
  usd_at_receipt REAL NOT NULL,
  price_source TEXT NOT NULL,
  is_spam INTEGER NOT NULL DEFAULT 0,
  is_refund INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  inserted_at INTEGER NOT NULL,
  PRIMARY KEY (chain, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS funding_donations_block_ts ON funding_donations(block_timestamp);
CREATE INDEX IF NOT EXISTS funding_donations_from ON funding_donations(from_address);

CREATE TABLE IF NOT EXISTS funding_monthly (
  month TEXT PRIMARY KEY,
  donations_usd REAL NOT NULL,
  costs_usd REAL NOT NULL,
  donor_count INTEGER NOT NULL,
  finalized INTEGER NOT NULL DEFAULT 0,
  computed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS funding_ens_cache (
  address TEXT PRIMARY KEY,
  ens_name TEXT,
  forward_verified INTEGER NOT NULL,
  resolved_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS funding_chain_sync (
  chain TEXT PRIMARY KEY,
  last_block_seen INTEGER NOT NULL,
  last_success_at INTEGER NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS funding_price_cache (
  asset_key TEXT NOT NULL,
  price_date TEXT NOT NULL,
  usd_price REAL NOT NULL,
  source TEXT NOT NULL,
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (asset_key, price_date)
);
```

- [ ] **Step 2: Append to MANIFEST**

Open `worker/migrations/MANIFEST.md` and add a new line at the bottom of the manifest table matching the existing format. Read the file first to copy the exact column structure of the previous row (0105) so the new row aligns. The description should be: `Funding subsystem tables (donations, monthly, ens_cache, chain_sync, price_cache).`

- [ ] **Step 3: Apply migration locally**

```bash
cd worker && npx wrangler d1 execute stablecoin-db --local --file=migrations/0106_funding_tables.sql
```

Expected: 5 statements executed successfully.

- [ ] **Step 4: Verify schema**

```bash
cd worker && npx wrangler d1 execute stablecoin-db --local --command="SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'funding_%' ORDER BY name;"
```

Expected: `funding_chain_sync`, `funding_donations`, `funding_ens_cache`, `funding_monthly`, `funding_price_cache`.

- [ ] **Step 5: Commit**

```bash
git add worker/migrations/0106_funding_tables.sql worker/migrations/MANIFEST.md
git commit -m "migration(funding): add funding_* tables for /funding page"
```

---

## Task 2: Shared types + data files

**Files:**
- Create: `shared/lib/funding/types.ts`
- Create: `shared/lib/funding/cost-helpers.ts`
- Create: `shared/data/funding/cost-line-items.json`
- Create: `shared/data/funding/donor-labels.json`
- Create: `shared/data/funding/spam-denylist.json`
- Test: `shared/lib/funding/__tests__/cost-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `shared/lib/funding/__tests__/cost-helpers.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { computeMonthlyTotal, groupByCategory } from "../cost-helpers";
import type { CostLineItem } from "../types";

const ITEMS: CostLineItem[] = [
  { label: "Ike", category: "team", usd_per_month: 1500 },
  { label: "Brice", category: "team", usd_per_month: 0, note: "Volunteer" },
  { label: "CoinGecko API", category: "infra", usd_per_month: 129 },
  { label: "Alchemy", category: "infra", usd_per_month: 40 },
  { label: "Cloudflare Workers", category: "infra", usd_per_month: 5 },
  { label: "Domain", category: "infra", usd_per_month: 2.85 },
];

describe("cost-helpers", () => {
  it("sums monthly total to two decimal places", () => {
    expect(computeMonthlyTotal(ITEMS)).toBeCloseTo(1676.85, 2);
  });

  it("groups items by category in declared order", () => {
    const groups = groupByCategory(ITEMS);
    expect(groups).toEqual([
      { category: "team", items: [ITEMS[0], ITEMS[1]], subtotal: 1500 },
      { category: "infra", items: [ITEMS[2], ITEMS[3], ITEMS[4], ITEMS[5]], subtotal: 176.85 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run shared/lib/funding/__tests__/cost-helpers.test.ts
```

Expected: FAIL — module `../cost-helpers` cannot be resolved.

- [ ] **Step 3: Create types**

Create `shared/lib/funding/types.ts`:

```typescript
export type FundingChain =
  | "ethereum"
  | "base"
  | "optimism"
  | "arbitrum"
  | "polygon"
  | "gnosis";

export const FUNDING_CHAINS: readonly FundingChain[] = [
  "ethereum",
  "base",
  "optimism",
  "arbitrum",
  "polygon",
  "gnosis",
] as const;

export type CostCategory = "team" | "infra";

export interface CostLineItem {
  label: string;
  category: CostCategory;
  usd_per_month: number;
  note?: string;
}

export interface DonorLabel {
  address: string; // lowercased
  label: string;
}

export type SpamDenylist = Record<FundingChain, string[]>;

export interface FundingMonthlyRow {
  month: string; // YYYY-MM (UTC)
  donations_usd: number;
  costs_usd: number;
  donor_count: number;
  finalized: 0 | 1;
}

export interface FundingDonationRow {
  chain: FundingChain;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_timestamp: number;
  from_address: string;
  asset_symbol: string;
  asset_address: string | null;
  amount_decimal: number;
  usd_at_receipt: number;
  price_source: string;
  is_spam: 0 | 1;
  is_refund: 0 | 1;
}

export interface ChainFreshnessEntry {
  chain: FundingChain;
  last_success_at: number;
  last_attempt_at: number;
  last_error: string | null;
}

export interface FundingKpis {
  current_month_coverage_pct: number; // 0–∞
  current_month_donations_usd: number;
  current_month_target_usd: number;
  trailing_3mo_avg_coverage_pct: number;
  total_raised_lifetime_usd: number;
  distinct_donors_lifetime: number;
}

export interface FundingMonthlyPoint {
  month: string;
  donations_usd: number;
  costs_usd: number;
  donor_count: number;
}

export interface FundingDonorWallEntry {
  address: string;
  display: string; // ENS, custom label, or truncated address
  total_usd: number;
  most_recent_at: number;
  etherscan_url: string;
}

export interface FundingSummaryResponse {
  kpis: FundingKpis;
  monthly_series: FundingMonthlyPoint[];
  line_items: CostLineItem[];
  recent_donors: FundingDonorWallEntry[];
  chain_freshness: ChainFreshnessEntry[];
  last_synced_at: number;
}
```

- [ ] **Step 4: Create cost-helpers**

Create `shared/lib/funding/cost-helpers.ts`:

```typescript
import type { CostCategory, CostLineItem } from "./types";

const CATEGORY_ORDER: readonly CostCategory[] = ["team", "infra"];

export function computeMonthlyTotal(items: readonly CostLineItem[]): number {
  return items.reduce((sum, item) => sum + item.usd_per_month, 0);
}

export interface CostCategoryGroup {
  category: CostCategory;
  items: CostLineItem[];
  subtotal: number;
}

export function groupByCategory(items: readonly CostLineItem[]): CostCategoryGroup[] {
  return CATEGORY_ORDER.flatMap((category) => {
    const subset = items.filter((item) => item.category === category);
    if (subset.length === 0) return [];
    const subtotal = subset.reduce((sum, item) => sum + item.usd_per_month, 0);
    return [{ category, items: subset, subtotal }];
  });
}
```

- [ ] **Step 5: Create data files**

Create `shared/data/funding/cost-line-items.json`:

```json
[
  { "label": "Ike", "category": "team", "usd_per_month": 1500, "note": "Growth & comms" },
  { "label": "Brice", "category": "team", "usd_per_month": 0, "note": "Volunteer (uncompensated until Pharos is sustainable)" },
  { "label": "CoinGecko API", "category": "infra", "usd_per_month": 129, "note": "Analyst tier" },
  { "label": "Alchemy", "category": "infra", "usd_per_month": 40, "note": "Pay-as-you-go, ~$40 typical" },
  { "label": "Cloudflare Workers", "category": "infra", "usd_per_month": 5 },
  { "label": "Domain registration", "category": "infra", "usd_per_month": 2.85 }
]
```

Create `shared/data/funding/donor-labels.json`:

```json
[]
```

(Brice's EOA + Giveth pool are added at implementation review time — see Task 12.)

Create `shared/data/funding/spam-denylist.json`:

```json
{
  "ethereum": [],
  "base": [],
  "optimism": [],
  "arbitrum": [],
  "polygon": [],
  "gnosis": []
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
npx vitest run shared/lib/funding/__tests__/cost-helpers.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git add shared/lib/funding/ shared/data/funding/
git commit -m "feat(funding): shared types, cost helpers, manual data files"
```

---

## Task 3: Worker funding config + spam filter

**Files:**
- Create: `worker/src/lib/funding/config.ts`
- Create: `worker/src/lib/funding/spam-filter.ts`
- Test: `worker/src/lib/funding/__tests__/spam-filter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/src/lib/funding/__tests__/spam-filter.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { isSpamAsset } from "../spam-filter";

const DENYLIST = {
  ethereum: ["0xspam1", "0xspam2"],
  base: [],
  optimism: [],
  arbitrum: [],
  polygon: [],
  gnosis: [],
} as const;

describe("isSpamAsset", () => {
  it("flags listed contract addresses (case-insensitive)", () => {
    expect(isSpamAsset(DENYLIST, "ethereum", "0xSpam1")).toBe(true);
    expect(isSpamAsset(DENYLIST, "ethereum", "0XSPAM2")).toBe(true);
  });

  it("does not flag unknown addresses", () => {
    expect(isSpamAsset(DENYLIST, "ethereum", "0xclean")).toBe(false);
  });

  it("does not flag native asset (null address) regardless of chain", () => {
    expect(isSpamAsset(DENYLIST, "ethereum", null)).toBe(false);
    expect(isSpamAsset(DENYLIST, "gnosis", null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npx vitest run src/lib/funding/__tests__/spam-filter.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement config**

Create `worker/src/lib/funding/config.ts`:

```typescript
import type { FundingChain } from "@shared/lib/funding/types";
import { FUNDING_CHAINS } from "@shared/lib/funding/types";

export const PHAROS_FUNDING_WALLET = "0x5d698362edb8aea1c2b2483096bdee3265d860db";
export const PHAROS_FUNDING_ENS = "pharos-watch.eth";
export const FUNDING_ENS_TTL_SECONDS = 30 * 24 * 60 * 60;
export const FUNDING_CHAIN_FRESHNESS_WARN_SECONDS = 36 * 60 * 60;

export const ETHERSCAN_TX_URL_BY_CHAIN: Record<FundingChain, (hash: string) => string> = {
  ethereum: (h) => `https://etherscan.io/tx/${h}`,
  base: (h) => `https://basescan.org/tx/${h}`,
  optimism: (h) => `https://optimistic.etherscan.io/tx/${h}`,
  arbitrum: (h) => `https://arbiscan.io/tx/${h}`,
  polygon: (h) => `https://polygonscan.com/tx/${h}`,
  gnosis: (h) => `https://gnosisscan.io/tx/${h}`,
};

export const ETHERSCAN_ADDRESS_URL_BY_CHAIN: Record<FundingChain, (addr: string) => string> = {
  ethereum: (a) => `https://etherscan.io/address/${a}`,
  base: (a) => `https://basescan.org/address/${a}`,
  optimism: (a) => `https://optimistic.etherscan.io/address/${a}`,
  arbitrum: (a) => `https://arbiscan.io/address/${a}`,
  polygon: (a) => `https://polygonscan.com/address/${a}`,
  gnosis: (a) => `https://gnosisscan.io/address/${a}`,
};

export { FUNDING_CHAINS };
```

- [ ] **Step 4: Implement spam filter**

Create `worker/src/lib/funding/spam-filter.ts`:

```typescript
import type { FundingChain, SpamDenylist } from "@shared/lib/funding/types";

export function isSpamAsset(
  denylist: SpamDenylist,
  chain: FundingChain,
  assetAddress: string | null,
): boolean {
  if (assetAddress == null) return false;
  const normalized = assetAddress.toLowerCase();
  const chainEntries = denylist[chain];
  if (!chainEntries) return false;
  return chainEntries.some((entry) => entry.toLowerCase() === normalized);
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd worker && npx vitest run src/lib/funding/__tests__/spam-filter.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/funding/config.ts worker/src/lib/funding/spam-filter.ts worker/src/lib/funding/__tests__/spam-filter.test.ts
git commit -m "feat(funding): worker config constants and spam-token filter"
```

---

## Task 4: CoinGecko historical pricing with cache

**Files:**
- Create: `worker/src/lib/funding/coingecko-historical.ts`
- Test: `worker/src/lib/funding/__tests__/coingecko-historical.test.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/src/lib/funding/__tests__/coingecko-historical.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { fetchUsdPriceHistorical, makeAssetKey, formatPriceDate } from "../coingecko-historical";

function makeFakeDb() {
  const reads: Array<{ asset_key: string; price_date: string }> = [];
  const writes: Array<unknown[]> = [];
  return {
    reads,
    writes,
    prepare(_sql: string) {
      return {
        bind: (...args: unknown[]) => ({
          first: async () => {
            // First arg is asset_key, second is price_date.
            reads.push({ asset_key: String(args[0]), price_date: String(args[1]) });
            return null;
          },
          run: async () => {
            writes.push(args);
            return { success: true } as const;
          },
        }),
      };
    },
  };
}

describe("coingecko-historical", () => {
  it("makeAssetKey lowercases address and prefixes chain", () => {
    expect(makeAssetKey("ethereum", "0xABC")).toBe("ethereum:0xabc");
    expect(makeAssetKey("ethereum", null)).toBe("ethereum:native");
  });

  it("formatPriceDate emits DD-MM-YYYY UTC", () => {
    const ts = Date.UTC(2026, 3, 18) / 1000; // 2026-04-18
    expect(formatPriceDate(ts)).toBe("18-04-2026");
  });

  it("hits cache when present and skips fetch", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ usd_price: 3000, source: "coingecko-historical" }),
          run: async () => ({ success: true }),
        }),
      }),
    } as unknown as D1Database;
    const fetchMock = vi.fn();
    const result = await fetchUsdPriceHistorical(db, "ethereum:native", "18-04-2026", "ethereum", fetchMock as never, "key");
    expect(result.usdPrice).toBe(3000);
    expect(result.source).toBe("coingecko-historical");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on cache miss fetches CoinGecko and caches result", async () => {
    const fakeDb = makeFakeDb();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ market_data: { current_price: { usd: 3500 } } }),
      text: async () => "",
    })) as unknown as typeof fetch;

    const result = await fetchUsdPriceHistorical(fakeDb as unknown as D1Database, "ethereum:native", "18-04-2026", "ethereum", fetchMock, "key");
    expect(result.usdPrice).toBe(3500);
    expect(result.source).toBe("coingecko-historical");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fakeDb.writes.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npx vitest run src/lib/funding/__tests__/coingecko-historical.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `worker/src/lib/funding/coingecko-historical.ts`:

```typescript
import type { FundingChain } from "@shared/lib/funding/types";

export interface PriceLookupResult {
  usdPrice: number;
  source: "coingecko-historical" | "coingecko-spot-fallback" | "zero-no-price";
}

const CHAIN_TO_CG_ASSET_PLATFORM: Record<FundingChain, string | null> = {
  ethereum: "ethereum",
  base: "base",
  optimism: "optimistic-ethereum",
  arbitrum: "arbitrum-one",
  polygon: "polygon-pos",
  gnosis: "xdai",
};

const NATIVE_COIN_ID_BY_CHAIN: Record<FundingChain, string> = {
  ethereum: "ethereum",
  base: "ethereum",
  optimism: "ethereum",
  arbitrum: "ethereum",
  polygon: "matic-network",
  gnosis: "xdai",
};

export function makeAssetKey(chain: FundingChain, assetAddress: string | null): string {
  if (assetAddress == null) return `${chain}:native`;
  return `${chain}:${assetAddress.toLowerCase()}`;
}

/** Format a unix timestamp (seconds) as `DD-MM-YYYY` in UTC, the format CoinGecko's history endpoint expects. */
export function formatPriceDate(timestampSec: number): string {
  const date = new Date(timestampSec * 1000);
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getUTCFullYear());
  return `${dd}-${mm}-${yyyy}`;
}

interface CachedRow {
  usd_price: number;
  source: string;
}

/**
 * Look up USD price for an asset on a given UTC date.
 * Methodology pinned: CoinGecko `/coins/{id}/history?date=DD-MM-YYYY` returning `market_data.current_price.usd`.
 * Cached per (asset_key, price_date) in funding_price_cache.
 */
export async function fetchUsdPriceHistorical(
  db: D1Database,
  assetKey: string,
  priceDate: string,
  chain: FundingChain,
  fetchImpl: typeof fetch,
  coingeckoApiKey: string,
  assetAddress: string | null = null,
): Promise<PriceLookupResult> {
  const cached = await db
    .prepare("SELECT usd_price, source FROM funding_price_cache WHERE asset_key = ? AND price_date = ?")
    .bind(assetKey, priceDate)
    .first<CachedRow>();
  if (cached) {
    return { usdPrice: cached.usd_price, source: cached.source as PriceLookupResult["source"] };
  }

  const coinId = await resolveCoinId(chain, assetAddress, fetchImpl, coingeckoApiKey);
  if (!coinId) {
    await writeCache(db, assetKey, priceDate, 0, "zero-no-price");
    return { usdPrice: 0, source: "zero-no-price" };
  }

  const histUrl = `https://pro-api.coingecko.com/api/v3/coins/${coinId}/history?date=${priceDate}&localization=false`;
  const histResp = await fetchImpl(histUrl, { headers: { "x-cg-pro-api-key": coingeckoApiKey } });
  if (!histResp.ok) {
    return await fallbackToSpot(db, assetKey, priceDate, coinId, fetchImpl, coingeckoApiKey);
  }
  const histPayload = (await histResp.json()) as { market_data?: { current_price?: { usd?: number } } };
  const usdPrice = histPayload.market_data?.current_price?.usd;
  if (typeof usdPrice !== "number" || !Number.isFinite(usdPrice) || usdPrice <= 0) {
    return await fallbackToSpot(db, assetKey, priceDate, coinId, fetchImpl, coingeckoApiKey);
  }
  await writeCache(db, assetKey, priceDate, usdPrice, "coingecko-historical");
  return { usdPrice, source: "coingecko-historical" };
}

async function fallbackToSpot(
  db: D1Database,
  assetKey: string,
  priceDate: string,
  coinId: string,
  fetchImpl: typeof fetch,
  coingeckoApiKey: string,
): Promise<PriceLookupResult> {
  const spotUrl = `https://pro-api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`;
  const spotResp = await fetchImpl(spotUrl, { headers: { "x-cg-pro-api-key": coingeckoApiKey } });
  if (!spotResp.ok) {
    await writeCache(db, assetKey, priceDate, 0, "zero-no-price");
    return { usdPrice: 0, source: "zero-no-price" };
  }
  const spotPayload = (await spotResp.json()) as Record<string, { usd?: number }>;
  const spot = spotPayload[coinId]?.usd;
  if (typeof spot !== "number" || !Number.isFinite(spot) || spot <= 0) {
    await writeCache(db, assetKey, priceDate, 0, "zero-no-price");
    return { usdPrice: 0, source: "zero-no-price" };
  }
  await writeCache(db, assetKey, priceDate, spot, "coingecko-spot-fallback");
  return { usdPrice: spot, source: "coingecko-spot-fallback" };
}

async function writeCache(
  db: D1Database,
  assetKey: string,
  priceDate: string,
  usdPrice: number,
  source: string,
): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO funding_price_cache (asset_key, price_date, usd_price, source, cached_at) VALUES (?, ?, ?, ?, ?)")
    .bind(assetKey, priceDate, usdPrice, source, Math.floor(Date.now() / 1000))
    .run();
}

async function resolveCoinId(
  chain: FundingChain,
  assetAddress: string | null,
  fetchImpl: typeof fetch,
  coingeckoApiKey: string,
): Promise<string | null> {
  if (assetAddress == null) return NATIVE_COIN_ID_BY_CHAIN[chain] ?? null;
  const platform = CHAIN_TO_CG_ASSET_PLATFORM[chain];
  if (!platform) return null;
  const url = `https://pro-api.coingecko.com/api/v3/coins/${platform}/contract/${assetAddress.toLowerCase()}`;
  const resp = await fetchImpl(url, { headers: { "x-cg-pro-api-key": coingeckoApiKey } });
  if (!resp.ok) return null;
  const payload = (await resp.json()) as { id?: string };
  return payload.id ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd worker && npx vitest run src/lib/funding/__tests__/coingecko-historical.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/funding/coingecko-historical.ts worker/src/lib/funding/__tests__/coingecko-historical.test.ts
git commit -m "feat(funding): historical USD pricing via CoinGecko with D1 cache"
```

---

## Task 5: ENS forward-verified resolver

**Files:**
- Create: `worker/src/lib/funding/ens-resolver.ts`
- Test: `worker/src/lib/funding/__tests__/ens-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/src/lib/funding/__tests__/ens-resolver.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { resolveEnsForwardVerified } from "../ens-resolver";

const ADDR = "0x5d698362edb8aea1c2b2483096bdee3265d860db";

describe("resolveEnsForwardVerified", () => {
  it("returns null name when no reverse record exists", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      // First call: reverse-lookup returns empty string.
      if (call === 1) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(64 * 3) }), { status: 200 });
      }
      throw new Error("unexpected call");
    });
    const result = await resolveEnsForwardVerified(ADDR, fetchImpl as unknown as typeof fetch, "https://eth-rpc");
    expect(result.ensName).toBeNull();
    expect(result.forwardVerified).toBe(0);
  });

  it("returns name when forward resolution matches", async () => {
    // Reverse lookup returns "pharos-watch.eth"; forward returns the same address.
    const reverseResult = encodeAbiString("pharos-watch.eth");
    const forwardResult = "0x" + "0".repeat(24) + ADDR.slice(2);

    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: reverseResult }), { status: 200 });
      if (call === 2) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: forwardResult }), { status: 200 });
      throw new Error("unexpected call");
    });
    const result = await resolveEnsForwardVerified(ADDR, fetchImpl as unknown as typeof fetch, "https://eth-rpc");
    expect(result.ensName).toBe("pharos-watch.eth");
    expect(result.forwardVerified).toBe(1);
  });

  it("rejects forward mismatch", async () => {
    const reverseResult = encodeAbiString("attacker.eth");
    const forwardResult = "0x" + "0".repeat(24) + "1".repeat(40);

    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: reverseResult }), { status: 200 });
      if (call === 2) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: forwardResult }), { status: 200 });
      throw new Error("unexpected call");
    });
    const result = await resolveEnsForwardVerified(ADDR, fetchImpl as unknown as typeof fetch, "https://eth-rpc");
    expect(result.ensName).toBeNull();
    expect(result.forwardVerified).toBe(0);
  });
});

// Minimal helper: encode a string as ABI-encoded `string` return data.
function encodeAbiString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const offsetHex = "0".repeat(63) + "20"; // offset = 32
  const lenHex = bytes.length.toString(16).padStart(64, "0");
  let dataHex = "";
  for (const b of bytes) dataHex += b.toString(16).padStart(2, "0");
  // Pad to multiple of 64 hex chars.
  const padding = (64 - (dataHex.length % 64)) % 64;
  dataHex += "0".repeat(padding);
  return "0x" + offsetHex + lenHex + dataHex;
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npx vitest run src/lib/funding/__tests__/ens-resolver.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `worker/src/lib/funding/ens-resolver.ts`:

```typescript
/**
 * Forward-verified ENS resolution against Ethereum L1.
 *
 * 1. Reverse-lookup `<address>.addr.reverse` → ENS name (via ENS Universal Resolver).
 * 2. Forward-resolve that name → address.
 * 3. Only return the name if the forward resolution matches the input address.
 *
 * All RPC calls go through the supplied Ethereum L1 RPC endpoint (Alchemy or fallback).
 */

const ENS_PUBLIC_RESOLVER = "0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41";
const ENS_REGISTRY = "0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e";
// `name(bytes32)` selector
const NAME_SELECTOR = "0x691f3431";
// `addr(bytes32)` selector
const ADDR_SELECTOR = "0x3b3b57de";
// `resolver(bytes32)` selector
const RESOLVER_SELECTOR = "0x0178b8bf";

export interface EnsResolution {
  ensName: string | null;
  forwardVerified: 0 | 1;
}

export async function resolveEnsForwardVerified(
  address: string,
  fetchImpl: typeof fetch,
  ethRpcUrl: string,
): Promise<EnsResolution> {
  const lower = address.toLowerCase().replace(/^0x/, "");
  const reverseNode = namehash(`${lower}.addr.reverse`);

  const reverseData = NAME_SELECTOR + reverseNode.slice(2);
  const reverseResp = await ethCall(fetchImpl, ethRpcUrl, ENS_PUBLIC_RESOLVER, reverseData);
  if (!reverseResp) return { ensName: null, forwardVerified: 0 };
  const ensName = decodeAbiString(reverseResp);
  if (!ensName) return { ensName: null, forwardVerified: 0 };

  // Forward-resolve.
  const forwardNode = namehash(ensName);
  const resolverData = RESOLVER_SELECTOR + forwardNode.slice(2);
  const resolverResp = await ethCall(fetchImpl, ethRpcUrl, ENS_REGISTRY, resolverData);
  if (!resolverResp) return { ensName: null, forwardVerified: 0 };
  const resolver = "0x" + resolverResp.slice(-40);
  if (resolver === "0x0000000000000000000000000000000000000000") {
    return { ensName: null, forwardVerified: 0 };
  }
  const addrData = ADDR_SELECTOR + forwardNode.slice(2);
  const addrResp = await ethCall(fetchImpl, ethRpcUrl, resolver, addrData);
  if (!addrResp) return { ensName: null, forwardVerified: 0 };
  const forwardAddr = "0x" + addrResp.slice(-40).toLowerCase();
  if (forwardAddr !== address.toLowerCase()) {
    return { ensName: null, forwardVerified: 0 };
  }
  return { ensName, forwardVerified: 1 };
}

async function ethCall(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  to: string,
  data: string,
): Promise<string | null> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to, data }, "latest"],
  });
  const resp = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!resp.ok) return null;
  const payload = (await resp.json()) as { result?: string; error?: { message?: string } };
  if (!payload.result || payload.result === "0x") return null;
  return payload.result;
}

function decodeAbiString(hex: string): string | null {
  if (!hex.startsWith("0x") || hex.length < 130) return null;
  const data = hex.slice(2);
  const lenHex = data.slice(64, 128);
  const len = parseInt(lenHex, 16);
  if (!Number.isFinite(len) || len === 0) return null;
  const bytesHex = data.slice(128, 128 + len * 2);
  if (bytesHex.length < len * 2) return null;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = parseInt(bytesHex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

function namehash(name: string): string {
  let node = "0x" + "0".repeat(64);
  if (name.length === 0) return node;
  const labels = name.split(".").reverse();
  for (const label of labels) {
    const labelHash = keccak256Hex(new TextEncoder().encode(label));
    node = keccak256Hex(hexToBytes(node + labelHash.slice(2)));
  }
  return node;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// Keccak256 — Workers runtime ships SubtleCrypto SHA-256 only; use the dRPC
// JS keccak implementation from `js-sha3` already present in the worker for
// blacklist event topic matching. If not installed, add `js-sha3` as a worker
// dependency before running this code.
import { keccak256 as sha3Keccak256 } from "js-sha3";

function keccak256Hex(bytes: Uint8Array): string {
  return "0x" + sha3Keccak256(bytes);
}
```

- [ ] **Step 4: Verify dependency**

```bash
cd worker && npm ls js-sha3 2>&1 | head -3
```

If not present, add it:

```bash
cd worker && npm install js-sha3
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd worker && npx vitest run src/lib/funding/__tests__/ens-resolver.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/funding/ens-resolver.ts worker/src/lib/funding/__tests__/ens-resolver.test.ts worker/package.json worker/package-lock.json
git commit -m "feat(funding): forward-verified ENS resolver against L1"
```

---

## Task 6: Alchemy `getAssetTransfers` wrapper

**Files:**
- Create: `worker/src/lib/funding/alchemy-transfers.ts`
- Test: `worker/src/lib/funding/__tests__/alchemy-transfers.test.ts`
- Test fixtures: `worker/src/lib/funding/__tests__/fixtures/alchemy-transfers-eth.json`

- [ ] **Step 1: Capture a real fixture**

Substitute your Alchemy API key:

```bash
curl -s "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"alchemy_getAssetTransfers","params":[{"toAddress":"0x5d698362edb8aea1c2b2483096bdee3265d860db","category":["external","internal","erc20"],"withMetadata":true,"excludeZeroValue":true,"order":"asc"}]}' \
  | tee worker/src/lib/funding/__tests__/fixtures/alchemy-transfers-eth.json | head -c 200
```

Expected: JSON with `result.transfers` array containing at least the one known inbound tx (`0xc310bc94...`).

- [ ] **Step 2: Write the failing test**

Create `worker/src/lib/funding/__tests__/alchemy-transfers.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchAlchemyTransfersTo, parseAlchemyTransfers } from "../alchemy-transfers";

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "fixtures/alchemy-transfers-eth.json"), "utf8"),
);

describe("parseAlchemyTransfers", () => {
  it("normalizes the fixture into FundingDonationRow-shaped records", () => {
    const rows = parseAlchemyTransfers("ethereum", FIXTURE.result.transfers);
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0];
    expect(first.chain).toBe("ethereum");
    expect(first.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.from_address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(first.amount_decimal).toBeGreaterThan(0);
    expect(typeof first.block_timestamp).toBe("number");
  });
});

describe("fetchAlchemyTransfersTo", () => {
  it("paginates through pageKey responses", async () => {
    let call = 0;
    const fetchImpl = async (_url: string, _opts: RequestInit) => {
      call += 1;
      const transfers = call === 1
        ? [{ uniqueId: "1", hash: "0xabc", from: "0x1", to: "0x5d69", value: 0.1, asset: "ETH", rawContract: { address: null, decimal: "0x12" }, blockNum: "0x1", category: "external", metadata: { blockTimestamp: "2026-04-01T00:00:00Z" } }]
        : [{ uniqueId: "2", hash: "0xdef", from: "0x2", to: "0x5d69", value: 0.2, asset: "ETH", rawContract: { address: null, decimal: "0x12" }, blockNum: "0x2", category: "external", metadata: { blockTimestamp: "2026-04-02T00:00:00Z" } }];
      const pageKey = call === 1 ? "next-page" : undefined;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { transfers, pageKey } }), { status: 200 });
    };
    const transfers = await fetchAlchemyTransfersTo(fetchImpl as unknown as typeof fetch, "https://rpc", "0x5d69", "0x0");
    expect(transfers).toHaveLength(2);
    expect(call).toBe(2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd worker && npx vitest run src/lib/funding/__tests__/alchemy-transfers.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `worker/src/lib/funding/alchemy-transfers.ts`:

```typescript
import type { FundingChain } from "@shared/lib/funding/types";

export interface AlchemyTransferRaw {
  uniqueId?: string;
  hash: string;
  from: string;
  to: string;
  value: number | null; // already decimal-normalized by Alchemy
  asset: string | null;
  rawContract: { address: string | null; decimal: string | null };
  blockNum: string; // hex
  category: "external" | "internal" | "erc20";
  metadata?: { blockTimestamp?: string };
}

export interface NormalizedTransfer {
  chain: FundingChain;
  tx_hash: string;
  log_index: number; // 0 for native sends; we use uniqueId hash for ERC20
  block_number: number;
  block_timestamp: number;
  from_address: string;
  asset_symbol: string;
  asset_address: string | null;
  amount_decimal: number;
  category: AlchemyTransferRaw["category"];
}

const FUNDING_CATEGORIES = ["external", "internal", "erc20"] as const;

export async function fetchAlchemyTransfersTo(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  toAddress: string,
  fromBlockHex: string,
): Promise<AlchemyTransferRaw[]> {
  const collected: AlchemyTransferRaw[] = [];
  let pageKey: string | undefined;
  for (let page = 0; page < 25; page += 1) {
    const params: Record<string, unknown> = {
      toAddress,
      category: FUNDING_CATEGORIES,
      withMetadata: true,
      excludeZeroValue: true,
      order: "asc",
      fromBlock: fromBlockHex,
    };
    if (pageKey) params.pageKey = pageKey;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [params],
    });
    const resp = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`alchemy_getAssetTransfers failed (${resp.status}): ${text.slice(0, 200)}`);
    }
    const payload = (await resp.json()) as { result?: { transfers?: AlchemyTransferRaw[]; pageKey?: string }; error?: { message?: string } };
    if (payload.error) throw new Error(`alchemy_getAssetTransfers error: ${payload.error.message ?? "unknown"}`);
    const transfers = payload.result?.transfers ?? [];
    collected.push(...transfers);
    pageKey = payload.result?.pageKey;
    if (!pageKey) break;
  }
  return collected;
}

export function parseAlchemyTransfers(
  chain: FundingChain,
  raw: readonly AlchemyTransferRaw[],
): NormalizedTransfer[] {
  return raw.map((t, idx) => {
    const blockNumber = parseInt(t.blockNum, 16);
    const blockTimestamp = t.metadata?.blockTimestamp
      ? Math.floor(Date.parse(t.metadata.blockTimestamp) / 1000)
      : 0;
    return {
      chain,
      tx_hash: t.hash.toLowerCase(),
      // Alchemy doesn't expose log_index; ERC20 transfers in the same tx need stable indexing.
      // Use uniqueId hash → fall back to position-in-array; collisions across multi-asset tx
      // are still unique because the PK includes (chain, tx_hash, log_index).
      log_index: t.category === "external" || t.category === "internal" ? 0 : idx + 1,
      block_number: blockNumber,
      block_timestamp: blockTimestamp,
      from_address: t.from.toLowerCase(),
      asset_symbol: t.asset ?? (t.category === "erc20" ? "UNKNOWN" : nativeSymbolFor(chain)),
      asset_address: t.rawContract.address ? t.rawContract.address.toLowerCase() : null,
      amount_decimal: t.value ?? 0,
      category: t.category,
    };
  });
}

function nativeSymbolFor(chain: FundingChain): string {
  switch (chain) {
    case "polygon": return "MATIC";
    case "gnosis": return "xDAI";
    default: return "ETH";
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd worker && npx vitest run src/lib/funding/__tests__/alchemy-transfers.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/funding/alchemy-transfers.ts worker/src/lib/funding/__tests__/
git commit -m "feat(funding): alchemy_getAssetTransfers wrapper with pagination"
```

---

## Task 7: Gnosisscan REST client

**Files:**
- Create: `worker/src/lib/funding/gnosisscan.ts`
- Test: `worker/src/lib/funding/__tests__/gnosisscan.test.ts`
- Test fixtures: `worker/src/lib/funding/__tests__/fixtures/gnosisscan-{tokentx,txlist,txlistinternal}.json`

- [ ] **Step 1: Capture three real fixtures**

Substitute your Gnosisscan API key:

```bash
ADDR="0x5d698362edb8aea1c2b2483096bdee3265d860db"
mkdir -p worker/src/lib/funding/__tests__/fixtures
for endpoint in tokentx txlist txlistinternal; do
  curl -s "https://api.gnosisscan.io/api?module=account&action=$endpoint&address=$ADDR&startblock=0&endblock=99999999&sort=asc&apikey=$GNOSISSCAN_API_KEY" \
    > worker/src/lib/funding/__tests__/fixtures/gnosisscan-$endpoint.json
done
ls -la worker/src/lib/funding/__tests__/fixtures/gnosisscan-*.json
```

Expected: three non-empty JSON files. Each has `{ status: "1" | "0", message: ..., result: [] | [...] }`.

- [ ] **Step 2: Write the failing test**

Create `worker/src/lib/funding/__tests__/gnosisscan.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGnosisscanResults } from "../gnosisscan";

function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(__dirname, `fixtures/gnosisscan-${name}.json`), "utf8"));
}

describe("parseGnosisscanResults", () => {
  it("returns [] when result is empty", () => {
    const empty = { status: "0", message: "No transactions found", result: [] };
    expect(parseGnosisscanResults("tokentx", empty)).toEqual([]);
  });

  it("normalizes tokentx rows into NormalizedTransfer shape", () => {
    const fx = loadFixture("tokentx");
    const rows = parseGnosisscanResults("tokentx", fx);
    if (Array.isArray(fx.result) && fx.result.length > 0) {
      expect(rows.length).toBe(fx.result.length);
      expect(rows[0].chain).toBe("gnosis");
      expect(rows[0].asset_address).not.toBeNull();
    } else {
      expect(rows).toEqual([]);
    }
  });

  it("normalizes txlist rows (native xDAI) and skips outbound", () => {
    const fx = loadFixture("txlist");
    const rows = parseGnosisscanResults("txlist", fx);
    for (const row of rows) {
      expect(row.chain).toBe("gnosis");
      expect(row.asset_address).toBeNull();
      expect(row.from_address).not.toBe("0x5d698362edb8aea1c2b2483096bdee3265d860db");
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd worker && npx vitest run src/lib/funding/__tests__/gnosisscan.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `worker/src/lib/funding/gnosisscan.ts`:

```typescript
import type { NormalizedTransfer } from "./alchemy-transfers";
import { PHAROS_FUNDING_WALLET } from "./config";

type GnosisscanEndpoint = "tokentx" | "txlist" | "txlistinternal";

interface GnosisscanResponse<T> {
  status: "0" | "1";
  message: string;
  result: T[] | string;
}

interface GnosisscanTokenTxRow {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  contractAddress: string;
  value: string;
  tokenSymbol: string;
  tokenDecimal: string;
}

interface GnosisscanTxRow {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string; // wei
  isError: string;
}

const GNOSIS_NATIVE_SYMBOL = "xDAI";

export async function fetchGnosisscan(
  fetchImpl: typeof fetch,
  endpoint: GnosisscanEndpoint,
  address: string,
  startBlock: number,
  apiKey: string,
): Promise<GnosisscanResponse<unknown>> {
  const url = `https://api.gnosisscan.io/api?module=account&action=${endpoint}&address=${address}&startblock=${startBlock}&endblock=99999999&sort=asc&apikey=${apiKey}`;
  const resp = await fetchImpl(url);
  if (!resp.ok) throw new Error(`Gnosisscan ${endpoint} failed (${resp.status})`);
  return (await resp.json()) as GnosisscanResponse<unknown>;
}

export function parseGnosisscanResults(
  endpoint: GnosisscanEndpoint,
  payload: GnosisscanResponse<unknown>,
): NormalizedTransfer[] {
  if (!Array.isArray(payload.result)) return [];
  const rows = payload.result;
  const wallet = PHAROS_FUNDING_WALLET.toLowerCase();
  const out: NormalizedTransfer[] = [];

  if (endpoint === "tokentx") {
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i] as GnosisscanTokenTxRow;
      if (r.to.toLowerCase() !== wallet) continue;
      const decimals = parseInt(r.tokenDecimal, 10);
      const amountDecimal = Number(r.value) / 10 ** decimals;
      out.push({
        chain: "gnosis",
        tx_hash: r.hash.toLowerCase(),
        log_index: i + 1, // Gnosisscan does not expose logIndex; use position for stable PK
        block_number: parseInt(r.blockNumber, 10),
        block_timestamp: parseInt(r.timeStamp, 10),
        from_address: r.from.toLowerCase(),
        asset_symbol: r.tokenSymbol || "UNKNOWN",
        asset_address: r.contractAddress.toLowerCase(),
        amount_decimal: amountDecimal,
        category: "erc20",
      });
    }
    return out;
  }

  // txlist + txlistinternal — native xDAI; ignore failed and outbound rows.
  for (const raw of rows as GnosisscanTxRow[]) {
    if (raw.isError === "1") continue;
    if (raw.to.toLowerCase() !== wallet) continue;
    if (raw.from.toLowerCase() === wallet) continue; // self-send protection
    const amountDecimal = Number(BigInt(raw.value)) / 1e18;
    if (amountDecimal === 0) continue;
    out.push({
      chain: "gnosis",
      tx_hash: raw.hash.toLowerCase(),
      log_index: 0,
      block_number: parseInt(raw.blockNumber, 10),
      block_timestamp: parseInt(raw.timeStamp, 10),
      from_address: raw.from.toLowerCase(),
      asset_symbol: GNOSIS_NATIVE_SYMBOL,
      asset_address: null,
      amount_decimal: amountDecimal,
      category: endpoint === "txlistinternal" ? "internal" : "external",
    });
  }
  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd worker && npx vitest run src/lib/funding/__tests__/gnosisscan.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/funding/gnosisscan.ts worker/src/lib/funding/__tests__/
git commit -m "feat(funding): Gnosisscan REST client for tokentx/txlist/internal"
```

---

## Task 8: Donation ingestion (per-chain pipeline)

**Files:**
- Create: `worker/src/lib/funding/ingest.ts`
- Test: `worker/src/lib/funding/__tests__/ingest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/src/lib/funding/__tests__/ingest.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { ingestNormalizedTransfers } from "../ingest";
import type { NormalizedTransfer } from "../alchemy-transfers";

function makeFakeDb() {
  const insertedRows: unknown[][] = [];
  return {
    insertedRows,
    prepare(sql: string) {
      const isInsert = sql.includes("INSERT");
      return {
        bind: (...args: unknown[]) => ({
          first: async () => null,
          run: async () => {
            if (isInsert) insertedRows.push(args);
            return { success: true } as const;
          },
        }),
      };
    },
  };
}

describe("ingestNormalizedTransfers", () => {
  it("flags spam tokens via denylist and writes them with is_spam=1", async () => {
    const transfers: NormalizedTransfer[] = [
      {
        chain: "ethereum",
        tx_hash: "0xabc",
        log_index: 1,
        block_number: 100,
        block_timestamp: 1700000000,
        from_address: "0xsender",
        asset_symbol: "SPAM",
        asset_address: "0xspamtoken",
        amount_decimal: 1000000,
        category: "erc20",
      },
    ];
    const db = makeFakeDb();
    const denylist = { ethereum: ["0xspamtoken"], base: [], optimism: [], arbitrum: [], polygon: [], gnosis: [] };
    const lookupPrice = vi.fn(async () => ({ usdPrice: 0, source: "zero-no-price" as const }));

    const result = await ingestNormalizedTransfers({
      db: db as unknown as D1Database,
      transfers,
      denylist,
      lookupPrice,
    });

    expect(result.inserted).toBe(1);
    expect(result.spam).toBe(1);
    expect(lookupPrice).not.toHaveBeenCalled(); // skip pricing on spam
    const inserted = db.insertedRows[0];
    // is_spam column in the bind list (verify by spotting `1` in the right position).
    expect(inserted).toContain(1);
  });

  it("looks up USD price for non-spam transfers and writes with usd_at_receipt", async () => {
    const transfers: NormalizedTransfer[] = [
      {
        chain: "ethereum",
        tx_hash: "0xdef",
        log_index: 0,
        block_number: 200,
        block_timestamp: 1700000000,
        from_address: "0xsender",
        asset_symbol: "ETH",
        asset_address: null,
        amount_decimal: 0.5,
        category: "external",
      },
    ];
    const db = makeFakeDb();
    const denylist = { ethereum: [], base: [], optimism: [], arbitrum: [], polygon: [], gnosis: [] };
    const lookupPrice = vi.fn(async () => ({ usdPrice: 3000, source: "coingecko-historical" as const }));

    const result = await ingestNormalizedTransfers({
      db: db as unknown as D1Database,
      transfers,
      denylist,
      lookupPrice,
    });

    expect(result.inserted).toBe(1);
    expect(result.spam).toBe(0);
    expect(lookupPrice).toHaveBeenCalledTimes(1);
    const inserted = db.insertedRows[0];
    // usd_at_receipt = 0.5 * 3000 = 1500
    expect(inserted).toContain(1500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npx vitest run src/lib/funding/__tests__/ingest.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `worker/src/lib/funding/ingest.ts`:

```typescript
import type { FundingChain, SpamDenylist } from "@shared/lib/funding/types";
import type { NormalizedTransfer } from "./alchemy-transfers";
import { isSpamAsset } from "./spam-filter";
import { formatPriceDate, makeAssetKey } from "./coingecko-historical";
import type { PriceLookupResult } from "./coingecko-historical";

export interface IngestArgs {
  db: D1Database;
  transfers: readonly NormalizedTransfer[];
  denylist: SpamDenylist;
  lookupPrice: (assetKey: string, priceDate: string, chain: FundingChain, assetAddress: string | null) => Promise<PriceLookupResult>;
}

export interface IngestResult {
  inserted: number;
  spam: number;
  errors: string[];
}

export async function ingestNormalizedTransfers(args: IngestArgs): Promise<IngestResult> {
  const { db, transfers, denylist, lookupPrice } = args;
  let inserted = 0;
  let spam = 0;
  const errors: string[] = [];
  const now = Math.floor(Date.now() / 1000);

  for (const t of transfers) {
    const isSpam = isSpamAsset(denylist, t.chain, t.asset_address) ? 1 : 0;
    let usdAtReceipt = 0;
    let priceSource: PriceLookupResult["source"] = "zero-no-price";

    if (!isSpam) {
      try {
        const priceDate = formatPriceDate(t.block_timestamp);
        const assetKey = makeAssetKey(t.chain, t.asset_address);
        const price = await lookupPrice(assetKey, priceDate, t.chain, t.asset_address);
        usdAtReceipt = price.usdPrice * t.amount_decimal;
        priceSource = price.source;
      } catch (err) {
        errors.push(`price lookup failed for ${t.tx_hash}: ${String(err).slice(0, 120)}`);
      }
    }

    const finalIsSpam = isSpam || (priceSource === "zero-no-price" && usdAtReceipt === 0 && !isSpam ? 1 : 0);
    if (finalIsSpam) spam += 1;

    try {
      await db
        .prepare(
          `INSERT OR IGNORE INTO funding_donations
            (chain, tx_hash, log_index, block_number, block_timestamp,
             from_address, asset_symbol, asset_address, amount_raw, amount_decimal,
             usd_at_receipt, price_source, is_spam, is_refund, notes, inserted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
        )
        .bind(
          t.chain,
          t.tx_hash,
          t.log_index,
          t.block_number,
          t.block_timestamp,
          t.from_address,
          t.asset_symbol,
          t.asset_address,
          String(t.amount_decimal), // amount_raw stored as decimal string for big-int safety
          t.amount_decimal,
          usdAtReceipt,
          priceSource,
          finalIsSpam,
          now,
        )
        .run();
      inserted += 1;
    } catch (err) {
      errors.push(`insert failed for ${t.tx_hash}: ${String(err).slice(0, 120)}`);
    }
  }

  return { inserted, spam, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd worker && npx vitest run src/lib/funding/__tests__/ingest.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/funding/ingest.ts worker/src/lib/funding/__tests__/ingest.test.ts
git commit -m "feat(funding): donation ingestion with spam + USD enrichment"
```

---

## Task 9: Monthly aggregation

**Files:**
- Create: `worker/src/lib/funding/aggregate.ts`
- Test: `worker/src/lib/funding/__tests__/aggregate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/src/lib/funding/__tests__/aggregate.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { computeMonthsTouched, monthFromTimestamp, finalizeClosedMonths } from "../aggregate";

describe("monthFromTimestamp", () => {
  it("returns YYYY-MM in UTC", () => {
    const ts = Date.UTC(2026, 3, 18, 12, 0, 0) / 1000;
    expect(monthFromTimestamp(ts)).toBe("2026-04");
  });

  it("normalizes 23:59 UTC to its own day", () => {
    const ts = Date.UTC(2026, 3, 30, 23, 59, 0) / 1000;
    expect(monthFromTimestamp(ts)).toBe("2026-04");
  });
});

describe("computeMonthsTouched", () => {
  it("returns unique sorted YYYY-MM strings", () => {
    const months = computeMonthsTouched([
      { block_timestamp: Date.UTC(2026, 3, 1) / 1000 },
      { block_timestamp: Date.UTC(2026, 3, 30) / 1000 },
      { block_timestamp: Date.UTC(2026, 4, 1) / 1000 },
    ]);
    expect(months).toEqual(["2026-04", "2026-05"]);
  });
});

describe("finalizeClosedMonths", () => {
  it("returns months strictly before the current UTC month", () => {
    const nowSec = Date.UTC(2026, 4, 15) / 1000; // mid-May 2026
    const closed = finalizeClosedMonths(nowSec, ["2026-03", "2026-04", "2026-05"]);
    expect(closed).toEqual(["2026-03", "2026-04"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npx vitest run src/lib/funding/__tests__/aggregate.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `worker/src/lib/funding/aggregate.ts`:

```typescript
import { computeMonthlyTotal } from "@shared/lib/funding/cost-helpers";
import type { CostLineItem } from "@shared/lib/funding/types";

export function monthFromTimestamp(timestampSec: number): string {
  const d = new Date(timestampSec * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function computeMonthsTouched(rows: readonly { block_timestamp: number }[]): string[] {
  const set = new Set<string>();
  for (const row of rows) set.add(monthFromTimestamp(row.block_timestamp));
  return [...set].sort();
}

export function finalizeClosedMonths(nowSec: number, months: readonly string[]): string[] {
  const currentMonth = monthFromTimestamp(nowSec);
  return months.filter((m) => m < currentMonth);
}

export interface AggregateMonthArgs {
  db: D1Database;
  month: string;
  costLineItems: readonly CostLineItem[];
  finalize: boolean;
}

export async function recomputeMonthlyAggregate(args: AggregateMonthArgs): Promise<void> {
  const { db, month, costLineItems, finalize } = args;
  const monthStart = Math.floor(Date.UTC(parseInt(month.slice(0, 4), 10), parseInt(month.slice(5, 7), 10) - 1, 1) / 1000);
  const nextMonth = month.slice(0, 7) === "12-31" ? null : null;
  const [year, m] = month.split("-").map((s) => parseInt(s, 10));
  const monthEnd = Math.floor(Date.UTC(m === 12 ? year + 1 : year, m === 12 ? 0 : m, 1) / 1000);

  const row = await db
    .prepare(
      `SELECT
        COALESCE(SUM(usd_at_receipt), 0) AS donations_usd,
        COUNT(DISTINCT from_address) AS donor_count
       FROM funding_donations
       WHERE block_timestamp >= ? AND block_timestamp < ?
         AND is_spam = 0 AND is_refund = 0`,
    )
    .bind(monthStart, monthEnd)
    .first<{ donations_usd: number; donor_count: number }>();

  // Snapshot costs at finalization moment; for non-finalized months we still snapshot
  // so the API surfaces an honest current value.
  const costsUsd = computeMonthlyTotal(costLineItems);

  await db
    .prepare(
      `INSERT INTO funding_monthly (month, donations_usd, costs_usd, donor_count, finalized, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(month) DO UPDATE SET
         donations_usd = CASE WHEN funding_monthly.finalized = 1 THEN funding_monthly.donations_usd ELSE excluded.donations_usd END,
         costs_usd = CASE WHEN funding_monthly.finalized = 1 THEN funding_monthly.costs_usd ELSE excluded.costs_usd END,
         donor_count = CASE WHEN funding_monthly.finalized = 1 THEN funding_monthly.donor_count ELSE excluded.donor_count END,
         finalized = MAX(funding_monthly.finalized, excluded.finalized),
         computed_at = excluded.computed_at`,
    )
    .bind(month, row?.donations_usd ?? 0, costsUsd, row?.donor_count ?? 0, finalize ? 1 : 0, Math.floor(Date.now() / 1000))
    .run();
  void nextMonth; // silence unused warning kept for narrative clarity
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd worker && npx vitest run src/lib/funding/__tests__/aggregate.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/funding/aggregate.ts worker/src/lib/funding/__tests__/aggregate.test.ts
git commit -m "feat(funding): monthly aggregate recompute with finalization lock"
```

---

## Task 10: Cron orchestrator (sequential chains, freshness, ENS)

**Files:**
- Create: `worker/src/cron/sync-funding-donations.ts`
- Create: `shared/data/funding/index.ts` (re-exports JSON imports for typed access)
- Test: `worker/src/cron/__tests__/sync-funding-donations.test.ts`

- [ ] **Step 1: Add typed JSON re-export**

Create `shared/lib/funding/data.ts`:

```typescript
import costLineItemsJson from "@shared/data/funding/cost-line-items.json";
import donorLabelsJson from "@shared/data/funding/donor-labels.json";
import spamDenylistJson from "@shared/data/funding/spam-denylist.json";
import type { CostLineItem, DonorLabel, SpamDenylist } from "./types";

export const COST_LINE_ITEMS = costLineItemsJson as CostLineItem[];
export const DONOR_LABELS = donorLabelsJson as DonorLabel[];
export const SPAM_DENYLIST = spamDenylistJson as SpamDenylist;
```

(If TypeScript complains about JSON imports, ensure `tsconfig.json` has `"resolveJsonModule": true`.)

- [ ] **Step 2: Write the failing test**

Create `worker/src/cron/__tests__/sync-funding-donations.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { syncFundingDonations } from "../sync-funding-donations";

function makeStubDb() {
  const calls: string[] = [];
  return {
    calls,
    prepare(sql: string) {
      calls.push(sql);
      return {
        bind: () => ({
          first: async () => null,
          run: async () => ({ success: true }),
          all: async () => ({ results: [] }),
        }),
      };
    },
  };
}

describe("syncFundingDonations", () => {
  it("processes chains sequentially and isolates per-chain failures", async () => {
    const order: string[] = [];
    const fetchPerChain = vi.fn(async (chain: string) => {
      order.push(chain);
      if (chain === "base") throw new Error("simulated base failure");
      return [];
    });
    const db = makeStubDb();
    const result = await syncFundingDonations({
      db: db as unknown as D1Database,
      now: Date.UTC(2026, 3, 18) / 1000,
      fetchPerChain,
      lookupPrice: vi.fn(),
      resolveEns: vi.fn(),
    });
    expect(order).toEqual(["ethereum", "base", "optimism", "arbitrum", "polygon", "gnosis"]);
    expect(result.errors.find((e) => e.chain === "base")).toBeDefined();
    expect(result.errors.length).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd worker && npx vitest run src/cron/__tests__/sync-funding-donations.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `worker/src/cron/sync-funding-donations.ts`:

```typescript
import { FUNDING_CHAINS, type FundingChain } from "@shared/lib/funding/types";
import { COST_LINE_ITEMS, SPAM_DENYLIST } from "@shared/lib/funding/data";
import type { NormalizedTransfer } from "../lib/funding/alchemy-transfers";
import { fetchAlchemyTransfersTo, parseAlchemyTransfers } from "../lib/funding/alchemy-transfers";
import { fetchGnosisscan, parseGnosisscanResults } from "../lib/funding/gnosisscan";
import { fetchUsdPriceHistorical } from "../lib/funding/coingecko-historical";
import type { PriceLookupResult } from "../lib/funding/coingecko-historical";
import { resolveEnsForwardVerified } from "../lib/funding/ens-resolver";
import type { EnsResolution } from "../lib/funding/ens-resolver";
import { ingestNormalizedTransfers } from "../lib/funding/ingest";
import {
  computeMonthsTouched,
  finalizeClosedMonths,
  monthFromTimestamp,
  recomputeMonthlyAggregate,
} from "../lib/funding/aggregate";
import { PHAROS_FUNDING_WALLET, FUNDING_ENS_TTL_SECONDS } from "../lib/funding/config";
import { ALCHEMY_CHAINS } from "../lib/chain-registry";

export interface SyncFundingArgs {
  db: D1Database;
  now: number;
  fetchPerChain: (chain: FundingChain, fromBlock: number) => Promise<NormalizedTransfer[]>;
  lookupPrice: (assetKey: string, priceDate: string, chain: FundingChain, assetAddress: string | null) => Promise<PriceLookupResult>;
  resolveEns: (address: string) => Promise<EnsResolution>;
}

export interface SyncFundingResult {
  per_chain: Array<{ chain: FundingChain; ingested: number; spam: number }>;
  errors: Array<{ chain: FundingChain | null; error: string }>;
  ens_resolved: number;
  monthly_recomputed: number;
}

export async function syncFundingDonations(args: SyncFundingArgs): Promise<SyncFundingResult> {
  const result: SyncFundingResult = {
    per_chain: [],
    errors: [],
    ens_resolved: 0,
    monthly_recomputed: 0,
  };

  const allTransfers: NormalizedTransfer[] = [];

  for (const chain of FUNDING_CHAINS) {
    let chainResult = { ingested: 0, spam: 0 };
    try {
      const cursor = await args.db
        .prepare("SELECT last_block_seen FROM funding_chain_sync WHERE chain = ?")
        .bind(chain)
        .first<{ last_block_seen: number }>();
      const fromBlock = cursor?.last_block_seen ?? 0;

      const transfers = await args.fetchPerChain(chain, fromBlock);
      allTransfers.push(...transfers);

      const ingest = await ingestNormalizedTransfers({
        db: args.db,
        transfers,
        denylist: SPAM_DENYLIST,
        lookupPrice: args.lookupPrice,
      });
      chainResult = { ingested: ingest.inserted, spam: ingest.spam };

      const maxBlock = transfers.reduce((max, t) => Math.max(max, t.block_number), fromBlock);
      await args.db
        .prepare(
          `INSERT INTO funding_chain_sync (chain, last_block_seen, last_success_at, last_attempt_at, last_error)
           VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT(chain) DO UPDATE SET
             last_block_seen = excluded.last_block_seen,
             last_success_at = excluded.last_success_at,
             last_attempt_at = excluded.last_attempt_at,
             last_error = NULL`,
        )
        .bind(chain, maxBlock, args.now, args.now)
        .run();
      result.per_chain.push({ chain, ...chainResult });
    } catch (err) {
      const message = String(err).slice(0, 200);
      result.errors.push({ chain, error: message });
      await args.db
        .prepare(
          `INSERT INTO funding_chain_sync (chain, last_block_seen, last_success_at, last_attempt_at, last_error)
           VALUES (?, 0, 0, ?, ?)
           ON CONFLICT(chain) DO UPDATE SET
             last_attempt_at = excluded.last_attempt_at,
             last_error = excluded.last_error`,
        )
        .bind(chain, args.now, message)
        .run();
      result.per_chain.push({ chain, ingested: 0, spam: 0 });
    }
  }

  // ENS resolve any new senders (deduped, with TTL).
  const distinctSenders = new Set(allTransfers.map((t) => t.from_address));
  for (const sender of distinctSenders) {
    try {
      const cached = await args.db
        .prepare("SELECT resolved_at FROM funding_ens_cache WHERE address = ?")
        .bind(sender)
        .first<{ resolved_at: number }>();
      if (cached && args.now - cached.resolved_at < FUNDING_ENS_TTL_SECONDS) continue;
      const ens = await args.resolveEns(sender);
      await args.db
        .prepare(
          `INSERT INTO funding_ens_cache (address, ens_name, forward_verified, resolved_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(address) DO UPDATE SET
             ens_name = excluded.ens_name,
             forward_verified = excluded.forward_verified,
             resolved_at = excluded.resolved_at`,
        )
        .bind(sender, ens.ensName, ens.forwardVerified, args.now)
        .run();
      result.ens_resolved += 1;
    } catch (err) {
      result.errors.push({ chain: null, error: `ens resolve ${sender}: ${String(err).slice(0, 120)}` });
    }
  }

  // Recompute aggregates for all months touched + the current month + any newly closed months.
  const monthsTouched = computeMonthsTouched(allTransfers);
  if (monthsTouched.length === 0) monthsTouched.push(monthFromTimestamp(args.now));
  const closedMonths = new Set(finalizeClosedMonths(args.now, monthsTouched));
  for (const month of monthsTouched) {
    await recomputeMonthlyAggregate({
      db: args.db,
      month,
      costLineItems: COST_LINE_ITEMS,
      finalize: closedMonths.has(month),
    });
    result.monthly_recomputed += 1;
  }

  void ALCHEMY_CHAINS;
  void PHAROS_FUNDING_WALLET;
  return result;
}

// Default fetcher built around real network calls; used by the scheduled handler,
// not by unit tests. Keep here so the cron file is the single import surface.
export function buildDefaultChainFetcher(env: {
  ALCHEMY_API_KEY: string;
  GNOSISSCAN_API_KEY: string;
}): (chain: FundingChain, fromBlock: number) => Promise<NormalizedTransfer[]> {
  return async (chain, fromBlock) => {
    if (chain === "gnosis") {
      const fxs = await Promise.all(
        (["tokentx", "txlist", "txlistinternal"] as const).map(async (endpoint) => {
          const payload = await fetchGnosisscan(fetch, endpoint, PHAROS_FUNDING_WALLET, fromBlock, env.GNOSISSCAN_API_KEY);
          return parseGnosisscanResults(endpoint, payload);
        }),
      );
      return fxs.flat();
    }
    const slug = ALCHEMY_CHAINS[chain];
    if (!slug) throw new Error(`No Alchemy slug for chain ${chain}`);
    const rpcUrl = `https://${slug}.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
    const fromBlockHex = "0x" + fromBlock.toString(16);
    const raw = await fetchAlchemyTransfersTo(fetch, rpcUrl, PHAROS_FUNDING_WALLET, fromBlockHex);
    return parseAlchemyTransfers(chain, raw);
  };
}

export function buildDefaultEnsResolver(env: { ALCHEMY_API_KEY: string }): SyncFundingArgs["resolveEns"] {
  const rpcUrl = `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
  return (address) => resolveEnsForwardVerified(address, fetch, rpcUrl);
}

export { fetchUsdPriceHistorical };
```

(The price lookup is built inline in the slot runner — Task 11 — because it needs the `db` handle in addition to the env.)

- [ ] **Step 5: Run test to verify it passes**

```bash
cd worker && npx vitest run src/cron/__tests__/sync-funding-donations.test.ts
```

Expected: PASS, 1 test.

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/sync-funding-donations.ts shared/lib/funding/data.ts worker/src/cron/__tests__/sync-funding-donations.test.ts
git commit -m "feat(funding): cron orchestrator with sequential chains and ENS"
```

---

## Task 11: Cron registration (slot, schedules, wrangler.toml)

**Files:**
- Create: `worker/src/handlers/scheduled/daily-0700.ts`
- Modify: `shared/lib/cron-jobs.ts`
- Modify: `shared/lib/scheduled-runner-registry.ts`
- Modify: `worker/src/handlers/scheduled.ts`
- Modify: `worker/wrangler.toml`

- [ ] **Step 1: Add the schedule constant**

Edit `shared/lib/cron-jobs.ts`. Inside `CRON_SCHEDULES`, add `daily0700Utc: "0 7 * * *",` between `daily0300Utc` and `daily0800Utc`. Inside `CRON_SCHEDULE_BUCKETS`, add `daily0700Utc: { intervalSec: DAY_SECONDS, offsetSec: 7 * 3600 },` in the same position.

- [ ] **Step 2: Add the job definition**

Inside `CRON_JOB_DEFINITIONS_BASE` in `shared/lib/cron-jobs.ts`, add a new entry:

```typescript
{
  job: "sync-funding-donations",
  label: "Funding donations sync",
  group: "daily",
  intervalSec: DAY_SECONDS,
  scheduleKey: "daily0700Utc",
  triggerMode: "isolated",
  maxConnections: 4, // Sequential chain fetches; up to 4 simultaneous CG/ENS calls in tail
},
```

(The `triggerMode: "isolated"` ensures the funding cron does not chain into other daily-0800 jobs, leaving its full 6-connection budget exclusive.)

- [ ] **Step 3: Register the runner key**

Edit `shared/lib/scheduled-runner-registry.ts`. Inside `SCHEDULED_RUNNER_KEYS_BY_SCHEDULE`, add:

```typescript
[CRON_SCHEDULES.daily0700Utc]: "daily0700Utc",
```

- [ ] **Step 4: Create the slot runner**

Create `worker/src/handlers/scheduled/daily-0700.ts`:

```typescript
import type { ScheduledRuntimeContext } from "./context";
import {
  buildDefaultChainFetcher,
  buildDefaultEnsResolver,
  syncFundingDonations,
  fetchUsdPriceHistorical,
} from "../../cron/sync-funding-donations";

export async function runDaily0700Slot(runtime: ScheduledRuntimeContext): Promise<void> {
  try {
    await runtime.runLeasedCron("sync-funding-donations", async () => {
      const env = runtime.env as unknown as {
        ALCHEMY_API_KEY: string;
        GNOSISSCAN_API_KEY: string;
        COINGECKO_API_KEY: string;
      };
      const fetchPerChain = buildDefaultChainFetcher(env);
      const resolveEns = buildDefaultEnsResolver(env);
      const lookupPrice = (assetKey: string, priceDate: string, chain: Parameters<typeof fetchUsdPriceHistorical>[3], assetAddress: string | null) =>
        fetchUsdPriceHistorical(runtime.db, assetKey, priceDate, chain, fetch, env.COINGECKO_API_KEY, assetAddress);

      const result = await syncFundingDonations({
        db: runtime.db,
        now: Math.floor(Date.now() / 1000),
        fetchPerChain,
        lookupPrice,
        resolveEns,
      });
      console.log("[funding] sync complete:", JSON.stringify(result));
    });
  } catch (err) {
    console.error("[cron] sync-funding-donations failed in daily 07:00 slot:", err);
  }
}
```

- [ ] **Step 5: Wire the slot into the dispatch table**

Edit `worker/src/handlers/scheduled.ts`. Add the import:

```typescript
import { runDaily0700Slot } from "./scheduled/daily-0700";
```

And add `daily0700Utc: runDaily0700Slot,` to `SLOT_RUNNER_BY_KEY`.

- [ ] **Step 6: Add the trigger to wrangler.toml**

Edit `worker/wrangler.toml`. Inside `[triggers] crons = [ ... ]`, insert `"0 7 * * *",` between the existing `"*/5 * * * *",` and `"0 8 * * *",` lines (or wherever maintains chronological order).

- [ ] **Step 7: Type-check the worker**

```bash
cd worker && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 8: Run the tests for the new wiring**

```bash
cd worker && npx vitest run src/cron/__tests__/sync-funding-donations.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add shared/lib/cron-jobs.ts shared/lib/scheduled-runner-registry.ts worker/src/handlers/scheduled.ts worker/src/handlers/scheduled/daily-0700.ts worker/wrangler.toml
git commit -m "feat(funding): register daily 07:00 UTC cron slot"
```

---

## Task 12: Add Brice's EOA + Giveth pool to donor labels (post-implementation review)

**Files:**
- Modify: `shared/data/funding/donor-labels.json`

- [ ] **Step 1: Identify Brice's EOA**

Inspect the one known inbound tx:

```bash
echo "https://etherscan.io/tx/0xc310bc94c763f00c939aefba0094e012892b45e688954283199264d37cdb8786"
```

The `From` field on Etherscan is Brice's EOA. Lowercase it.

- [ ] **Step 2: Identify the Giveth payout contract address per chain**

Make a small test donation through Giveth (any small ETH amount through https://giveth.io/project/pharos-watch:-transparent-stablecoins-analytics). Wait for it to finalize. Inspect the `From` address on the inbound transfer to `0x5d698362edb8aea1c2b2483096bdee3265d860db` — that's the Giveth payout contract on the chain you donated from. Repeat per chain only if Giveth sends from chain-specific contracts.

- [ ] **Step 3: Update donor-labels.json**

```json
[
  { "address": "0x<brice-eoa-lowercased>", "label": "TokenBrice (founder subsidy)" },
  { "address": "0x<giveth-pool-lowercased>", "label": "via Giveth" }
]
```

- [ ] **Step 4: Commit**

```bash
git add shared/data/funding/donor-labels.json
git commit -m "feat(funding): label founder subsidy and Giveth pool donors"
```

---

## Task 13: API endpoint `/api/funding-summary`

**Files:**
- Create: `worker/src/api/funding-summary.ts`
- Modify: `worker/src/routes/public-routes.ts`
- Test: `worker/src/api/__tests__/funding-summary.test.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/src/api/__tests__/funding-summary.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { handleFundingSummary } from "../funding-summary";

function makeDbWithSeed(seed: {
  monthly: Array<{ month: string; donations_usd: number; costs_usd: number; donor_count: number; finalized: number }>;
  donors: Array<{ from_address: string; usd: number; ts: number; ens?: string | null; forward?: number }>;
  chainSync: Array<{ chain: string; last_success_at: number; last_attempt_at: number; last_error: string | null }>;
}) {
  return {
    prepare(sql: string) {
      return {
        bind: () => ({
          first: async () => null,
          all: async () => {
            if (sql.includes("FROM funding_monthly")) return { results: seed.monthly };
            if (sql.includes("GROUP BY") && sql.includes("from_address")) return {
              results: seed.donors.map((d) => ({
                from_address: d.from_address,
                total_usd: d.usd,
                most_recent_at: d.ts,
                ens_name: d.ens ?? null,
                forward_verified: d.forward ?? 0,
                custom_label: null,
              })),
            };
            if (sql.includes("FROM funding_chain_sync")) return { results: seed.chainSync };
            return { results: [] };
          },
        }),
      };
    },
  };
}

describe("handleFundingSummary", () => {
  it("returns a complete payload with kpis, monthly_series, line_items, donors, freshness", async () => {
    const db = makeDbWithSeed({
      monthly: [
        { month: "2026-02", donations_usd: 100, costs_usd: 1676.85, donor_count: 1, finalized: 1 },
        { month: "2026-03", donations_usd: 200, costs_usd: 1676.85, donor_count: 2, finalized: 1 },
        { month: "2026-04", donations_usd: 300, costs_usd: 1676.85, donor_count: 3, finalized: 0 },
      ],
      donors: [
        { from_address: "0xa", usd: 300, ts: 1700000000, ens: "alice.eth", forward: 1 },
      ],
      chainSync: [
        { chain: "ethereum", last_success_at: 1700000000, last_attempt_at: 1700000000, last_error: null },
      ],
    });
    const resp = await handleFundingSummary(db as unknown as D1Database);
    const body = await resp.json() as { kpis: { current_month_donations_usd: number; trailing_3mo_avg_coverage_pct: number; total_raised_lifetime_usd: number; distinct_donors_lifetime: number }; recent_donors: unknown[]; line_items: unknown[]; monthly_series: unknown[]; chain_freshness: unknown[]; last_synced_at: number };
    expect(body.kpis.current_month_donations_usd).toBe(300);
    expect(body.kpis.total_raised_lifetime_usd).toBe(600);
    expect(body.recent_donors[0]).toMatchObject({ display: "alice.eth" });
    expect(body.line_items.length).toBeGreaterThan(0);
    expect(body.monthly_series.length).toBe(3);
    expect(body.chain_freshness.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npx vitest run src/api/__tests__/funding-summary.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `worker/src/api/funding-summary.ts`:

```typescript
import { COST_LINE_ITEMS, DONOR_LABELS } from "@shared/lib/funding/data";
import { computeMonthlyTotal } from "@shared/lib/funding/cost-helpers";
import type {
  FundingSummaryResponse,
  FundingMonthlyPoint,
  FundingDonorWallEntry,
  ChainFreshnessEntry,
} from "@shared/lib/funding/types";
import { FUNDING_CHAINS } from "@shared/lib/funding/types";
import { ETHERSCAN_ADDRESS_URL_BY_CHAIN } from "../lib/funding/config";

const TRAILING_MONTHS = 12;
const DONOR_WALL_LIMIT = 20;

export async function handleFundingSummary(db: D1Database): Promise<Response> {
  const monthly = await db
    .prepare(
      `SELECT month, donations_usd, costs_usd, donor_count, finalized
       FROM funding_monthly
       ORDER BY month ASC`,
    )
    .all<{ month: string; donations_usd: number; costs_usd: number; donor_count: number; finalized: number }>();
  const monthlySeries = (monthly.results ?? []).map<FundingMonthlyPoint>((r) => ({
    month: r.month,
    donations_usd: r.donations_usd,
    costs_usd: r.costs_usd,
    donor_count: r.donor_count,
  }));

  const trailing = monthlySeries.slice(-TRAILING_MONTHS);
  const currentMonth = monthFromNow();
  const currentRow = monthlySeries.find((r) => r.month === currentMonth);

  const monthlyTarget = computeMonthlyTotal(COST_LINE_ITEMS);
  const currentDonations = currentRow?.donations_usd ?? 0;
  const currentCoveragePct = monthlyTarget > 0 ? (currentDonations / monthlyTarget) * 100 : 0;

  const last3 = monthlySeries.slice(-3);
  const trailing3moDonations = last3.reduce((s, r) => s + r.donations_usd, 0);
  const trailing3moCosts = last3.reduce((s, r) => s + r.costs_usd, 0);
  const trailing3moCoveragePct = trailing3moCosts > 0 ? (trailing3moDonations / trailing3moCosts) * 100 : 0;

  const lifetime = await db
    .prepare(
      `SELECT
         COALESCE(SUM(usd_at_receipt), 0) AS total,
         COUNT(DISTINCT from_address) AS donors
       FROM funding_donations
       WHERE is_spam = 0 AND is_refund = 0`,
    )
    .first<{ total: number; donors: number }>();

  const donorRows = await db
    .prepare(
      `SELECT
         d.from_address,
         SUM(d.usd_at_receipt) AS total_usd,
         MAX(d.block_timestamp) AS most_recent_at,
         e.ens_name,
         e.forward_verified
       FROM funding_donations d
       LEFT JOIN funding_ens_cache e ON e.address = d.from_address
       WHERE d.is_spam = 0 AND d.is_refund = 0
       GROUP BY d.from_address
       ORDER BY most_recent_at DESC
       LIMIT ?`,
    )
    .bind(DONOR_WALL_LIMIT)
    .all<{ from_address: string; total_usd: number; most_recent_at: number; ens_name: string | null; forward_verified: number }>();

  const labelMap = new Map(DONOR_LABELS.map((d) => [d.address.toLowerCase(), d.label]));
  const recentDonors: FundingDonorWallEntry[] = (donorRows.results ?? []).map((row) => {
    const customLabel = labelMap.get(row.from_address);
    const display = customLabel
      ? customLabel
      : row.forward_verified === 1 && row.ens_name
        ? row.ens_name
        : `${row.from_address.slice(0, 6)}…${row.from_address.slice(-4)}`;
    return {
      address: row.from_address,
      display,
      total_usd: row.total_usd,
      most_recent_at: row.most_recent_at,
      etherscan_url: ETHERSCAN_ADDRESS_URL_BY_CHAIN.ethereum(row.from_address),
    };
  });

  const freshnessRows = await db
    .prepare(
      `SELECT chain, last_success_at, last_attempt_at, last_error
       FROM funding_chain_sync`,
    )
    .all<{ chain: string; last_success_at: number; last_attempt_at: number; last_error: string | null }>();
  const freshnessByChain = new Map((freshnessRows.results ?? []).map((r) => [r.chain, r]));
  const chainFreshness: ChainFreshnessEntry[] = FUNDING_CHAINS.map<ChainFreshnessEntry>((chain) => {
    const row = freshnessByChain.get(chain);
    return {
      chain,
      last_success_at: row?.last_success_at ?? 0,
      last_attempt_at: row?.last_attempt_at ?? 0,
      last_error: row?.last_error ?? null,
    };
  });

  const lastSyncedAt = chainFreshness.reduce((max, r) => Math.max(max, r.last_success_at), 0);

  const response: FundingSummaryResponse = {
    kpis: {
      current_month_coverage_pct: round1(currentCoveragePct),
      current_month_donations_usd: round2(currentDonations),
      current_month_target_usd: monthlyTarget,
      trailing_3mo_avg_coverage_pct: round1(trailing3moCoveragePct),
      total_raised_lifetime_usd: round2(lifetime?.total ?? 0),
      distinct_donors_lifetime: lifetime?.donors ?? 0,
    },
    monthly_series: trailing,
    line_items: COST_LINE_ITEMS,
    recent_donors: recentDonors,
    chain_freshness: chainFreshness,
    last_synced_at: lastSyncedAt,
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
  });
}

function monthFromNow(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
```

- [ ] **Step 4: Register the route**

Edit `worker/src/routes/public-routes.ts`. Add the import alongside the others:

```typescript
import { handleFundingSummary } from "../api/funding-summary";
```

And add a route definition near the other static routes:

```typescript
defineStaticRoute("funding-summary", ({ db }) => handleFundingSummary(db)),
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd worker && npx vitest run src/api/__tests__/funding-summary.test.ts
```

Expected: PASS, 1 test.

- [ ] **Step 6: Type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add worker/src/api/funding-summary.ts worker/src/api/__tests__/funding-summary.test.ts worker/src/routes/public-routes.ts
git commit -m "feat(funding): /api/funding-summary endpoint"
```

---

## Task 14: API path constant + frontend hook

**Files:**
- Modify: `shared/lib/api-endpoints/paths.ts`
- Create: `src/hooks/use-funding-summary.ts`

- [ ] **Step 1: Add path constant**

Edit `shared/lib/api-endpoints/paths.ts`. Inside `API_PATHS` add `fundingSummary: () => "/api/funding-summary",` near the other `*Summary` routes.

- [ ] **Step 2: Add cron interval mapping**

Edit `src/lib/cron-intervals.ts`. The file derives intervals from `CRON_INTERVALS` by job key. Add a new line alongside the existing constants:

```typescript
export const CRON_FUNDING_SUMMARY = CRON_INTERVALS["sync-funding-donations"] * 1000;
```

This pulls the daily interval from the registry entry added in Task 11 — no manual sync needed.

- [ ] **Step 3: Create the hook**

Create `src/hooks/use-funding-summary.ts`:

```typescript
"use client";

import { API_PATHS } from "@shared/lib/api-endpoints";
import type { FundingSummaryResponse } from "@shared/lib/funding/types";
import { CRON_FUNDING_SUMMARY } from "@/lib/cron-intervals";
import { useApiQuery } from "./use-api-query";

export function useFundingSummary() {
  return useApiQuery<FundingSummaryResponse>(
    ["funding-summary"],
    API_PATHS.fundingSummary(),
    CRON_FUNDING_SUMMARY,
    { retry: 1 },
  );
}
```

(Read `src/hooks/use-api-query.ts` first to confirm the exact factory signature; the call above mirrors `useBlacklistEventsPage`.)

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add shared/lib/api-endpoints/paths.ts src/lib/cron-intervals.ts src/hooks/use-funding-summary.ts
git commit -m "feat(funding): API path constant + useFundingSummary hook"
```

---

## Task 15: Components — KPI row, chart, cost breakdown, donor wall

**Files:**
- Create: `src/components/funding/funding-kpi-row.tsx`
- Create: `src/components/funding/funding-monthly-chart.tsx`
- Create: `src/components/funding/cost-breakdown.tsx`
- Create: `src/components/funding/donor-wall.tsx`
- Test: `src/components/funding/__tests__/funding-kpi-row.test.tsx`
- Test: `src/components/funding/__tests__/cost-breakdown.test.tsx`
- Test: `src/components/funding/__tests__/donor-wall.test.tsx`

- [ ] **Step 1: KPI row test**

Create `src/components/funding/__tests__/funding-kpi-row.test.tsx`:

```typescript
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FundingKpiRow } from "../funding-kpi-row";

describe("FundingKpiRow", () => {
  it("renders three KPIs with formatted values", () => {
    render(
      <FundingKpiRow
        kpis={{
          current_month_coverage_pct: 42.3,
          current_month_donations_usd: 707.71,
          current_month_target_usd: 1676.85,
          trailing_3mo_avg_coverage_pct: 38.5,
          total_raised_lifetime_usd: 4321,
          distinct_donors_lifetime: 7,
        }}
      />,
    );
    expect(screen.getByText(/This month/i)).toBeInTheDocument();
    expect(screen.getByText(/\$707\.71/)).toBeInTheDocument();
    expect(screen.getByText(/42\.3%/)).toBeInTheDocument();
    expect(screen.getByText(/3-month/i)).toBeInTheDocument();
    expect(screen.getByText(/Total raised/i)).toBeInTheDocument();
    expect(screen.getByText(/7 donors/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: KPI row implementation**

Create `src/components/funding/funding-kpi-row.tsx`:

```typescript
import type { FundingKpis } from "@shared/lib/funding/types";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface KpiCardProps {
  kicker: string;
  primary: string;
  secondary: string;
  toneBorder: string;
  toneAccent: string;
}

function KpiCard({ kicker, primary, secondary, toneBorder, toneAccent }: KpiCardProps) {
  return (
    <Card className={cn("rounded-xl border-l-[3px]", toneBorder)}>
      <CardContent className="space-y-1 p-4">
        <p className={cn("pharos-kicker", toneAccent)}>{kicker}</p>
        <p className="text-2xl font-semibold tracking-tight text-foreground">{primary}</p>
        <p className="text-xs text-muted-foreground">{secondary}</p>
      </CardContent>
    </Card>
  );
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const USD_COMPACT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });

export function FundingKpiRow({ kpis }: { kpis: FundingKpis }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <KpiCard
        kicker="This month"
        primary={`${USD.format(kpis.current_month_donations_usd)} / ${USD.format(kpis.current_month_target_usd)}`}
        secondary={`${kpis.current_month_coverage_pct}% covered`}
        toneBorder="border-l-frost-blue"
        toneAccent="text-sky-700 dark:text-frost-blue/82"
      />
      <KpiCard
        kicker="3-month average"
        primary={`${kpis.trailing_3mo_avg_coverage_pct}%`}
        secondary="trailing-3-month coverage"
        toneBorder="border-l-emerald-500"
        toneAccent="text-emerald-700 dark:text-emerald-400"
      />
      <KpiCard
        kicker="Total raised"
        primary={USD_COMPACT.format(kpis.total_raised_lifetime_usd)}
        secondary={`${kpis.distinct_donors_lifetime} donors lifetime`}
        toneBorder="border-l-amber-500"
        toneAccent="text-amber-700 dark:text-amber-400"
      />
    </div>
  );
}
```

- [ ] **Step 3: Chart implementation**

Create `src/components/funding/funding-monthly-chart.tsx`:

```typescript
"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChainFreshnessEntry, FundingMonthlyPoint } from "@shared/lib/funding/types";
import { FUNDING_CHAIN_FRESHNESS_WARN_SECONDS } from "@/lib/funding-config-shim";

interface Props {
  series: FundingMonthlyPoint[];
  chainFreshness: ChainFreshnessEntry[];
  lastSyncedAt: number;
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function FundingMonthlyChart({ series, chainFreshness, lastSyncedAt }: Props) {
  const now = Math.floor(Date.now() / 1000);
  const stale = chainFreshness.filter((c) => c.last_success_at > 0 && now - c.last_success_at > FUNDING_CHAIN_FRESHNESS_WARN_SECONDS);

  return (
    <div className="space-y-2">
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(120,140,180,0.18)" />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} />
            <YAxis tickFormatter={(v) => USD.format(v)} tick={{ fontSize: 11 }} width={70} />
            <Tooltip
              formatter={(v: number, name) => [USD.format(v), name]}
              labelFormatter={(label) => label}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="donations_usd" name="Donations" fill="#10b981" radius={[3, 3, 0, 0]} />
            <Bar dataKey="costs_usd" name="Costs" fill="#ef4444" fillOpacity={0.6} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[11px] text-muted-foreground">
        <a
          href="https://github.com/TokenBrice/stablecoin-dashboard/blob/main/docs/funding-page.md#pricing-methodology"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          How USD amounts are computed →
        </a>
        {lastSyncedAt > 0 ? <span> · Last sync {formatRelative(lastSyncedAt, now)}</span> : null}
      </p>
      {stale.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          Chain sync stale: {stale.map((c) => c.chain).join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function formatRelative(then: number, now: number): string {
  const seconds = now - then;
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
```

Then create `src/lib/funding-config-shim.ts`:

```typescript
export const FUNDING_CHAIN_FRESHNESS_WARN_SECONDS = 36 * 60 * 60;
```

(This shim mirrors the worker constant since the worker config can't be imported into the frontend bundle.)

- [ ] **Step 4: Cost breakdown test**

Create `src/components/funding/__tests__/cost-breakdown.test.tsx`:

```typescript
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CostBreakdown } from "../cost-breakdown";
import type { CostLineItem } from "@shared/lib/funding/types";

const ITEMS: CostLineItem[] = [
  { label: "Ike", category: "team", usd_per_month: 1500 },
  { label: "Brice", category: "team", usd_per_month: 0, note: "Volunteer" },
  { label: "CoinGecko", category: "infra", usd_per_month: 129 },
];

describe("CostBreakdown", () => {
  it("renders categories with subtotals and total", () => {
    render(<CostBreakdown items={ITEMS} />);
    expect(screen.getByText(/Ike/)).toBeInTheDocument();
    expect(screen.getByText(/\$1,500/)).toBeInTheDocument();
    expect(screen.getByText(/Volunteer/)).toBeInTheDocument();
    expect(screen.getByText(/CoinGecko/)).toBeInTheDocument();
    expect(screen.getByText(/\$1,629/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Cost breakdown implementation**

Create `src/components/funding/cost-breakdown.tsx`:

```typescript
import type { CostCategory, CostLineItem } from "@shared/lib/funding/types";
import { computeMonthlyTotal, groupByCategory } from "@shared/lib/funding/cost-helpers";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const CATEGORY_LABELS: Record<CostCategory, string> = {
  team: "Team",
  infra: "Infrastructure",
};

export function CostBreakdown({ items }: { items: CostLineItem[] }) {
  const groups = groupByCategory(items);
  const total = computeMonthlyTotal(items);

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.category} className="space-y-2">
          <div className="flex items-baseline justify-between border-b border-border/60 pb-1">
            <p className="pharos-kicker text-amber-700 dark:text-amber-400">{CATEGORY_LABELS[group.category]}</p>
            <p className="text-xs text-muted-foreground">{USD.format(group.subtotal)}/m</p>
          </div>
          <ul className="space-y-1 text-sm">
            {group.items.map((item) => (
              <li key={item.label} className="flex items-baseline justify-between gap-3">
                <span className="text-foreground">
                  {item.label}
                  {item.note ? <span className="ml-2 text-xs text-muted-foreground">{item.note}</span> : null}
                </span>
                <span className="tabular-nums text-muted-foreground">{USD.format(item.usd_per_month)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="flex items-baseline justify-between border-t border-border/60 pt-2">
        <p className="text-sm font-medium text-foreground">Monthly total</p>
        <p className="text-sm font-medium tabular-nums text-foreground">{USD.format(total)}/m</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Donor wall test**

Create `src/components/funding/__tests__/donor-wall.test.tsx`:

```typescript
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DonorWall } from "../donor-wall";

describe("DonorWall", () => {
  it("renders donor displays and links to Etherscan", () => {
    render(
      <DonorWall
        donors={[
          { address: "0xabcdef0000000000000000000000000000000000", display: "alice.eth", total_usd: 250.5, most_recent_at: Math.floor(Date.now() / 1000) - 3600, etherscan_url: "https://etherscan.io/address/0xabc" },
        ]}
      />,
    );
    expect(screen.getByText(/alice.eth/)).toBeInTheDocument();
    expect(screen.getByText(/\$250\.50/)).toBeInTheDocument();
    expect(screen.getByText(/1h ago/)).toBeInTheDocument();
  });

  it("renders an empty state when no donors", () => {
    render(<DonorWall donors={[]} />);
    expect(screen.getByText(/No donations yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Donor wall implementation**

Create `src/components/funding/donor-wall.tsx`:

```typescript
import { ExternalLink } from "lucide-react";
import type { FundingDonorWallEntry } from "@shared/lib/funding/types";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function formatRelative(thenSec: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - thenSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function DonorWall({ donors }: { donors: FundingDonorWallEntry[] }) {
  if (donors.length === 0) {
    return <p className="text-sm text-muted-foreground">No donations yet. The first one will land here.</p>;
  }
  return (
    <ul className="space-y-2 text-sm">
      {donors.map((d) => (
        <li key={d.address} className="flex items-baseline justify-between gap-3">
          <a href={d.etherscan_url} target="_blank" rel="noopener noreferrer" className="pharos-focus-ring inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline">
            {d.display}
            <ExternalLink className="h-3 w-3" />
          </a>
          <span className="flex items-baseline gap-3 text-muted-foreground">
            <span className="tabular-nums">{USD.format(d.total_usd)}</span>
            <span className="text-xs">{formatRelative(d.most_recent_at)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 8: Run all component tests**

```bash
npx vitest run src/components/funding/__tests__/
```

Expected: 5 tests pass (1 KPI row + 1 cost breakdown + 2 donor wall).

- [ ] **Step 9: Commit**

```bash
git add src/components/funding/ src/lib/funding-config-shim.ts
git commit -m "feat(funding): KPI row, chart, cost breakdown, donor wall components"
```

---

## Task 16: Components — support CTAs + year-end horizon

**Files:**
- Create: `src/components/funding/support-ctas.tsx`
- Create: `src/components/funding/year-end-horizon.tsx`

- [ ] **Step 1: Support CTAs**

Create `src/components/funding/support-ctas.tsx`:

```typescript
"use client";

import { useState } from "react";
import Link from "next/link";
import { Copy, ExternalLink, Flag, GitBranch, Heart, Share2, Star, Wallet, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FeedbackModal } from "@/components/feedback-modal";
import { PHAROS_FUNDING_ENS, PHAROS_FUNDING_WALLET_DISPLAY } from "@/lib/funding-config-shim";

const GIVETH_URL = "https://giveth.io/project/pharos-watch:-transparent-stablecoins-analytics";
const GITHUB_URL = "https://github.com/TokenBrice/stablecoin-dashboard";
const SHARE_URL = "https://x.com/intent/tweet?text=" + encodeURIComponent("Pharos — independent stablecoin analytics, MIT-licensed, public good. https://pharos.watch");

function CtaCard({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof Wallet;
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col gap-2 rounded-xl border border-border/60 bg-background/40 p-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-foreground" />
        <p className="text-sm font-medium text-foreground">{title}</p>
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="mt-auto pt-2">{action}</div>
    </div>
  );
}

export function SupportCtas() {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <CtaCard
            icon={Wallet}
            title="Send crypto"
            description={`${PHAROS_FUNDING_ENS} accepts ETH and ERC20 on Ethereum, Base, Optimism, Arbitrum, Polygon, and Gnosis.`}
            action={
              <Button
                type="button"
                variant="outline"
                className="min-h-9 w-full justify-between"
                onClick={async () => {
                  await navigator.clipboard.writeText(PHAROS_FUNDING_WALLET_DISPLAY);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                <span className="font-mono text-xs">{PHAROS_FUNDING_WALLET_DISPLAY}</span>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            }
          />
          <CtaCard
            icon={Heart}
            title="Donate via Giveth"
            description="Public good funding through Giveth — no platform fees on the project page."
            action={
              <Button asChild variant="outline" className="min-h-9 w-full justify-between">
                <a href={GIVETH_URL} target="_blank" rel="noopener noreferrer">
                  Open Giveth
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
            }
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <CtaCard
            icon={Star}
            title="Star the repo"
            description="Visibility helps Pharos reach the people who need it."
            action={
              <Button asChild variant="outline" className="min-h-9 w-full justify-between">
                <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                  GitHub
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
            }
          />
          <CtaCard
            icon={Share2}
            title="Share Pharos"
            description="Pass it to anyone who tracks stablecoin risk."
            action={
              <Button asChild variant="outline" className="min-h-9 w-full justify-between">
                <a href={SHARE_URL} target="_blank" rel="noopener noreferrer">
                  Share
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
            }
          />
          <CtaCard
            icon={Wrench}
            title="Contribute"
            description="MIT-licensed. Issues and PRs welcome."
            action={
              <Button asChild variant="outline" className="min-h-9 w-full justify-between">
                <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noopener noreferrer">
                  <GitBranch className="h-3.5 w-3.5" />
                  Open issues
                </a>
              </Button>
            }
          />
          <CtaCard
            icon={Flag}
            title="Flag bad data"
            description="See something off? Send a quick report."
            action={
              <Button type="button" variant="outline" className="min-h-9 w-full justify-between" onClick={() => setFeedbackOpen(true)}>
                Open feedback
                <Flag className="h-3.5 w-3.5" />
              </Button>
            }
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {copied ? "Copied to clipboard." : "All financial donations land at the same address regardless of chain. Giveth donations route through their pool contract — both surface on the wall."}
        </p>
      </div>
      <FeedbackModal open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </>
  );
}
```

- [ ] **Step 2: Update funding-config-shim**

Edit `src/lib/funding-config-shim.ts`:

```typescript
export const FUNDING_CHAIN_FRESHNESS_WARN_SECONDS = 36 * 60 * 60;
export const PHAROS_FUNDING_ENS = "pharos-watch.eth";
export const PHAROS_FUNDING_WALLET_DISPLAY = "0x5d698362EDb8AEa1C2b2483096BDeE3265D860DB";
```

- [ ] **Step 3: Year-end horizon**

Create `src/components/funding/year-end-horizon.tsx`:

```typescript
export function YearEndHorizon() {
  return (
    <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
      <p>
        Pharos&apos;s goal is to fund itself by the end of 2026 without subsidy from its founder.
        Today, that gap is covered out of pocket. The chart and KPIs above are the honest scoreboard
        — community support narrows the gap, the founder line narrows alongside it.
      </p>
      <p className="text-xs">
        No campaign. No deadline pressure. Just the math.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/funding/support-ctas.tsx src/components/funding/year-end-horizon.tsx src/lib/funding-config-shim.ts
git commit -m "feat(funding): support CTAs + year-end horizon copy block"
```

---

## Task 17: Page — `/funding/page.tsx`

**Files:**
- Create: `src/app/funding/page.tsx`
- Create: `src/app/funding/funding-page-client.tsx`
- Create: `src/app/funding/error.tsx`

- [ ] **Step 1: Server component shell with metadata**

Create `src/app/funding/page.tsx`:

```typescript
import type { Metadata } from "next";
import { FundingPageClient } from "./funding-page-client";
import { FeaturePageShell } from "@/components/feature-page-shell";

export const metadata: Metadata = {
  title: "Funding — Pharos",
  description: "How Pharos sustains itself: live donations, monthly costs, and the path to project sustainability.",
  robots: { index: false, follow: false }, // stealth release — not indexed in v1
  alternates: { canonical: "/funding/" },
};

export default function FundingPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Funding"
      path="/funding/"
      title="Funding"
      leadParagraphs={[
        "Pharos is a public good. This page is the honest ledger: what it costs, what supporters cover, and where we are on the path to sustainability.",
      ]}
    >
      <FundingPageClient />
    </FeaturePageShell>
  );
}
```

- [ ] **Step 2: Client component**

Create `src/app/funding/funding-page-client.tsx`:

```typescript
"use client";

import { useFundingSummary } from "@/hooks/use-funding-summary";
import { FundingKpiRow } from "@/components/funding/funding-kpi-row";
import { FundingMonthlyChart } from "@/components/funding/funding-monthly-chart";
import { CostBreakdown } from "@/components/funding/cost-breakdown";
import { DonorWall } from "@/components/funding/donor-wall";
import { SupportCtas } from "@/components/funding/support-ctas";
import { YearEndHorizon } from "@/components/funding/year-end-horizon";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function FundingPageClient() {
  const { data, isLoading, error } = useFundingSummary();

  if (isLoading) return <FundingPageSkeleton />;
  if (error || !data) return <p className="text-sm text-muted-foreground">Funding data is temporarily unavailable.</p>;

  return (
    <div className="space-y-6">
      <FundingKpiRow kpis={data.kpis} />
      <Card className="rounded-xl">
        <CardContent className="p-4">
          <FundingMonthlyChart series={data.monthly_series} chainFreshness={data.chain_freshness} lastSyncedAt={data.last_synced_at} />
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="rounded-xl border-l-[3px] border-l-amber-500">
          <CardHeader>
            <CardTitle as="h2">Where the money goes</CardTitle>
          </CardHeader>
          <CardContent>
            <CostBreakdown items={data.line_items} />
          </CardContent>
        </Card>
        <Card className="rounded-xl border-l-[3px] border-l-emerald-500">
          <CardHeader>
            <CardTitle as="h2">Recent supporters</CardTitle>
          </CardHeader>
          <CardContent>
            <DonorWall donors={data.recent_donors} />
          </CardContent>
        </Card>
      </div>
      <Card className="rounded-xl border-l-[3px] border-l-frost-blue">
        <CardHeader>
          <CardTitle as="h2">Support Pharos</CardTitle>
        </CardHeader>
        <CardContent>
          <SupportCtas />
        </CardContent>
      </Card>
      <Card className="rounded-xl border-l-[3px] border-l-violet-500">
        <CardHeader>
          <CardTitle as="h2">Where we're going</CardTitle>
        </CardHeader>
        <CardContent>
          <YearEndHorizon />
        </CardContent>
      </Card>
    </div>
  );
}

function FundingPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-muted/40" />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-xl bg-muted/40" />
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="h-48 animate-pulse rounded-xl bg-muted/40" />
        ))}
      </div>
      <div className="h-32 animate-pulse rounded-xl bg-muted/40" />
    </div>
  );
}
```

- [ ] **Step 3: Error boundary**

Create `src/app/funding/error.tsx`:

```typescript
"use client";

export default function FundingErrorBoundary() {
  return (
    <div className="mx-auto max-w-2xl p-6 text-sm text-muted-foreground">
      <p>Funding data is temporarily unavailable. Please try again shortly.</p>
    </div>
  );
}
```

- [ ] **Step 4: Build**

```bash
npm run build 2>&1 | tail -20
```

Expected: build completes; `/funding` listed in the route output.

- [ ] **Step 5: Commit**

```bash
git add src/app/funding/
git commit -m "feat(funding): /funding page wiring (server + client + error boundary)"
```

---

## Task 18: Documentation

**Files:**
- Create: `docs/funding-page.md`
- Modify: `docs/api-reference.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Funding page methodology doc**

Create `docs/funding-page.md`:

```markdown
# Funding page methodology

The `/funding` page is the public ledger of Pharos's running costs and the donations that cover them. Stealth-released — not yet linked from primary navigation.

## Pricing methodology

USD conversion of inbound on-chain donations is pinned for reproducibility:

- **Endpoint:** `https://pro-api.coingecko.com/api/v3/coins/{id}/history?date=DD-MM-YYYY&localization=false`, returning `market_data.current_price.usd`.
- **Granularity:** daily UTC close. Intraday volatility is **not** captured — a donation received at 23:55 UTC on day D is priced at the day-D close, not day-D+1.
- **Timezone:** all `block_timestamp` values, monthly aggregations (`YYYY-MM`), and price-cache `price_date` keys are UTC. No local-time conversions anywhere.
- **Asset key:** `<chain>:<asset_address|native>` lowercased. Token contract addresses are mapped to CoinGecko coin ids via the asset-platform endpoint; native assets use a per-chain coin id table.
- **Fallback:** if the historical endpoint returns no usable price, the pipeline falls back to the current spot price and tags `price_source = "coingecko-spot-fallback"`. If both fail, the row stores `usd_at_receipt = 0` and is flagged as spam.

## Data ingestion

- Daily cron (`sync-funding-donations`) fires at 07:00 UTC, isolated trigger.
- Each chain processed sequentially under Cloudflare's 6-connection budget; per-chain failure does not abort siblings.
- `funding_chain_sync` records per-chain freshness + cursor + last error; the `chain_freshness` field on the API surfaces it to the page.
- ENS reverse resolution is forward-verified: a name is displayed only when forward resolution returns the same address (standard practice against spoofed reverse records). Cache TTL is 30 days.

## Source code

- Worker subsystem: `worker/src/lib/funding/`, `worker/src/cron/sync-funding-donations.ts`, `worker/src/api/funding-summary.ts`
- Frontend: `src/app/funding/`, `src/components/funding/`, `src/hooks/use-funding-summary.ts`
- Manual data: `shared/data/funding/cost-line-items.json`, `donor-labels.json`, `spam-denylist.json`
- D1 schema: `worker/migrations/0106_funding_tables.sql`

## Spec & history

- Spec: `agents/plans/2026-04-18-funding-page-design.md`
- Implementation plan: `agents/plans/2026-04-18-funding-page-implementation-plan.md`
```

- [ ] **Step 2: Update api-reference.md**

Read `docs/api-reference.md` first. Add a new entry following the existing format:

```markdown
### `GET /api/funding-summary`

Returns the entire `/funding` page payload: KPIs, trailing-12-month series, cost line items, top-20 most-recent ENS-resolved donors, and per-chain freshness.

**Cron:** `sync-funding-donations` runs daily at 07:00 UTC.

**Response:** `FundingSummaryResponse` (see `shared/lib/funding/types.ts`).
```

- [ ] **Step 3: Update architecture.md**

Read `docs/architecture.md` first. Add a short section under the existing subsystem list:

```markdown
### Funding subsystem

A daily worker cron (`sync-funding-donations`) ingests inbound transfers to `pharos-watch.eth` across 6 chains (Ethereum/Base/OP/Arbitrum/Polygon via Alchemy `getAssetTransfers`, Gnosis via Gnosisscan REST). Donations are USD-priced via CoinGecko historical (cached in D1) and aggregated monthly into `funding_monthly`. Per-chain freshness lives in `funding_chain_sync`. The `/api/funding-summary` endpoint serves the entire `/funding` page payload from D1. See `docs/funding-page.md` for the pricing methodology.
```

- [ ] **Step 4: Commit**

```bash
git add docs/funding-page.md docs/api-reference.md docs/architecture.md
git commit -m "docs(funding): page methodology + api-reference + architecture entries"
```

---

## Task 19: Pre-deploy live smoke + merge gate

**Files:** none changed; verification only.

- [ ] **Step 1: Run the merge gate**

```bash
npm run test:merge-gate
```

Expected: passes. Fix any failures locally before continuing.

- [ ] **Step 2: Smoke-test the live Alchemy + Gnosisscan endpoints against the wallet**

```bash
ADDR="0x5d698362edb8aea1c2b2483096bdee3265d860db"
curl -sS "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"alchemy_getAssetTransfers\",\"params\":[{\"toAddress\":\"$ADDR\",\"category\":[\"external\",\"internal\",\"erc20\"]}]}" \
  | jq '.result.transfers | length'
curl -sS "https://api.gnosisscan.io/api?module=account&action=tokentx&address=$ADDR&apikey=$GNOSISSCAN_API_KEY" | jq '.status'
```

Expected: Alchemy returns at least 1 (the known inbound tx); Gnosisscan returns `"1"` or `"0"` (status field is present and the response shape matches the parser).

- [ ] **Step 3: Run the cron locally end-to-end**

```bash
cd worker && npx wrangler dev
# In a second shell:
curl -X POST http://localhost:8787/__scheduled?cron=0+7+*+*+*
```

Expected: Worker logs include `[funding] sync complete:` with `per_chain` entries for all 6 chains.

- [ ] **Step 4: Verify the API**

```bash
curl -s http://localhost:8787/api/funding-summary | jq '{ kpis, recent_donor_count: (.recent_donors | length), chain_freshness_count: (.chain_freshness | length) }'
```

Expected: `recent_donor_count >= 1`, `chain_freshness_count == 6`, and `kpis.current_month_target_usd == 1676.85`.

- [ ] **Step 5: Smoke-test the page in the browser**

```bash
npm run dev
# Visit http://localhost:3000/funding
```

Expected: page renders with 3 KPI cards, monthly chart (sparse, 1 data point), cost breakdown matching the JSON, donor wall with one entry (Brice's labeled address if Task 12 was completed), CTAs functional, no console errors.

- [ ] **Step 6: Commit any final fixes (if applicable)**

If browser testing surfaced display issues, fix and commit:

```bash
git add <changed-files>
git commit -m "fix(funding): <specific issue>"
```

If no changes, skip this step.

---

## Done

The `/funding` page is live behind the URL only — no nav entry, `robots: noindex` for stealth release. After validation, follow up with:

1. Add `/funding` to `src/app/about/page.tsx` `AboutFeatureRow`
2. Optionally add a footer link
3. Remove `robots: noindex` if you want it indexed
4. Refresh `donor-labels.json` whenever a known supporter wants a label
5. Append to `spam-denylist.json` whenever airdrop noise appears
