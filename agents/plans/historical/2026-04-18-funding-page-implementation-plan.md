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
-- rollout-safety: backward-compatible
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

-- Seed each chain with a recent-but-safe starting block so the first prod run
-- doesn't paginate through years of empty history. The exact block is captured
-- at deployment time using a current-block lookup minus a 30-day rewind.
-- (Pharos's funding wallet has only one inbound tx today so this is purely
-- defensive — see Task 11 Step 7.)

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

Open `worker/migrations/MANIFEST.md` and add a new row to the table matching the existing columns exactly. Read the file first to copy the precise column set used by the 0105 row (typical columns: number, filename, description, rollout-safety, date) — do not guess the shape. The description should be: `Funding subsystem tables (donations, monthly, ens_cache, chain_sync, price_cache).` Rollout-safety = `backward-compatible` (all five tables are additive, no existing data touched).

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

export interface CostLineItemsFile {
  /** UTC unix seconds of the last reviewer sign-off. Surfaced on the page
   *  footer so readers can see cost snapshot freshness. Updated manually
   *  on the 1st of each month per the ownership cadence in docs/funding-page.md. */
  last_reviewed_at: number | null;
  items: CostLineItem[];
}

export type DonorKind = "founder" | "pool" | "supporter";

export interface DonorLabel {
  address: string; // lowercased
  label: string;
  /** Drives donor-count and chart-segregation behavior in the API:
   *  - "founder" rows are excluded from distinct_donors_lifetime, the
   *    community_donations_usd series, and the donor wall, but kept
   *    visible in the chart as a separate stacked layer.
   *  - "pool" rows count as community.
   *  - "supporter" or undefined behaves as community (default).
   */
  kind?: DonorKind;
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
  /** Community-only coverage %: community_usd / target * 100.
   *  NEVER includes founder subsidy — including it would make this KPI
   *  always read ~100% because the founder closes the gap. Capped at 100%
   *  in the renderer (not the API) when community > target. */
  current_month_coverage_pct: number;
  current_month_community_usd: number; // excludes founder subsidy
  current_month_founder_subsidy_usd: number; // this month's founder-labeled inflow
  /** max(0, target - community). Equals this month's founder subsidy until
   *  community surpasses target, at which point it is zero. Surfaced
   *  explicitly on the KPI card and in the cost-breakdown footer; never
   *  derived-but-hidden. */
  current_month_uncovered_usd: number;
  current_month_target_usd: number;
  /** Community-only trailing 3-month coverage %: average(community_usd / costs_usd * 100) over 3 months. */
  trailing_3mo_avg_coverage_pct: number;
  total_community_lifetime_usd: number; // excludes founder subsidy
  total_founder_subsidy_usd: number;
  distinct_community_donors_lifetime: number; // excludes founder
  /** True when lifetime community donations are zero; the page renders
   *  "No community donations yet" / "Tracking begins" copy branches. */
  is_cold_start: boolean;
}

export interface FundingMonthlyPoint {
  month: string;
  community_donations_usd: number;
  founder_subsidy_usd: number;
  /** Per-month cost snapshot. The chart renders this as a `stepAfter` line
   *  so months with different historical costs render honestly. Finalized
   *  months hold the cost snapshot at close; the current month reflects
   *  today's cost-line-items.json. */
  costs_usd: number;
  donor_count: number; // distinct community donors that month (excludes founder)
}

export interface FundingDonorWallEntry {
  address: string;
  display: string; // ENS, custom label, or truncated address
  total_usd: number;
  most_recent_at: number;
  most_recent_chain: FundingChain;
  explorer_url: string; // chain-aware (Etherscan, Basescan, Polygonscan, etc.)
}

export interface FundingSummaryMeta {
  /** Methodology version; bump monotonically when pricing, spam filter, or
   *  attribution rules change materially (see CLAUDE.md: numeric, not semver). */
  funding_methodology_version: number;
  /** UTC unix seconds; driven by `last_reviewed_at` field in cost-line-items.json.
   *  Surfaced on the page so readers can see how fresh the cost snapshot is. */
  cost_last_reviewed_at: number | null;
}

export interface FundingSummaryResponse {
  kpis: FundingKpis;
  monthly_series: FundingMonthlyPoint[];
  line_items: CostLineItem[];
  recent_donors: FundingDonorWallEntry[];
  chain_freshness: ChainFreshnessEntry[];
  last_synced_at: number;
  _meta: FundingSummaryMeta;
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
{
  "last_reviewed_at": 1744934400,
  "items": [
    { "label": "Ike", "category": "team", "usd_per_month": 1500, "note": "Growth & comms" },
    { "label": "Brice", "category": "team", "usd_per_month": 0, "note": "Uncompensated until Pharos is self-funded" },
    { "label": "CoinGecko API", "category": "infra", "usd_per_month": 129, "note": "Analyst tier" },
    { "label": "Alchemy", "category": "infra", "usd_per_month": 40, "note": "Pay-as-you-go, ~$40 typical" },
    { "label": "Cloudflare Workers", "category": "infra", "usd_per_month": 5, "note": "Paid plan" },
    { "label": "Domain registration", "category": "infra", "usd_per_month": 2.85, "note": "pharos.watch, annualized" }
  ]
}
```

(`last_reviewed_at` is a UTC unix-seconds value; set to a real recent timestamp at deploy time. The page surfaces this as "Costs last reviewed: MMM YYYY" per the docs ownership cadence.)

Create `shared/data/funding/donor-labels.json`:

```json
[]
```

(Brice's EOA with `kind: "founder"` + Giveth pool with `kind: "pool"` are added at implementation review time — see Task 12.)

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

## Task 3: Shared funding constants + worker spam filter

**Files:**
- Create: `shared/lib/funding/constants.ts` (runtime-neutral — imported from both worker and frontend)
- Create: `worker/src/lib/funding/spam-filter.ts`
- Test: `worker/src/lib/funding/__tests__/spam-filter.test.ts`

**Why shared, not worker-local:** the wallet/ENS/freshness constants are consumed by both the worker (config + cron) and the frontend (support CTAs). Duplicating them in `worker/src/lib/funding/config.ts` + `src/lib/funding-config-shim.ts` invites silent drift — if the wallet ever changes, only one side is updated and the CTA copy lies. Put them in `shared/lib/funding/constants.ts` once.

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

- [ ] **Step 3: Implement shared constants**

Create `shared/lib/funding/constants.ts`:

```typescript
export const PHAROS_FUNDING_WALLET = "0x5d698362edb8aea1c2b2483096bdee3265d860db";
/** EIP-55 checksummed form, for display in the UI. The lowercased version above
 *  is what the DB stores and what address comparisons use. */
export const PHAROS_FUNDING_WALLET_DISPLAY = "0x5d698362EDb8AEa1C2b2483096BDeE3265D860DB";
export const PHAROS_FUNDING_ENS = "pharos-watch.eth";
export const FUNDING_ENS_TTL_SECONDS = 30 * 24 * 60 * 60;
export const FUNDING_CHAIN_FRESHNESS_WARN_SECONDS = 36 * 60 * 60;
export const FUNDING_ENS_RESOLUTIONS_PER_RUN_CAP = 50;
```

There is no separate `worker/src/lib/funding/config.ts` — other worker modules import these directly from `@shared/lib/funding/constants`. The plan intentionally does NOT roll its own per-chain explorer URL builder: all explorer links use `buildExplorerUrl()` from `shared/lib/explorer.ts` (already in the repo, covers all 6 chains, keeps the canonical list in one place). If `buildExplorerUrl` doesn't already cover Gnosis, add a case there — it's a single-line edit — rather than duplicating the map here.

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
git add shared/lib/funding/constants.ts worker/src/lib/funding/spam-filter.ts worker/src/lib/funding/__tests__/spam-filter.test.ts
git commit -m "feat(funding): shared constants and worker spam-token filter"
```

---

## Task 4: CoinGecko historical pricing with cache

**Files:**
- Create: `worker/src/lib/funding/coingecko-historical.ts`
- Test: `worker/src/lib/funding/__tests__/coingecko-historical.test.ts`

**CoinGecko plan detection (read first):** The repo already authenticates against CoinGecko in `worker/src/lib/coingecko.ts` and `worker/src/lib/coingecko-market-history.ts` via `normalizeCgApiKey` + an existing `buildCoingeckoRequest` helper that routes to `pro-api.coingecko.com` with `x-cg-pro-api-key` for Pro keys and `api.coingecko.com` with `x-cg-demo-api-key` for Demo/Analyst keys. The `/coins/{id}/history` endpoint is present on BOTH tiers (it is a public v3 endpoint) but the **host and auth-header differ** by plan.

Before writing new code, read `worker/src/lib/coingecko.ts` to confirm the exact helper name and signature, then reuse it here. Do not hand-roll `https://pro-api.coingecko.com/...` URLs with a hardcoded `x-cg-pro-api-key` header — that breaks on Demo keys.

**Pricing whitelist (security):** Pricing only runs for a known-good asset set; every other ERC20 routes to `price_source='zero-no-price'` with `usd_at_receipt = 0` and is excluded from dollar totals via `WHERE usd_at_receipt > 0`. This prevents a spam token with a spoofed ticker (attacker deploys "USDC" at a custom address) from getting a bogus CoinGecko match cached into `funding_price_cache`. Expansion of the whitelist is a reviewed code change, not a JSON edit. See `worker/src/lib/funding/coingecko-historical.ts` `PRICED_ASSETS` constant below.

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

  it("returns zero-no-price for an unknown ERC20 without calling CoinGecko", async () => {
    const fakeDb = makeFakeDb();
    const fetchMock = vi.fn();
    const result = await fetchUsdPriceHistorical(
      fakeDb as unknown as D1Database,
      "ethereum:0xdeadbeef00000000000000000000000000000000", // not in PRICED_ASSETS
      "18-04-2026",
      "ethereum",
      fetchMock as never,
      "key",
    );
    expect(result.usdPrice).toBe(0);
    expect(result.source).toBe("zero-no-price");
    expect(fetchMock).not.toHaveBeenCalled();
    // Zero row written so subsequent calls hit cache.
    expect(fakeDb.writes.length).toBe(1);
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
import { buildCoingeckoRequest } from "../coingecko";
import { cancelResponseBodyQuietly } from "../response-body";

export interface PriceLookupResult {
  usdPrice: number;
  source: "coingecko-historical" | "coingecko-spot-fallback" | "zero-no-price";
}

/**
 * Pricing whitelist. Only assets in this table get CoinGecko lookups; every
 * other ERC20 defaults to `price_source='zero-no-price'`. Expanding this
 * whitelist is a reviewed code change, not a JSON edit, to prevent spoofed
 * spam tokens (attacker-deployed "USDC" at a custom address) from getting
 * a bogus market_data.current_price.usd cached into the price cache.
 *
 * Keys are (chain, asset_address|null) normalized. Native assets use null.
 */
const PRICED_ASSETS: Record<string, string> = {
  // Native assets
  "ethereum:native": "ethereum",
  "base:native": "ethereum",
  "optimism:native": "ethereum",
  "arbitrum:native": "ethereum",
  "polygon:native": "matic-network",
  "gnosis:native": "xdai",
  // ETH — WETH
  "ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "weth",
  "base:0x4200000000000000000000000000000000000006": "weth",
  "optimism:0x4200000000000000000000000000000000000006": "weth",
  "arbitrum:0x82af49447d8a07e3bd95bd0d56f35241523fbab1": "weth",
  "polygon:0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": "weth",
  // USDC
  "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "usd-coin",
  "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "usd-coin",
  "optimism:0x0b2c639c533813f4aa9d7837caf62653d097ff85": "usd-coin",
  "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831": "usd-coin",
  "polygon:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": "usd-coin",
  "gnosis:0x2a22f9c3b484c3629090feed35f17ff8f88f76f0": "usd-coin",
  // USDT
  "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7": "tether",
  "optimism:0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": "tether",
  "arbitrum:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": "tether",
  "polygon:0xc2132d05d31c914a87c6611c10748aeb04b58e8f": "tether",
  // DAI
  "ethereum:0x6b175474e89094c44da98b954eedeac495271d0f": "dai",
  "base:0x50c5725949a6f0c72e6c4a641f24049a917db0cb": "dai",
  "optimism:0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": "dai",
  "arbitrum:0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": "dai",
  "polygon:0x8f3cf7ad23cd3cadbd9735aff958023239c6a063": "dai",
  "gnosis:0x44fa8e6f47987339850636f88629646662444217": "dai",
  // WBTC
  "ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "wrapped-bitcoin",
  "arbitrum:0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": "wrapped-bitcoin",
  "polygon:0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6": "wrapped-bitcoin",
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
 * Methodology: CoinGecko `/coins/{id}/history?date=DD-MM-YYYY` returning `market_data.current_price.usd`.
 * Cached per (asset_key, price_date) in funding_price_cache.
 * Only priced for assets in PRICED_ASSETS; every other asset returns zero-no-price.
 */
export async function fetchUsdPriceHistorical(
  db: D1Database,
  assetKey: string,
  priceDate: string,
  chain: FundingChain,
  fetchImpl: typeof fetch,
  coingeckoApiKey: string,
): Promise<PriceLookupResult> {
  const cached = await db
    .prepare("SELECT usd_price, source FROM funding_price_cache WHERE asset_key = ? AND price_date = ?")
    .bind(assetKey, priceDate)
    .first<CachedRow>();
  if (cached) {
    return { usdPrice: cached.usd_price, source: cached.source as PriceLookupResult["source"] };
  }

  const coinId = PRICED_ASSETS[assetKey];
  if (!coinId) {
    await writeCache(db, assetKey, priceDate, 0, "zero-no-price");
    return { usdPrice: 0, source: "zero-no-price" };
  }

  // `buildCoingeckoRequest` (existing in `worker/src/lib/coingecko.ts`) picks
  // the correct host (pro-api vs api) and auth header based on the key type.
  const histReq = buildCoingeckoRequest(
    `/coins/${coinId}/history?date=${priceDate}&localization=false`,
    coingeckoApiKey,
  );
  let histResp: Response | null = null;
  try {
    histResp = await fetchImpl(histReq.url, { headers: histReq.headers });
    if (!histResp.ok) {
      cancelResponseBodyQuietly(histResp);
      histResp = null;
      return await fallbackToSpot(db, assetKey, priceDate, coinId, fetchImpl, coingeckoApiKey);
    }
    const histPayload = (await histResp.json()) as { market_data?: { current_price?: { usd?: number } } };
    histResp = null;
    const usdPrice = histPayload.market_data?.current_price?.usd;
    if (typeof usdPrice !== "number" || !Number.isFinite(usdPrice) || usdPrice <= 0) {
      return await fallbackToSpot(db, assetKey, priceDate, coinId, fetchImpl, coingeckoApiKey);
    }
    await writeCache(db, assetKey, priceDate, usdPrice, "coingecko-historical");
    return { usdPrice, source: "coingecko-historical" };
  } finally {
    if (histResp) cancelResponseBodyQuietly(histResp);
  }
}

async function fallbackToSpot(
  db: D1Database,
  assetKey: string,
  priceDate: string,
  coinId: string,
  fetchImpl: typeof fetch,
  coingeckoApiKey: string,
): Promise<PriceLookupResult> {
  const spotReq = buildCoingeckoRequest(
    `/simple/price?ids=${coinId}&vs_currencies=usd`,
    coingeckoApiKey,
  );
  let spotResp: Response | null = null;
  try {
    spotResp = await fetchImpl(spotReq.url, { headers: spotReq.headers });
    if (!spotResp.ok) {
      cancelResponseBodyQuietly(spotResp);
      spotResp = null;
      await writeCache(db, assetKey, priceDate, 0, "zero-no-price");
      return { usdPrice: 0, source: "zero-no-price" };
    }
    const spotPayload = (await spotResp.json()) as Record<string, { usd?: number }>;
    spotResp = null;
    const spot = spotPayload[coinId]?.usd;
    if (typeof spot !== "number" || !Number.isFinite(spot) || spot <= 0) {
      await writeCache(db, assetKey, priceDate, 0, "zero-no-price");
      return { usdPrice: 0, source: "zero-no-price" };
    }
    await writeCache(db, assetKey, priceDate, spot, "coingecko-spot-fallback");
    return { usdPrice: spot, source: "coingecko-spot-fallback" };
  } finally {
    if (spotResp) cancelResponseBodyQuietly(spotResp);
  }
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
```

(Verify `buildCoingeckoRequest` name/signature against the current `worker/src/lib/coingecko.ts` at implementation time — if the helper is named differently, use the actual export. The important property is that it handles the Pro-vs-Demo host/header split the repo already encodes.)

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

- [ ] **Step 3: Verify the Universal Resolver deployment and ABI against a known address**

The Universal Resolver contract is versioned; the wrong address or version will decode garbage without throwing. Before pinning, verify the contract + ABI work end-to-end against vitalik.eth (`0xd8da6bf26964af9d7eed9e03e53415d37aa96045`, forward resolves to `vitalik.eth`):

```bash
ALCHEMY_ETH_RPC="https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY"
curl -sS "$ALCHEMY_ETH_RPC" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"<CANDIDATE_UNIVERSAL_RESOLVER>","data":"<abi-encoded reverse(bytes) call>"},"latest"]}' \
  > worker/src/lib/funding/__tests__/fixtures/universal-resolver-vitalik.json
```

Capture the response as a committed fixture and the resolver address + ABI at verification time. If the response decodes cleanly to `(name="vitalik.eth", resolvedAddress=0xd8da...)`, pin that address; if not, consult https://docs.ens.domains/resolution/universal-resolver for the current canonical deployment. Add an integration test that loads this fixture and asserts decode round-trips — so future address/ABI changes fail loud rather than silently returning no names.

- [ ] **Step 4: Implement using ENS Universal Resolver**

The Universal Resolver's `reverse(bytes lookupAddress)` returns name + forward-verified address in one call, eliminating the two extra eth_calls (registry → resolver → addr) and the spoofing window between them. We also reuse `viem` (already a worker dep — verify with `cd worker && npm ls viem`) for `namehash` and `keccak256` instead of adding `js-sha3`.

Create `worker/src/lib/funding/ens-resolver.ts`:

```typescript
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";

/**
 * Forward-verified ENS resolution via the ENS Universal Resolver on Ethereum L1.
 *
 * The Universal Resolver's `reverse(bytes lookupAddress)` returns
 * `(string name, address resolvedAddress, address reverseResolver, address resolver)`
 * — the forward verification is built in: a name is verified iff
 * `resolvedAddress == lookupAddress`.
 *
 * This is one eth_call per address (vs three for manual reverse + registry +
 * resolver.addr) and removes the spoofing race between calls.
 */

// Canonical Universal Resolver on Ethereum mainnet (deployed by ENS Labs).
// Verify against https://docs.ens.domains/resolution/universal-resolver before pinning.
const ENS_UNIVERSAL_RESOLVER = "0xc0497E381f536Be9ce14B0dD3817cBcAe57d2F62";

const REVERSE_ABI = parseAbi([
  "function reverse(bytes lookupAddress) view returns (string name, address resolvedAddress, address reverseResolver, address resolver)",
]);

export interface EnsResolution {
  ensName: string | null;
  forwardVerified: 0 | 1;
}

export async function resolveEnsForwardVerified(
  address: string,
  fetchImpl: typeof fetch,
  ethRpcUrl: string,
): Promise<EnsResolution> {
  const lower = address.toLowerCase();
  const lookupBytes = ("0x" + lower.replace(/^0x/, "")) as `0x${string}`;
  const data = encodeFunctionData({
    abi: REVERSE_ABI,
    functionName: "reverse",
    args: [lookupBytes],
  });
  const result = await ethCall(fetchImpl, ethRpcUrl, ENS_UNIVERSAL_RESOLVER, data);
  if (!result) return { ensName: null, forwardVerified: 0 };

  let decoded: readonly [string, `0x${string}`, `0x${string}`, `0x${string}`];
  try {
    decoded = decodeFunctionResult({
      abi: REVERSE_ABI,
      functionName: "reverse",
      data: result as `0x${string}`,
    }) as typeof decoded;
  } catch {
    return { ensName: null, forwardVerified: 0 };
  }

  const [name, resolvedAddress] = decoded;
  if (!name || resolvedAddress.toLowerCase() !== lower) {
    return { ensName: null, forwardVerified: 0 };
  }
  return { ensName: name, forwardVerified: 1 };
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
  if (!payload.result || payload.result === "0x" || payload.error) return null;
  return payload.result;
}
```

- [ ] **Step 5: Verify viem is already a dep**

```bash
cd worker && npm ls viem 2>&1 | head -3
```

Expected: shows a viem version (already a dep). If absent, add it:

```bash
cd worker && npm install viem
```

(Do **not** add `js-sha3` — viem covers everything we need here, and bundle size matters in workers.)

- [ ] **Step 6: Adjust the test fixture encoding**

The test in Step 1 was written assuming a 3-call flow. Rewrite the test for the Universal Resolver (one call returning ABI-encoded `(string, address, address, address)`):

```typescript
import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { resolveEnsForwardVerified } from "../ens-resolver";

const ADDR = "0x5d698362edb8aea1c2b2483096bdee3265d860db";

function encodeReverseResult(name: string, resolved: string): string {
  return encodeAbiParameters(
    parseAbiParameters("string, address, address, address"),
    [name, resolved as `0x${string}`, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"],
  );
}

describe("resolveEnsForwardVerified", () => {
  it("returns null when the resolver returns 0x or errors", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), { status: 200 }));
    const out = await resolveEnsForwardVerified(ADDR, fetchImpl as unknown as typeof fetch, "https://rpc");
    expect(out).toEqual({ ensName: null, forwardVerified: 0 });
  });

  it("returns name when forward resolution matches", async () => {
    const result = encodeReverseResult("pharos-watch.eth", ADDR);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 }));
    const out = await resolveEnsForwardVerified(ADDR, fetchImpl as unknown as typeof fetch, "https://rpc");
    expect(out).toEqual({ ensName: "pharos-watch.eth", forwardVerified: 1 });
  });

  it("rejects forward mismatch (spoofed reverse record)", async () => {
    const result = encodeReverseResult("attacker.eth", "0x1111111111111111111111111111111111111111");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 }));
    const out = await resolveEnsForwardVerified(ADDR, fetchImpl as unknown as typeof fetch, "https://rpc");
    expect(out).toEqual({ ensName: null, forwardVerified: 0 });
  });
});
```

- [ ] **Step 7: Run test to verify it passes**

```bash
cd worker && npx vitest run src/lib/funding/__tests__/ens-resolver.test.ts
```

Expected: PASS, 3 tests + 1 fixture round-trip test (from Step 3).

- [ ] **Step 8: Commit**

```bash
git add worker/src/lib/funding/ens-resolver.ts worker/src/lib/funding/__tests__/
git commit -m "feat(funding): forward-verified ENS resolver via Universal Resolver"
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
    const transfers = await fetchAlchemyTransfersTo(fetchImpl as unknown as typeof fetch, "https://rpc", "0x5d69", "0x0", "ethereum");
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
import { cancelResponseBodyQuietly } from "../response-body";

export interface AlchemyTransferRaw {
  /** Alchemy-assigned stable id of the form `<hash>:log:<n>` for ERC20 and
   *  `<hash>:external` / `<hash>:internal` for native. Used to build a stable
   *  log_index that survives reordering across paginated fetches. */
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
  log_index: number;
  block_number: number;
  block_timestamp: number;
  from_address: string;
  asset_symbol: string;
  asset_address: string | null;
  amount_decimal: number;
  category: AlchemyTransferRaw["category"];
}

/**
 * Per-chain Alchemy category support.
 *
 * `internal` is only supported on Ethereum, Arbitrum, and Base. Sending
 * `category: ["external","internal","erc20"]` to Optimism or Polygon will
 * error with `invalid category`, and the per-chain failure isolation would
 * record that error every day until the categories are fixed. Keep this map
 * authoritative and covered by a test.
 */
const CATEGORIES_BY_CHAIN: Record<FundingChain, Array<"external" | "internal" | "erc20">> = {
  ethereum: ["external", "internal", "erc20"],
  base: ["external", "internal", "erc20"],
  arbitrum: ["external", "internal", "erc20"],
  optimism: ["external", "erc20"],
  polygon: ["external", "erc20"],
  gnosis: ["external", "erc20"], // not routed through Alchemy, but harmless to list here
};

/** Hard cap on pagination pages per chain per run. Raised to an error so a
 *  silently-truncated fetch cannot advance the cursor past un-ingested rows.
 *  25 pages × 1000 transfers/page = 25,000 transfers per run. If hit, the
 *  error is recorded in `funding_chain_sync.last_error` and the next run
 *  retries from the same cursor. */
const PAGE_CAP = 25;

export async function fetchAlchemyTransfersTo(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  toAddress: string,
  fromBlockHex: string,
  chain: FundingChain,
): Promise<AlchemyTransferRaw[]> {
  const collected: AlchemyTransferRaw[] = [];
  let pageKey: string | undefined;
  for (let page = 0; page < PAGE_CAP; page += 1) {
    const params: Record<string, unknown> = {
      toAddress,
      category: CATEGORIES_BY_CHAIN[chain],
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
    let resp: Response | null = null;
    try {
      resp = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        resp = null;
        throw new Error(`alchemy_getAssetTransfers failed on ${chain} (${resp === null ? "?" : "?"}): ${text.slice(0, 200)}`);
      }
      const payload = (await resp.json()) as { result?: { transfers?: AlchemyTransferRaw[]; pageKey?: string }; error?: { message?: string } };
      resp = null;
      if (payload.error) throw new Error(`alchemy_getAssetTransfers error on ${chain}: ${payload.error.message ?? "unknown"}`);
      const transfers = payload.result?.transfers ?? [];
      collected.push(...transfers);
      pageKey = payload.result?.pageKey;
      if (!pageKey) return collected;
    } finally {
      if (resp) cancelResponseBodyQuietly(resp);
    }
  }
  // Hit the page cap; throw so the cron records an error and does NOT advance
  // the cursor past un-ingested rows on the next run.
  throw new Error(
    `alchemy_getAssetTransfers hit ${PAGE_CAP}-page cap on ${chain}; rerun or narrow fromBlock`,
  );
}

export function parseAlchemyTransfers(
  chain: FundingChain,
  raw: readonly AlchemyTransferRaw[],
): NormalizedTransfer[] {
  // Category prefixes keep (chain, tx_hash, log_index) unique across
  // external/internal/erc20 streams that can coexist in a single tx.
  // external  → 0
  // internal  → 1_000_000 + idx
  // erc20     → 2_000_000 + idx  (or parsed uniqueId log index when available)
  const CAT_OFFSET = { external: 0, internal: 1_000_000, erc20: 2_000_000 } as const;
  return raw.map((t, idx) => {
    const blockNumber = parseInt(t.blockNum, 16);
    const blockTimestamp = t.metadata?.blockTimestamp
      ? Math.floor(Date.parse(t.metadata.blockTimestamp) / 1000)
      : 0;
    // Prefer uniqueId-embedded log index when present and parseable; fall back
    // to category-prefixed position. uniqueId form is `<hash>:log:<n>` for
    // erc20; for external/internal it is `<hash>:external|internal`.
    let logIndex = CAT_OFFSET[t.category] + idx;
    if (t.uniqueId && t.category === "erc20") {
      const match = t.uniqueId.match(/:log:(\d+)$/);
      if (match) logIndex = CAT_OFFSET.erc20 + parseInt(match[1], 10);
    }
    return {
      chain,
      tx_hash: t.hash.toLowerCase(),
      log_index: logIndex,
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

Also add a test that asserts chain-specific categories are passed correctly and that pagination cap raises (not returns partial):

```typescript
it("passes external+erc20 only on Optimism (no 'internal')", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const fetchImpl = async (_url: string, opts: RequestInit) => {
    const body = JSON.parse(opts.body as string) as { params: [Record<string, unknown>] };
    captured.push(body.params[0]);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { transfers: [] } }), { status: 200 });
  };
  await fetchAlchemyTransfersTo(fetchImpl as unknown as typeof fetch, "https://rpc", "0x", "0x0", "optimism");
  expect(captured[0].category).toEqual(["external", "erc20"]);
});

it("throws when page cap is exceeded rather than returning partial", async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { transfers: [], pageKey: "next" } }),
      { status: 200 },
    );
  };
  await expect(
    fetchAlchemyTransfersTo(fetchImpl as unknown as typeof fetch, "https://rpc", "0x", "0x0", "ethereum"),
  ).rejects.toThrow(/page cap/);
  expect(call).toBe(25);
});
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
    expect(parseGnosisscanResults("tokentx", [])).toEqual([]);
  });

  it("normalizes tokentx rows into NormalizedTransfer shape", () => {
    const fx = loadFixture("tokentx");
    const rows = Array.isArray(fx.result) ? (fx.result as unknown[]) : [];
    const normalized = parseGnosisscanResults("tokentx", rows);
    if (rows.length > 0) {
      expect(normalized.length).toBeLessThanOrEqual(rows.length);
      expect(normalized[0]?.chain).toBe("gnosis");
      expect(normalized[0]?.asset_address).not.toBeNull();
    } else {
      expect(normalized).toEqual([]);
    }
  });

  it("normalizes txlist rows (native xDAI) and skips outbound", () => {
    const fx = loadFixture("txlist");
    const rows = Array.isArray(fx.result) ? (fx.result as unknown[]) : [];
    const normalized = parseGnosisscanResults("txlist", rows);
    for (const row of normalized) {
      expect(row.chain).toBe("gnosis");
      expect(row.asset_address).toBeNull();
      expect(row.from_address).not.toBe("0x5d698362edb8aea1c2b2483096bdee3265d860db");
    }
  });
});

describe("fetchGnosisscan", () => {
  it("throws on rate-limit response (status=0, result=Max rate limit)", async () => {
    const fetchImpl = async () => new Response(
      JSON.stringify({ status: "0", message: "NOTOK", result: "Max rate limit reached" }),
      { status: 200 },
    );
    await expect(
      fetchGnosisscan(fetchImpl as unknown as typeof fetch, "tokentx", "0xabc", 0, "key"),
    ).rejects.toThrow(/Max rate limit/);
  });

  it("paginates until partial page is returned", async () => {
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      const result = call < 2
        ? new Array(1000).fill({ hash: "0x", from: "0x1", to: "0x2", value: "0", blockNumber: "1", timeStamp: "1", contractAddress: "0x", tokenSymbol: "X", tokenDecimal: "18" })
        : [{ hash: "0x", from: "0x1", to: "0x2", value: "0", blockNumber: "1", timeStamp: "1", contractAddress: "0x", tokenSymbol: "X", tokenDecimal: "18" }];
      return new Response(JSON.stringify({ status: "1", message: "OK", result }), { status: 200 });
    };
    const rows = await fetchGnosisscan(fetchImpl as unknown as typeof fetch, "tokentx", "0xabc", 0, "key");
    expect(call).toBe(2);
    expect(rows.length).toBe(1001);
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
import { PHAROS_FUNDING_WALLET } from "@shared/lib/funding/constants";
import { cancelResponseBodyQuietly } from "../response-body";

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
const GNOSISSCAN_PAGE_SIZE = 1000;
const GNOSISSCAN_PAGE_CAP = 10; // 10,000 rows per endpoint per run

/**
 * Paginated Gnosisscan fetch. Etherscan-family endpoints return at most
 * `offset` rows per page; beyond that you must paginate via `page=N&offset=M`.
 * Without pagination, a single call with `offset` omitted caps at 10,000
 * rows and silently truncates — and the caller has no way to know.
 *
 * This function also distinguishes three legitimate-looking responses:
 *   • `status: "1"` with results  → normal
 *   • `status: "0", message: "No transactions found"` → legitimate empty
 *   • `status: "0", message: "NOTOK", result: "Max rate limit reached"` →
 *     rate limit; MUST throw so the circuit breaker + `last_error` records
 *     it (per MEMORY.md "Fetchers must propagate failures to circuit breakers").
 */
export async function fetchGnosisscan(
  fetchImpl: typeof fetch,
  endpoint: GnosisscanEndpoint,
  address: string,
  startBlock: number,
  apiKey: string,
): Promise<unknown[]> {
  const collected: unknown[] = [];
  for (let page = 1; page <= GNOSISSCAN_PAGE_CAP; page += 1) {
    const url = `https://api.gnosisscan.io/api?module=account&action=${endpoint}&address=${address}&startblock=${startBlock}&endblock=99999999&page=${page}&offset=${GNOSISSCAN_PAGE_SIZE}&sort=asc&apikey=${apiKey}`;
    let resp: Response | null = null;
    try {
      resp = await fetchImpl(url);
      if (!resp.ok) {
        const status = resp.status;
        resp = null;
        throw new Error(`Gnosisscan ${endpoint} failed (${status})`);
      }
      const payload = (await resp.json()) as GnosisscanResponse<unknown>;
      resp = null;

      // Rate-limit or API error must propagate — not swallow.
      if (payload.status === "0") {
        const msg = typeof payload.result === "string" ? payload.result : payload.message;
        if (payload.message !== "No transactions found") {
          throw new Error(`Gnosisscan ${endpoint} rejected: ${msg}`);
        }
        return collected; // legitimate empty
      }
      if (!Array.isArray(payload.result)) {
        throw new Error(`Gnosisscan ${endpoint} unexpected shape: ${JSON.stringify(payload).slice(0, 200)}`);
      }
      collected.push(...payload.result);
      if (payload.result.length < GNOSISSCAN_PAGE_SIZE) return collected; // last page
    } finally {
      if (resp) cancelResponseBodyQuietly(resp);
    }
  }
  throw new Error(
    `Gnosisscan ${endpoint} hit ${GNOSISSCAN_PAGE_CAP}-page cap; rerun with a later startblock`,
  );
}

export function parseGnosisscanResults(
  endpoint: GnosisscanEndpoint,
  rows: readonly unknown[],
): NormalizedTransfer[] {
  const wallet = PHAROS_FUNDING_WALLET.toLowerCase();
  const out: NormalizedTransfer[] = [];

  // Category offsets match `alchemy-transfers.ts` `CAT_OFFSET` so
  // (chain, tx_hash, log_index) is globally unique across sources and
  // categories. external → 0; internal → 1_000_000 + idx; erc20 → 2_000_000 + idx.
  const ERC20_OFFSET = 2_000_000;
  const INTERNAL_OFFSET = 1_000_000;

  if (endpoint === "tokentx") {
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i] as GnosisscanTokenTxRow;
      if (r.to.toLowerCase() !== wallet) continue;
      const decimals = parseInt(r.tokenDecimal, 10);
      const amountDecimal = Number(r.value) / 10 ** decimals;
      out.push({
        chain: "gnosis",
        tx_hash: r.hash.toLowerCase(),
        log_index: ERC20_OFFSET + i,
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
  let internalCounter = 0;
  for (const raw of rows as GnosisscanTxRow[]) {
    if (raw.isError === "1") continue;
    if (raw.to.toLowerCase() !== wallet) continue;
    if (raw.from.toLowerCase() === wallet) continue; // self-send protection
    const wei = BigInt(raw.value);
    const whole = wei / 10n ** 18n;
    const frac = wei % 10n ** 18n;
    const amountDecimal = Number(whole) + Number(frac) / 1e18;
    if (amountDecimal === 0) continue;
    const isInternal = endpoint === "txlistinternal";
    const logIndex = isInternal ? INTERNAL_OFFSET + internalCounter : 0;
    if (isInternal) internalCounter += 1;
    out.push({
      chain: "gnosis",
      tx_hash: raw.hash.toLowerCase(),
      log_index: logIndex,
      block_number: parseInt(raw.blockNumber, 10),
      block_timestamp: parseInt(raw.timeStamp, 10),
      from_address: raw.from.toLowerCase(),
      asset_symbol: GNOSIS_NATIVE_SYMBOL,
      asset_address: null,
      amount_decimal: amountDecimal,
      category: isInternal ? "internal" : "external",
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
  /** Transfers that actually produced a new DB row (meta.changes === 1). */
  inserted: number;
  /** Transfers ignored by INSERT OR IGNORE because the row already existed.
   *  Used by the promotion-gate criterion "zero insert-skipped-duplicates
   *  in steady state" — in normal operation this should be 0 after the
   *  first backfill run. */
  skipped_duplicate: number;
  spam: number;
  errors: string[];
  /** Per-transfer ingest outcome; the cron uses this to determine which
   *  transfers to credit toward cursor advance (see Task 10). */
  ingested_tx_hashes: Set<string>;
}

export async function ingestNormalizedTransfers(args: IngestArgs): Promise<IngestResult> {
  const { db, transfers, denylist, lookupPrice } = args;
  let inserted = 0;
  let skipped_duplicate = 0;
  let spam = 0;
  const errors: string[] = [];
  const ingested_tx_hashes = new Set<string>();
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

    // is_spam reflects the spam-denylist match only. Unpriced legitimate
    // tokens (long-tail ERC20s with no CG listing) are NOT spam — they get
    // price_source='zero-no-price' and usd_at_receipt=0, and the API filters
    // them out of dollar totals via `WHERE usd_at_receipt > 0 AND is_spam = 0`.
    if (isSpam) spam += 1;

    try {
      const result = await db
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
          isSpam,
          now,
        )
        .run();
      // D1's run() returns { meta: { changes } }; meta.changes === 0 means
      // INSERT OR IGNORE skipped due to PK conflict. Count those separately
      // so the cursor-advance logic in Task 10 can distinguish "newly
      // persisted" from "already there" and so the promotion gate can
      // verify no spurious duplicates arrive in steady state.
      const changes = result.meta?.changes ?? 0;
      if (changes === 1) {
        inserted += 1;
        ingested_tx_hashes.add(t.tx_hash);
      } else {
        skipped_duplicate += 1;
        // Previously-persisted rows should also count toward cursor advance
        // because they represent the block-range boundary correctly.
        ingested_tx_hashes.add(t.tx_hash);
      }
    } catch (err) {
      errors.push(`insert failed for ${t.tx_hash}: ${String(err).slice(0, 120)}`);
    }
  }

  return { inserted, skipped_duplicate, spam, errors, ingested_tx_hashes };
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
  const [year, m] = month.split("-").map((s) => parseInt(s, 10));
  const monthStart = Math.floor(Date.UTC(year, m - 1, 1) / 1000);
  const monthEnd = Math.floor(Date.UTC(m === 12 ? year + 1 : year, m === 12 ? 0 : m, 1) / 1000);

  const row = await db
    .prepare(
      `SELECT
        COALESCE(SUM(usd_at_receipt), 0) AS donations_usd,
        COUNT(DISTINCT from_address) AS donor_count
       FROM funding_donations
       WHERE block_timestamp >= ? AND block_timestamp < ?
         AND is_spam = 0 AND is_refund = 0 AND usd_at_receipt > 0`,
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
import type { CostLineItem, CostLineItemsFile, DonorLabel, SpamDenylist } from "./types";

const costFile = costLineItemsJson as CostLineItemsFile;
export const COST_LINE_ITEMS: CostLineItem[] = costFile.items;
export const COST_LAST_REVIEWED_AT: number | null = costFile.last_reviewed_at ?? null;
export const DONOR_LABELS = donorLabelsJson as DonorLabel[];
export const SPAM_DENYLIST = spamDenylistJson as SpamDenylist;

export const FUNDING_METHODOLOGY_VERSION = 1;
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
import { PHAROS_FUNDING_WALLET, FUNDING_ENS_TTL_SECONDS, FUNDING_ENS_RESOLUTIONS_PER_RUN_CAP } from "@shared/lib/funding/constants";
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

      // Advance the cursor to the highest block whose transfer we actually
      // persisted (or was already persisted from a prior run). A mid-loop
      // failure (e.g. CoinGecko 500 on transfer #7 of 10) leaves the
      // unprocessed tail visible to the next run rather than skipping it
      // permanently.
      const successBlocks = transfers
        .filter((t) => ingest.ingested_tx_hashes.has(t.tx_hash))
        .map((t) => t.block_number);
      const safeAdvanceBlock = successBlocks.length > 0
        ? Math.max(...successBlocks)
        : fromBlock;

      // Only count as a per-chain success if there were no ingestion errors
      // AND no spurious duplicates (the latter indicates the cursor advanced
      // incorrectly on a prior run or two cron invocations overlapped).
      const isSuccess = ingest.errors.length === 0 && ingest.skipped_duplicate === 0;
      await args.db
        .prepare(
          `INSERT INTO funding_chain_sync (chain, last_block_seen, last_success_at, last_attempt_at, last_error)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(chain) DO UPDATE SET
             last_block_seen = MAX(funding_chain_sync.last_block_seen, excluded.last_block_seen),
             last_success_at = CASE WHEN excluded.last_error IS NULL THEN excluded.last_success_at ELSE funding_chain_sync.last_success_at END,
             last_attempt_at = excluded.last_attempt_at,
             last_error = excluded.last_error`,
        )
        .bind(
          chain,
          safeAdvanceBlock,
          isSuccess ? args.now : 0,
          args.now,
          isSuccess ? null : ingest.errors.slice(0, 3).join("; ").slice(0, 500),
        )
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

  // ENS resolve the top-N senders (deduped, with TTL). Uncapped fan-out
  // on spammy days could burn the worker's 30s CPU budget on 200+ eth_calls;
  // the donor wall only renders top-20 anyway, so prioritize senders most
  // likely to appear on the wall. Unresolved senders remain displayed as
  // truncated addresses via formatAddress() until a later run catches them.
  const sendersByPriority = await args.db
    .prepare(
      `SELECT from_address, SUM(usd_at_receipt) AS total_usd, MAX(block_timestamp) AS recent_ts
       FROM funding_donations
       WHERE is_spam = 0 AND is_refund = 0
       GROUP BY from_address
       ORDER BY recent_ts DESC, total_usd DESC
       LIMIT ?`,
    )
    .bind(FUNDING_ENS_RESOLUTIONS_PER_RUN_CAP)
    .all<{ from_address: string }>();
  const candidateSenders = new Set((sendersByPriority.results ?? []).map((r) => r.from_address));
  // Also include any senders from THIS run's transfers that didn't make the
  // top-N but are brand new (they won't be in the DB ranking yet until the
  // ingestion step just above committed them, but defensively keep them).
  for (const t of allTransfers) if (candidateSenders.size < FUNDING_ENS_RESOLUTIONS_PER_RUN_CAP) candidateSenders.add(t.from_address);

  for (const sender of candidateSenders) {
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

  // Recompute aggregates for:
  //   (a) every month touched by a transfer in this run,
  //   (b) the current month (always, so "this month so far" is live), and
  //   (c) every closed month from the first-ever-tracked month forward that
  //       does NOT yet have a `funding_monthly` row — so the cost step line
  //       in the chart has data for every month since tracking began, not
  //       just months that happened to receive a donation.
  const touched = new Set(computeMonthsTouched(allTransfers));
  touched.add(monthFromTimestamp(args.now));

  // Backfill missing closed-month rows since the earliest tracked row.
  const earliest = await args.db
    .prepare("SELECT MIN(block_timestamp) AS ts FROM funding_donations")
    .first<{ ts: number | null }>();
  if (earliest?.ts && earliest.ts > 0) {
    let cursor = monthFromTimestamp(earliest.ts);
    const end = monthFromTimestamp(args.now);
    while (cursor < end) {
      touched.add(cursor);
      cursor = nextMonth(cursor);
    }
  }

  const months = [...touched].sort();
  const closedMonths = new Set(finalizeClosedMonths(args.now, months));
  for (const month of months) {
    await recomputeMonthlyAggregate({
      db: args.db,
      month,
      costLineItems: COST_LINE_ITEMS,
      finalize: closedMonths.has(month),
    });
    result.monthly_recomputed += 1;
  }

  return result;
}

/** "2026-04" → "2026-05" (wraps year on December). */
function nextMonth(yyyymm: string): string {
  const [y, m] = yyyymm.split("-").map((s) => parseInt(s, 10));
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

// Default fetcher built around real network calls; used by the scheduled handler,
// not by unit tests. Keep here so the cron file is the single import surface.
export function buildDefaultChainFetcher(env: {
  ALCHEMY_API_KEY: string;
  GNOSISSCAN_API_KEY: string;
}): (chain: FundingChain, fromBlock: number) => Promise<NormalizedTransfer[]> {
  return async (chain, fromBlock) => {
    if (chain === "gnosis") {
      // Sequential, not Promise.all: Cloudflare's 6-connection pool is shared
      // across ctx.waitUntil work, and running three concurrent fetches plus
      // any overlapping body-drain on siblings can spike peak connections.
      const all: NormalizedTransfer[] = [];
      for (const endpoint of ["tokentx", "txlist", "txlistinternal"] as const) {
        const rows = await fetchGnosisscan(fetch, endpoint, PHAROS_FUNDING_WALLET, fromBlock, env.GNOSISSCAN_API_KEY);
        all.push(...parseGnosisscanResults(endpoint, rows));
      }
      return all;
    }
    const slug = ALCHEMY_CHAINS[chain];
    if (!slug) throw new Error(`No Alchemy slug for chain ${chain}`);
    const rpcUrl = `https://${slug}.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
    const fromBlockHex = "0x" + fromBlock.toString(16);
    const raw = await fetchAlchemyTransfersTo(fetch, rpcUrl, PHAROS_FUNDING_WALLET, fromBlockHex, chain);
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
  maxConnections: 1, // Fully sequential: chains, then ENS, then CG historical — peak is 1.
},
```

(The `triggerMode: "isolated"` ensures the funding cron does not chain into other daily jobs and gets its full 6-connection budget exclusive.)

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
import type { FundingChain } from "@shared/lib/funding/types";

export async function runDaily0700Slot(runtime: ScheduledRuntimeContext): Promise<void> {
  try {
    await runtime.runLeasedCron("sync-funding-donations", async () => {
      // Use runtime.coingeckoApiKey (already normalized via normalizeCgApiKey)
      // and the worker's already-built chain RPCs from runtime instead of
      // re-reading raw env. Falls back gracefully if the key is unset.
      const cgKey = runtime.coingeckoApiKey;
      if (!cgKey) {
        console.warn("[funding] no CoinGecko API key configured; skipping run");
        return;
      }
      const env = runtime.env as unknown as {
        ALCHEMY_API_KEY: string;
        GNOSISSCAN_API_KEY: string;
      };
      if (!env.ALCHEMY_API_KEY || !env.GNOSISSCAN_API_KEY) {
        console.warn("[funding] missing ALCHEMY_API_KEY or GNOSISSCAN_API_KEY; skipping run");
        return;
      }

      const fetchPerChain = buildDefaultChainFetcher(env);
      const resolveEns = buildDefaultEnsResolver(env);
      const lookupPrice = (assetKey: string, priceDate: string, chain: FundingChain, assetAddress: string | null) =>
        fetchUsdPriceHistorical(runtime.db, assetKey, priceDate, chain, fetch, cgKey, assetAddress);

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

Do NOT add `GNOSISSCAN_API_KEY = ""` to `[vars]`. Setting an empty default in `[vars]` would drown out `wrangler secret put GNOSISSCAN_API_KEY` at deploy time (`[vars]` takes precedence over same-named secrets). The correct pattern is to add `GNOSISSCAN_API_KEY?: string` to the `Env` interface in `worker/src/lib/env.ts` (matches how every other optional API key is declared there) and set the real value via `wrangler secret put` in CI or via the Cloudflare dashboard.

- [ ] **Step 7: Seed the chain-sync cursors (block numbers, not timestamps)**

The first prod run must not paginate from block 0 across 5 chains and Gnosisscan. Seed each chain's `last_block_seen` to `currentBlockNumber - 30-day-safe-margin` before the first cron fires. This MUST use real block numbers, not unix timestamps — `last_block_seen` is a block-number cursor and the Alchemy/Gnosisscan callers pass it as such.

Use the existing chain RPCs from the worker registry to get the current block per chain:

```bash
cd worker && npx wrangler dev  # one shell
# another shell:
node scripts/seed-funding-cursors.ts
```

Create `worker/scripts/seed-funding-cursors.ts`:

```typescript
// One-off: seeds funding_chain_sync with (current_block_number - 30d of blocks)
// per chain. Idempotent via ON CONFLICT(chain) DO NOTHING.
// Approximate 30-day block counts (round down to err low so we overscan a
// little on the first run — worst case is a few hundred extra Alchemy calls):
const BLOCKS_PER_30_DAYS: Record<string, number> = {
  ethereum: 216_000,    // ~12s/block
  base:     1_296_000,  // ~2s/block
  optimism: 1_296_000,  // ~2s/block
  arbitrum: 10_800_000, // ~0.25s/block
  polygon:  1_180_800,  // ~2.2s/block
  gnosis:   518_400,    // ~5s/block
};

// For each chain: eth_blockNumber via the chain's Alchemy RPC (or Gnosis
// public RPC for gnosis), compute `currentBlock - 30d`, write row.
// Implementation uses the existing chain-rpc helper in worker/src/lib/.
```

If the wallet later receives a known older transfer predating the seed, it can be backfilled via a small admin script (see Task 12-style pattern) — out of scope for v1.

- [ ] **Step 8: Type-check the worker**

```bash
cd worker && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 9: Run the tests for the new wiring**

```bash
cd worker && npx vitest run src/cron/__tests__/sync-funding-donations.test.ts
```

Expected: PASS.

- [ ] **Step 10: Run cron cross-validation checks**

```bash
npm run check:cron-sync
npm run check:cron-connections
```

Both scripts validate that `shared/lib/cron-jobs.ts`, `shared/lib/scheduled-runner-registry.ts`, `worker/wrangler.toml`, and the connection-budget declarations agree. Fix any drift before committing.

- [ ] **Step 11: Commit**

```bash
git add shared/lib/cron-jobs.ts shared/lib/scheduled-runner-registry.ts worker/src/handlers/scheduled.ts worker/src/handlers/scheduled/daily-0700.ts worker/wrangler.toml worker/src/lib/env.ts worker/scripts/seed-funding-cursors.ts
git commit -m "feat(funding): register daily 07:00 UTC cron slot"
```

---

## Task 12: Seed Brice's EOA + Giveth pool into donor labels

**Files:**
- Modify: `shared/data/funding/donor-labels.json`

**Sequencing:** Task 12a (Brice's EOA) **must complete before Task 11 Step 7 (chain-sync seed)**, i.e. before the first production cron run. Otherwise the first ingested transfer lands as community, inflating `distinct_community_donors_lifetime` by 1 and polluting the donor wall until the label is added. The API computes attribution live from labels, so adding the label later retro-corrects — but the promotion-gate criterion "`distinct_community_donors_lifetime` does NOT count the founder address" implicitly assumes labels are present from day 1.

Task 12b (Giveth pool) can happen after the first test donation — Giveth's payout contract address is only knowable after seeing it send.

- [ ] **Task 12a — Step 1: Identify Brice's EOA**

Inspect the one known inbound tx:

```bash
echo "https://etherscan.io/tx/0xc310bc94c763f00c939aefba0094e012892b45e688954283199264d37cdb8786"
```

The `From` field on Etherscan is Brice's EOA. Lowercase it.

- [ ] **Task 12a — Step 2: Seed the founder label immediately**

```json
[
  { "address": "0x<brice-eoa-lowercased>", "label": "TokenBrice (founder subsidy)", "kind": "founder" }
]
```

Commit before running Task 11 Step 7:

```bash
git add shared/data/funding/donor-labels.json
git commit -m "feat(funding): label founder subsidy address"
```

- [ ] **Task 12b — Step 1: Identify the Giveth payout contract (post-first-donation)**

Make a small test donation through Giveth (any small ETH amount via https://giveth.io/project/pharos-watch:-transparent-stablecoins-analytics). Wait for it to finalize. Inspect the `From` address on the inbound transfer to `0x5d698362edb8aea1c2b2483096bdee3265d860db` — that's the Giveth payout contract on the chain you donated from. Repeat per chain only if Giveth sends from chain-specific contracts.

- [ ] **Task 12b — Step 2: Append the pool label**

```json
[
  { "address": "0x<brice-eoa-lowercased>",  "label": "TokenBrice (founder subsidy)", "kind": "founder" },
  { "address": "0x<giveth-pool-lowercased>", "label": "via Giveth",                  "kind": "pool" }
]
```

`kind: "founder"` drives chart/KPI separation (excluded from `distinct_community_donors_lifetime`, `community_donations_usd`, donor wall; kept in the chart as a separate stacked layer + surfaced in the cost-breakdown footer). `kind: "pool"` counts the same as community.

```bash
git add shared/data/funding/donor-labels.json
git commit -m "feat(funding): label Giveth pool contract"
```

---

## Task 13: API endpoint `/api/funding-summary`

**Files:**
- Create: `shared/lib/api-endpoints/schemas/funding-summary.ts` (Zod schema)
- Modify: `shared/lib/api-endpoints/paths.ts` (path constant — also touched in Task 14)
- Modify: `shared/lib/api-endpoints/definitions.ts` (endpoint registration)
- Create: `worker/src/api/funding-summary.ts`
- Modify: `worker/src/routes/public-routes.ts`
- Test: `worker/src/api/__tests__/funding-summary.test.ts`

**Sequencing note:** `defineStaticRoute("funding-summary", ...)` in `public-routes.ts` requires a matching `EndpointKey` in `ENDPOINT_DEFINITIONS`. The endpoint must be registered in `shared/lib/api-endpoints/definitions.ts` BEFORE the route is wired, or the worker fails to load at boot (`requireEndpoint` throws).

- [ ] **Step 1: Write the failing test**

Create `worker/src/api/__tests__/funding-summary.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { handleFundingSummaryImpl } from "../funding-summary";

function makeDbWithSeed(seed: {
  monthlySplit: Array<{ month: string; founder_subsidy_usd: number; community_donations_usd: number; donor_count: number }>;
  costs: Array<{ month: string; costs_usd: number }>;
  lifetime: { community_total: number; founder_total: number; community_donors: number };
  donors: Array<{ from_address: string; usd: number; ts: number; chain?: string; ens?: string | null; forward?: number }>;
  chainSync: Array<{ chain: string; last_success_at: number; last_attempt_at: number; last_error: string | null }>;
}) {
  return {
    prepare(sql: string) {
      return {
        bind: () => ({
          first: async () => {
            if (sql.includes("community_total") && sql.includes("founder_total")) return seed.lifetime;
            return null;
          },
          all: async () => {
            if (sql.includes("strftime('%Y-%m'")) return { results: seed.monthlySplit };
            if (sql.includes("FROM funding_monthly")) return { results: seed.costs };
            if (sql.includes("most_recent_chain") || (sql.includes("GROUP BY") && sql.includes("from_address"))) {
              return {
                results: seed.donors.map((d) => ({
                  from_address: d.from_address,
                  total_usd: d.usd,
                  most_recent_at: d.ts,
                  most_recent_chain: d.chain ?? "ethereum",
                  ens_name: d.ens ?? null,
                  forward_verified: d.forward ?? 0,
                })),
              };
            }
            if (sql.includes("FROM funding_chain_sync")) return { results: seed.chainSync };
            return { results: [] };
          },
        }),
      };
    },
  };
}

describe("handleFundingSummary", () => {
  it("returns kpis with founder/community split and cold_start flag", async () => {
    const db = makeDbWithSeed({
      monthlySplit: [
        { month: "2026-02", founder_subsidy_usd: 1000, community_donations_usd: 100, donor_count: 1 },
        { month: "2026-03", founder_subsidy_usd: 1000, community_donations_usd: 200, donor_count: 2 },
        { month: "2026-04", founder_subsidy_usd: 1000, community_donations_usd: 300, donor_count: 3 },
      ],
      costs: [
        { month: "2026-02", costs_usd: 1676.85 },
        { month: "2026-03", costs_usd: 1676.85 },
        { month: "2026-04", costs_usd: 1676.85 },
      ],
      lifetime: { community_total: 600, founder_total: 3000, community_donors: 3 },
      donors: [
        { from_address: "0xa", usd: 300, ts: 1700000000, chain: "base", ens: "alice.eth", forward: 1 },
      ],
      chainSync: [
        { chain: "ethereum", last_success_at: 1700000000, last_attempt_at: 1700000000, last_error: null },
      ],
    });
    const resp = await handleFundingSummaryImpl(db as unknown as D1Database);
    const body = await resp.json() as {
      kpis: {
        current_month_coverage_pct: number;
        current_month_community_usd: number;
        current_month_founder_subsidy_usd: number;
        current_month_uncovered_usd: number;
        current_month_target_usd: number;
        total_community_lifetime_usd: number;
        total_founder_subsidy_usd: number;
        distinct_community_donors_lifetime: number;
        is_cold_start: boolean;
      };
      recent_donors: Array<{ display: string; explorer_url: string; most_recent_chain: string }>;
      line_items: unknown[];
      monthly_series: unknown[];
      chain_freshness: unknown[];
      last_synced_at: number;
      _meta: { funding_methodology_version: number; cost_last_reviewed_at: number | null };
    };
    expect(body.kpis.current_month_community_usd).toBe(300);
    expect(body.kpis.current_month_founder_subsidy_usd).toBe(1000);
    // community-only coverage: 300 / 1676.85 ≈ 17.9%
    expect(body.kpis.current_month_coverage_pct).toBeGreaterThan(17);
    expect(body.kpis.current_month_coverage_pct).toBeLessThan(18);
    // uncovered = max(0, target - community) = 1676.85 - 300 = 1376.85
    expect(body.kpis.current_month_uncovered_usd).toBeCloseTo(1376.85, 2);
    expect(body.kpis.total_community_lifetime_usd).toBe(600);
    expect(body.kpis.total_founder_subsidy_usd).toBe(3000);
    expect(body.kpis.distinct_community_donors_lifetime).toBe(3);
    expect(body.kpis.is_cold_start).toBe(false);
    expect(body.recent_donors[0]).toMatchObject({ display: "alice.eth", most_recent_chain: "base" });
    expect(body.recent_donors[0].explorer_url).toContain("basescan.org");
    // Monthly series may include additional zero-donation months to fill the
    // trailing-12 window; just assert the three seeded months are present.
    const months = (body.monthly_series as Array<{ month: string }>).map((m) => m.month);
    expect(months).toEqual(expect.arrayContaining(["2026-02", "2026-03", "2026-04"]));
    expect(body._meta.funding_methodology_version).toBeGreaterThanOrEqual(1);
  });

  it("flags cold start when no community donations exist anywhere", async () => {
    const db = makeDbWithSeed({
      monthlySplit: [
        { month: "2026-04", founder_subsidy_usd: 1000, community_donations_usd: 0, donor_count: 0 },
      ],
      costs: [{ month: "2026-04", costs_usd: 1676.85 }],
      lifetime: { community_total: 0, founder_total: 1000, community_donors: 0 },
      donors: [],
      chainSync: [],
    });
    const resp = await handleFundingSummaryImpl(db as unknown as D1Database);
    const body = await resp.json() as { kpis: { is_cold_start: boolean } };
    expect(body.kpis.is_cold_start).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npx vitest run src/api/__tests__/funding-summary.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3a: Register the endpoint in shared definitions**

Edit `shared/lib/api-endpoints/paths.ts`: add `fundingSummary: () => "/api/funding-summary",` to `API_PATHS` near the other `*Summary` entries.

Edit `shared/lib/api-endpoints/definitions.ts`: add an entry to `BASE_ENDPOINT_DEFINITIONS` matching the `peg-summary` shape (read that entry first to copy the exact field set):

```typescript
{
  key: "funding-summary",
  path: API_PATHS.fundingSummary(),
  methods: ["GET"],
  adminRequired: false,
  mutatingAdmin: false,
  cacheBypass: false,
  probeGroup: "public",
  strictContract: true,
  schema: fundingSummaryResponseSchema, // imported from the Zod file below
},
```

Create `shared/lib/api-endpoints/schemas/funding-summary.ts`:

```typescript
import { z } from "zod";

const chainSchema = z.enum(["ethereum", "base", "optimism", "arbitrum", "polygon", "gnosis"]);

export const fundingSummaryResponseSchema = z.object({
  kpis: z.object({
    current_month_coverage_pct: z.number(),
    current_month_community_usd: z.number(),
    current_month_founder_subsidy_usd: z.number(),
    current_month_uncovered_usd: z.number(),
    current_month_target_usd: z.number(),
    trailing_3mo_avg_coverage_pct: z.number(),
    total_community_lifetime_usd: z.number(),
    total_founder_subsidy_usd: z.number(),
    distinct_community_donors_lifetime: z.number().int(),
    is_cold_start: z.boolean(),
  }),
  monthly_series: z.array(z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    community_donations_usd: z.number(),
    founder_subsidy_usd: z.number(),
    costs_usd: z.number(),
    donor_count: z.number().int(),
  })),
  line_items: z.array(z.object({
    label: z.string(),
    category: z.enum(["team", "infra"]),
    usd_per_month: z.number(),
    note: z.string().optional(),
  })),
  recent_donors: z.array(z.object({
    address: z.string(),
    display: z.string(),
    total_usd: z.number(),
    most_recent_at: z.number(),
    most_recent_chain: chainSchema,
    explorer_url: z.string().url(),
  })),
  chain_freshness: z.array(z.object({
    chain: chainSchema,
    last_success_at: z.number(),
    last_attempt_at: z.number(),
    last_error: z.string().nullable(),
  })),
  last_synced_at: z.number(),
  _meta: z.object({
    funding_methodology_version: z.number().int(),
    cost_last_reviewed_at: z.number().nullable(),
  }),
});

export type FundingSummaryResponseParsed = z.infer<typeof fundingSummaryResponseSchema>;
```

(Cross-check the file location — the repo may have `shared/lib/api-endpoints/schemas/` as the conventional path; if the existing pattern differs, match that.)

- [ ] **Step 3b: Implement the handler**

Create `worker/src/api/funding-summary.ts`:

```typescript
import { COST_LINE_ITEMS, COST_LAST_REVIEWED_AT, DONOR_LABELS, FUNDING_METHODOLOGY_VERSION } from "@shared/lib/funding/data";
import { computeMonthlyTotal } from "@shared/lib/funding/cost-helpers";
import type {
  FundingSummaryResponse,
  FundingMonthlyPoint,
  FundingDonorWallEntry,
  ChainFreshnessEntry,
  FundingChain,
} from "@shared/lib/funding/types";
import { FUNDING_CHAINS } from "@shared/lib/funding/types";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { formatAddress } from "@shared/lib/format";
import { withErrorHandler } from "../lib/error-handler";
import { jsonResponse } from "../lib/response";
import { addFreshnessHeaders } from "../lib/cache";

const TRAILING_MONTHS = 12;
const DONOR_WALL_LIMIT = 20;
const DONOR_WALL_LOOKBACK_DAYS = 365;

// `/^/` so we can continue to export an unwrapped internal for testing.
export const handleFundingSummary = withErrorHandler(
  "funding-summary",
  async (db: D1Database): Promise<Response> => handleFundingSummaryImpl(db),
);

export async function handleFundingSummaryImpl(db: D1Database): Promise<Response> {
  // Founder addresses are pulled out so we can split donations into community
  // vs founder-subsidy in every aggregate.
  const founderAddresses = new Set(
    DONOR_LABELS.filter((d) => d.kind === "founder").map((d) => d.address.toLowerCase()),
  );
  const founderInClause = founderAddresses.size > 0
    ? Array.from(founderAddresses).map(() => "?").join(",")
    : "''"; // empty clause that matches nothing
  const founderBinds = founderAddresses.size > 0 ? Array.from(founderAddresses) : [];

  // Per-month split: community vs founder. We compute on the fly from
  // funding_donations (the audit log) rather than relying on funding_monthly's
  // single donations_usd column, because funding_monthly does not track the
  // founder/community split.
  const monthlyRows = await db
    .prepare(
      `SELECT
         strftime('%Y-%m', datetime(block_timestamp, 'unixepoch')) AS month,
         COALESCE(SUM(CASE WHEN LOWER(from_address) IN (${founderInClause}) THEN usd_at_receipt ELSE 0 END), 0) AS founder_subsidy_usd,
         COALESCE(SUM(CASE WHEN LOWER(from_address) NOT IN (${founderInClause}) THEN usd_at_receipt ELSE 0 END), 0) AS community_donations_usd,
         COUNT(DISTINCT CASE WHEN LOWER(from_address) NOT IN (${founderInClause}) THEN from_address ELSE NULL END) AS donor_count
       FROM funding_donations
       WHERE is_spam = 0 AND is_refund = 0 AND usd_at_receipt > 0
       GROUP BY month
       ORDER BY month ASC`,
    )
    .bind(...founderBinds, ...founderBinds, ...founderBinds)
    .all<{ month: string; founder_subsidy_usd: number; community_donations_usd: number; donor_count: number }>();

  // Cost snapshot per month: pulled from funding_monthly where available,
  // falling back to current cost line items for months not yet finalized.
  const costRows = await db
    .prepare("SELECT month, costs_usd FROM funding_monthly")
    .all<{ month: string; costs_usd: number }>();
  const costByMonth = new Map((costRows.results ?? []).map((r) => [r.month, r.costs_usd]));
  const currentCostsUsd = computeMonthlyTotal(COST_LINE_ITEMS);

  // Build a donation-keyed map so we can left-join against a generated month
  // range; months without donations still get a row (zero donations, cost from
  // funding_monthly snapshot if present or current cost-line-items fallback).
  const donationsByMonth = new Map<string, { community: number; founder: number; donors: number }>();
  for (const r of monthlyRows.results ?? []) {
    donationsByMonth.set(r.month, {
      community: r.community_donations_usd,
      founder: r.founder_subsidy_usd,
      donors: r.donor_count,
    });
  }

  // Generate a TRAILING_MONTHS-wide window ending at the current month so
  // the chart always has a complete x-axis rather than skipping gaps.
  // Starts at the earlier of (current - 11 months) and (first month of
  // data) — whichever is later, so we don't pad with months before tracking
  // began.
  const currentMonth = monthFromNow();
  const firstMonthWithData = [...donationsByMonth.keys()].sort()[0];
  const windowStart = firstMonthWithData && firstMonthWithData > subMonths(currentMonth, TRAILING_MONTHS - 1)
    ? firstMonthWithData
    : subMonths(currentMonth, TRAILING_MONTHS - 1);

  const trailing: FundingMonthlyPoint[] = [];
  let cursor = windowStart;
  while (cursor <= currentMonth) {
    const d = donationsByMonth.get(cursor);
    trailing.push({
      month: cursor,
      community_donations_usd: round2(d?.community ?? 0),
      founder_subsidy_usd: round2(d?.founder ?? 0),
      costs_usd: costByMonth.get(cursor) ?? currentCostsUsd,
      donor_count: d?.donors ?? 0,
    });
    cursor = addMonth(cursor);
  }

  // KPIs — coverage % is COMMUNITY-ONLY. Including founder subsidy in the
  // numerator would make this KPI always read ~100% because the founder
  // closes the gap by definition, defeating the transparency goal.
  const currentRow = trailing.find((r) => r.month === currentMonth)!;
  const monthlyTarget = currentCostsUsd;
  const currentCommunity = currentRow.community_donations_usd;
  const currentFounder = currentRow.founder_subsidy_usd;
  // Cap at 100% at the API boundary so the number is safe to render directly;
  // uncapped values would mislead if community ever overshoots target.
  const currentCoveragePct = monthlyTarget > 0
    ? Math.min(100, (currentCommunity / monthlyTarget) * 100)
    : 0;
  const currentUncovered = Math.max(0, monthlyTarget - currentCommunity);

  // Trailing 3-month community-only coverage (average of per-month pct, not
  // sum-over-sum; that way a zero-cost month doesn't nuke the average).
  const last3 = trailing.slice(-3).filter((r) => r.costs_usd > 0);
  const t3CoveragePct = last3.length > 0
    ? Math.min(100, last3.reduce((s, r) => s + (r.community_donations_usd / r.costs_usd) * 100, 0) / last3.length)
    : 0;

  // Lifetime totals (community vs founder-subsidy split)
  const lifetimeRow = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN LOWER(from_address) NOT IN (${founderInClause}) THEN usd_at_receipt ELSE 0 END), 0) AS community_total,
         COALESCE(SUM(CASE WHEN LOWER(from_address) IN (${founderInClause}) THEN usd_at_receipt ELSE 0 END), 0) AS founder_total,
         COUNT(DISTINCT CASE WHEN LOWER(from_address) NOT IN (${founderInClause}) THEN from_address ELSE NULL END) AS community_donors
       FROM funding_donations
       WHERE is_spam = 0 AND is_refund = 0 AND usd_at_receipt > 0`,
    )
    .bind(...founderBinds, ...founderBinds, ...founderBinds)
    .first<{ community_total: number; founder_total: number; community_donors: number }>();

  const isCommunityCold = (lifetimeRow?.community_total ?? 0) === 0;

  // Donor wall — bounded by 365-day window to keep the GROUP BY manageable
  // at scale. Excludes founder addresses.
  const lookbackTs = Math.floor(Date.now() / 1000) - DONOR_WALL_LOOKBACK_DAYS * 86400;
  const donorRows = await db
    .prepare(
      `SELECT
         d.from_address,
         SUM(d.usd_at_receipt) AS total_usd,
         MAX(d.block_timestamp) AS most_recent_at,
         (SELECT chain FROM funding_donations d2
            WHERE d2.from_address = d.from_address AND d2.is_spam = 0 AND d2.is_refund = 0
            ORDER BY d2.block_timestamp DESC LIMIT 1) AS most_recent_chain,
         e.ens_name,
         e.forward_verified
       FROM funding_donations d
       LEFT JOIN funding_ens_cache e ON e.address = d.from_address
       WHERE d.is_spam = 0 AND d.is_refund = 0 AND d.usd_at_receipt > 0
         AND d.block_timestamp >= ?
         AND LOWER(d.from_address) NOT IN (${founderInClause})
       GROUP BY d.from_address
       ORDER BY most_recent_at DESC
       LIMIT ?`,
    )
    .bind(lookbackTs, ...founderBinds, DONOR_WALL_LIMIT)
    .all<{
      from_address: string;
      total_usd: number;
      most_recent_at: number;
      most_recent_chain: string;
      ens_name: string | null;
      forward_verified: number;
    }>();

  const labelMap = new Map(DONOR_LABELS.map((d) => [d.address.toLowerCase(), d]));
  const recentDonors: FundingDonorWallEntry[] = (donorRows.results ?? []).map((row) => {
    const label = labelMap.get(row.from_address);
    const chain = (row.most_recent_chain as FundingChain) ?? "ethereum";
    const display = label?.label
      ? label.label
      : row.forward_verified === 1 && row.ens_name
        ? row.ens_name
        : formatAddress(row.from_address);
    return {
      address: row.from_address,
      display,
      total_usd: round2(row.total_usd),
      most_recent_at: row.most_recent_at,
      most_recent_chain: chain,
      explorer_url: buildExplorerUrl(chain, "address", row.from_address),
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

  const successTimestamps = chainFreshness.map((r) => r.last_success_at).filter((t) => t > 0);
  const lastSyncedAt = successTimestamps.length > 0 ? Math.max(...successTimestamps) : 0;

  const response: FundingSummaryResponse = {
    kpis: {
      current_month_coverage_pct: round1(currentCoveragePct),
      current_month_community_usd: round2(currentCommunity),
      current_month_founder_subsidy_usd: round2(currentFounder),
      current_month_uncovered_usd: round2(currentUncovered),
      current_month_target_usd: monthlyTarget,
      trailing_3mo_avg_coverage_pct: round1(t3CoveragePct),
      total_community_lifetime_usd: round2(lifetimeRow?.community_total ?? 0),
      total_founder_subsidy_usd: round2(lifetimeRow?.founder_total ?? 0),
      distinct_community_donors_lifetime: lifetimeRow?.community_donors ?? 0,
      is_cold_start: isCommunityCold,
    },
    monthly_series: trailing,
    line_items: COST_LINE_ITEMS,
    recent_donors: recentDonors,
    chain_freshness: chainFreshness,
    last_synced_at: lastSyncedAt,
    _meta: {
      funding_methodology_version: FUNDING_METHODOLOGY_VERSION,
      cost_last_reviewed_at: COST_LAST_REVIEWED_AT,
    },
  };

  return jsonResponse(response, addFreshnessHeaders(lastSyncedAt, {
    // Worker cache TTL matches daily cron cadence; page hook handles client
    // caching. Browser Cache-Control is modest so a manual refresh picks up
    // a just-finished cron run.
    "cache-control": "public, max-age=300, s-maxage=3600",
  }));
}

function monthFromNow(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function addMonth(yyyymm: string): string {
  const [y, m] = yyyymm.split("-").map((s) => parseInt(s, 10));
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

function subMonths(yyyymm: string, n: number): string {
  let out = yyyymm;
  for (let i = 0; i < n; i += 1) {
    const [y, m] = out.split("-").map((s) => parseInt(s, 10));
    const pm = m === 1 ? 12 : m - 1;
    const py = m === 1 ? y - 1 : y;
    out = `${py}-${String(pm).padStart(2, "0")}`;
  }
  return out;
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
```

(Verify the exact names of `withErrorHandler`, `jsonResponse`, and `addFreshnessHeaders` against the repo at implementation time — read `worker/src/api/peg-summary.ts` first and mirror its pattern exactly. `formatAddress` is imported from `@shared/lib/format`.)

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

Before writing this hook, read `src/hooks/use-api-query.ts` fully (not just the first 60 lines) to confirm the mapping between its 3rd argument and TanStack's `staleTime` / `refetchInterval`. CLAUDE.md requires `staleTime = cron interval` and `refetchInterval = 2× cron interval`. If the helper already applies the 2× multiplier internally, pass `CRON_FUNDING_SUMMARY` once; if not, pass both values explicitly via the options object.

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
    {
      retry: 1,
      // Explicitly pin refetchInterval to 2× the cron interval per
      // CLAUDE.md's hook-timing rule; if use-api-query already does this
      // internally, drop this override (TanStack will use whichever is
      // passed last).
      refetchInterval: CRON_FUNDING_SUMMARY * 2,
    },
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
git add shared/lib/api-endpoints/paths.ts src/lib/cron-intervals.ts src/hooks/use-funding-summary.ts
git commit -m "feat(funding): API path constant + useFundingSummary hook"
```

---

## Task 14.5: Extract `TonalSection` primitive from `/about`

**Why:** The `/funding` page consumes six tonal section cards (cost, donor, CTAs, year-end, plus future); replicating raw `Card+CardHeader+CardTitle` in each call site re-derives the tone classes, the gradient rule, and the kicker pattern from scratch. Extracting the existing `AboutSection` (and its `getToneClasses`) into a shared primitive keeps the design language in one place. Tasks 15–17 then consume `TonalSection` instead of redefining the structure.

**Important:** `AboutSection` lives inside `src/app/about/page.tsx` today and is used twice in two flavors — `AboutSection` (a wrapper) and `AboutFeatureSection` (which composes it). Only the bare `AboutSection` and `getToneClasses` are shareable; `AboutFeatureSection` and `AboutFeatureRow` stay in `/about` because they reference `/about`-specific item shapes. Preserve the existing API 1:1 — same props (`eyebrow`, `title`, `tone`, `children`, `contentClassName`), same tone keys (`brand | data | insight | classification | neutral`), same DOM shape — so `/about` continues to render byte-identical markup.

**Files:**
- Create: `src/components/tonal-section.tsx`
- Modify: `src/app/about/page.tsx`

- [ ] **Step 1: Verify the existing `AboutSection` API**

```bash
sed -n '73,123p;181,236p' src/app/about/page.tsx
```

Confirm: `AboutTone` is `"brand" | "data" | "insight" | "classification" | "neutral"`; `getToneClasses(tone)` returns `{ border, kicker, icon, rule }`; `AboutSection({ eyebrow, title, tone, children, contentClassName })` renders `Card.border-l-[3px].{toneClasses.border}` containing a `CardHeader` with the kicker line + gradient rule + `CardTitle as="h2"`, then `CardContent.{contentClassName}`. If the live shape differs from this description (e.g. a new prop has been added), update Step 2 to match before extracting.

- [ ] **Step 2: Create the shared primitive**

Create `src/components/tonal-section.tsx`:

```typescript
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type TonalSectionTone = "brand" | "data" | "insight" | "classification" | "neutral";

export function getToneClasses(tone: TonalSectionTone) {
  switch (tone) {
    case "brand":
      return {
        border: "border-l-frost-blue",
        kicker: "text-sky-700 dark:text-frost-blue/82",
        icon: "text-sky-700 dark:text-frost-blue/82",
        rule: "from-frost-blue/35 to-transparent",
      };
    case "data":
      return {
        border: "border-l-amber-500",
        kicker: "text-amber-700 dark:text-amber-400",
        icon: "text-amber-700 dark:text-amber-400",
        rule: "from-amber-500/35 to-transparent",
      };
    case "insight":
      return {
        border: "border-l-emerald-500",
        kicker: "text-emerald-700 dark:text-emerald-400",
        icon: "text-emerald-700 dark:text-emerald-400",
        rule: "from-emerald-500/35 to-transparent",
      };
    case "classification":
      return {
        border: "border-l-violet-500",
        kicker: "text-violet-700 dark:text-violet-400",
        icon: "text-violet-700 dark:text-violet-400",
        rule: "from-violet-500/35 to-transparent",
      };
    default:
      return {
        border: "border-l-zinc-500",
        kicker: "text-muted-foreground",
        icon: "text-muted-foreground",
        rule: "from-border to-transparent",
      };
  }
}

export interface TonalSectionProps {
  eyebrow: string;
  title: string;
  tone: TonalSectionTone;
  children: ReactNode;
  contentClassName?: string;
}

export function TonalSection({ eyebrow, title, tone, children, contentClassName }: TonalSectionProps) {
  const toneClasses = getToneClasses(tone);

  return (
    <Card className={cn("rounded-xl border-l-[3px]", toneClasses.border)}>
      <CardHeader className="space-y-2">
        <div className="flex items-center gap-3">
          <p className={cn("pharos-kicker", toneClasses.kicker)}>{eyebrow}</p>
          <div className={cn("h-px flex-1 bg-gradient-to-r", toneClasses.rule)} />
        </div>
        <CardTitle as="h2">{title}</CardTitle>
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Re-wire `/about` to import from the shared primitive**

Edit `src/app/about/page.tsx`:

1. Replace the local `AboutTone` type alias with an import + alias from the new primitive:

```typescript
import { TonalSection, getToneClasses, type TonalSectionTone } from "@/components/tonal-section";

type AboutTone = TonalSectionTone;
```

2. Delete the in-file `getToneClasses` function (lines ~84–122).
3. Delete the in-file `AboutSection` function (lines ~181–208).
4. Add `const AboutSection = TonalSection;` next to the other local helpers so existing call sites (and `AboutFeatureSection`, which calls `AboutSection`) keep working without rewrites. Match-existing-style: do not rename call sites in this task — only the underlying definition moves.

- [ ] **Step 4: Visually verify `/about` is unchanged**

```bash
npm run dev
# In another shell:
curl -s http://localhost:3000/about/ | grep -c 'pharos-kicker'
```

Expected: count matches the count from main (run the same curl on the main branch to compare). If it differs by more than 1, the extraction altered DOM shape — diff and fix before moving on.

Also load `http://localhost:3000/about` in the browser and spot-check: every section card still has its colored left border, the kicker line, the gradient rule, and the `<h2>` title. Tone-by-tone: `brand` (frost-blue), `data` (amber), `insight` (emerald), `classification` (violet).

- [ ] **Step 5: Commit**

```bash
git add src/components/tonal-section.tsx src/app/about/page.tsx
git commit -m "refactor(tonal-section): extract AboutSection+getToneClasses for /funding reuse"
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

(Frontend components import wallet/ENS/freshness constants from `@shared/lib/funding/constants` directly — no `src/lib/funding-config-shim.ts` file. `shared/*` is already runtime-neutral and whitelisted in the root tsconfig paths.)

**Reuse contract (verified before writing this task):**

- `Skeleton` primitive lives at `src/components/ui/skeleton.tsx` (`data-slot="skeleton"`, `bg-accent animate-pulse` by default). Loading blocks must use it, not raw `animate-pulse rounded-xl bg-muted/40`.
- `getToneClasses("brand"|"insight"|"data"|"classification"|"neutral")` is exported from `@/components/tonal-section` (Task 14.5). KPI cards consume this directly.
- `timeAgo(epochSec)` is exported from `@shared/lib/format` (returns `"just now" | "Nm ago" | "Nh ago" | "Nd ago"`). Use it in both the chart freshness banner and the donor wall — no in-component `formatRelative` duplicates.
- `chart-primitives.tsx` exports `CategoricalXAxis`, `MonoYAxis`, and `ChartGrid`. The tooltip primitive lives in `pharos-chart-tooltip.tsx` (`PharosChartTooltip`, `TooltipLabel`, `TooltipRow`). `pharos-chart-stage` is a CSS class (in `globals.css`), not a component — wrap the chart container in a `<div className="pharos-chart-stage">`.
- Chart colors must come from `@/lib/chart-colors` (`CHART_GREEN`, `CHART_HEIGHT`), not hex literals.
- The data-availability banner pattern is `rounded-md border px-4 py-2.5 text-sm border-border/60 bg-muted/40 text-muted-foreground` (see `src/components/stablecoin-detail/distribution-section.tsx` for a live use). Stale-chain warnings use this above the chart, not as a small muted line below.

- [ ] **Step 1: KPI row test**

Create `src/components/funding/__tests__/funding-kpi-row.test.tsx`:

```typescript
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FundingKpiRow } from "../funding-kpi-row";
import type { FundingKpis } from "@shared/lib/funding/types";

const KPIS: FundingKpis = {
  current_month_coverage_pct: 42,
  current_month_community_usd: 701,
  current_month_total_usd: 701,
  current_month_target_usd: 1676.85,
  trailing_3mo_avg_coverage_pct: 38,
  total_community_lifetime_usd: 4321,
  total_founder_subsidy_usd: 12_000,
  distinct_community_donors_lifetime: 7,
  is_cold_start: false,
};

describe("FundingKpiRow", () => {
  it("renders three KPIs with rounded percentages and contextual secondaries", () => {
    render(<FundingKpiRow kpis={KPIS} monthlySeriesLength={6} />);
    // This-month KPI: rounded percentage (no decimals), then "$X of $Y covered"
    expect(screen.getByText("This month coverage")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("$701 of $1,677 covered")).toBeInTheDocument();
    // Trailing 3-month KPI
    expect(screen.getByText("Trailing 3-month average")).toBeInTheDocument();
    expect(screen.getByText("38%")).toBeInTheDocument();
    expect(screen.getByText("trailing 3-month coverage")).toBeInTheDocument();
    // Community donations KPI
    expect(screen.getByText("Community donations")).toBeInTheDocument();
    expect(screen.getByText(/from 7 supporters/)).toBeInTheDocument();
  });

  it("uses cold-start copy when this month has no donations yet", () => {
    render(
      <FundingKpiRow
        kpis={{ ...KPIS, is_cold_start: true, current_month_community_usd: 0, current_month_total_usd: 0, current_month_coverage_pct: 0 }}
        monthlySeriesLength={1}
      />,
    );
    expect(screen.getByText("Tracking begins")).toBeInTheDocument();
    expect(screen.getByText("First month in flight")).toBeInTheDocument();
  });

  it("uses cold-start copy when no community donors exist yet", () => {
    render(
      <FundingKpiRow
        kpis={{ ...KPIS, distinct_community_donors_lifetime: 0, total_community_lifetime_usd: 0 }}
        monthlySeriesLength={6}
      />,
    );
    expect(screen.getByText("Be the first")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: KPI row implementation**

Create `src/components/funding/funding-kpi-row.tsx`:

```typescript
import type { FundingKpis } from "@shared/lib/funding/types";
import { Card, CardContent } from "@/components/ui/card";
import { getToneClasses, type TonalSectionTone } from "@/components/tonal-section";
import { cn } from "@/lib/utils";

const USD_COMPACT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

interface KpiCardProps {
  kicker: string;
  primary: string;
  secondary: string;
  tone: TonalSectionTone;
  primaryIsNumeric: boolean;
}

function KpiCard({ kicker, primary, secondary, tone, primaryIsNumeric }: KpiCardProps) {
  const toneClasses = getToneClasses(tone);
  return (
    <Card className={cn("rounded-xl border-l-[3px]", toneClasses.border)}>
      <CardContent className="space-y-1 p-4">
        <p className={cn("pharos-kicker", toneClasses.kicker)}>{kicker}</p>
        <p
          className={cn(
            "text-2xl font-semibold tracking-tight text-foreground",
            primaryIsNumeric && "font-mono tabular-nums",
          )}
        >
          {primary}
        </p>
        <p className="text-xs text-muted-foreground">{secondary}</p>
      </CardContent>
    </Card>
  );
}

export interface FundingKpiRowProps {
  kpis: FundingKpis;
  /** Length of the monthly series — drives the "First month in flight" branch. */
  monthlySeriesLength: number;
}

export function FundingKpiRow({ kpis, monthlySeriesLength }: FundingKpiRowProps) {
  // KPI 1 — This month coverage
  const thisMonth = kpis.is_cold_start
    ? { primary: "Tracking begins", secondary: "first donations will appear here", numeric: false }
    : {
        primary: `${Math.round(kpis.current_month_coverage_pct)}%`,
        secondary: `${USD_COMPACT.format(kpis.current_month_community_usd)} of ${USD_COMPACT.format(kpis.current_month_target_usd)} covered`,
        numeric: true,
      };

  // KPI 2 — Trailing 3-month average
  const trailing = monthlySeriesLength < 3
    ? { primary: "First month in flight", secondary: "trailing window builds with the next two months", numeric: false }
    : {
        primary: `${Math.round(kpis.trailing_3mo_avg_coverage_pct)}%`,
        secondary: "trailing 3-month coverage",
        numeric: true,
      };

  // KPI 3 — Community donations (excludes founder subsidy)
  const community = kpis.distinct_community_donors_lifetime === 0
    ? { primary: "Be the first", secondary: "community support starts here", numeric: false }
    : {
        primary: USD_COMPACT.format(kpis.total_community_lifetime_usd),
        secondary: `from ${kpis.distinct_community_donors_lifetime} supporters since launch`,
        numeric: true,
      };

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <KpiCard
        kicker="This month coverage"
        primary={thisMonth.primary}
        secondary={thisMonth.secondary}
        tone="brand"
        primaryIsNumeric={thisMonth.numeric}
      />
      <KpiCard
        kicker="Trailing 3-month average"
        primary={trailing.primary}
        secondary={trailing.secondary}
        tone="insight"
        primaryIsNumeric={trailing.numeric}
      />
      <KpiCard
        kicker="Community donations"
        primary={community.primary}
        secondary={community.secondary}
        tone="data"
        primaryIsNumeric={community.numeric}
      />
    </div>
  );
}
```

- [ ] **Step 3: Chart implementation**

The chart renders **stacked bars** (`community_donations_usd` + `founder_subsidy_usd`) with `costs_usd` as a `ReferenceLine`, not as opposing red bars. Stale-chain warnings live in a banner ABOVE the chart using the project's data-availability pattern. Two footer links sit side by side beneath the chart.

Constants (`FUNDING_CHAIN_FRESHNESS_WARN_SECONDS`, `PHAROS_FUNDING_ENS`, `PHAROS_FUNDING_WALLET_DISPLAY`) are imported from `@shared/lib/funding/constants` — there is no shim. Worker and frontend share the same source of truth.

Create `src/components/funding/funding-monthly-chart.tsx`:

```typescript
"use client";

import { Bar, BarChart, Legend, ReferenceLine, ResponsiveContainer, Tooltip } from "recharts";
import { CategoricalXAxis, ChartGrid, MonoYAxis } from "@/components/chart-primitives";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import type { ChainFreshnessEntry, FundingMonthlyPoint } from "@shared/lib/funding/types";
import { CHART_GREEN, CHART_HEIGHT, CHART_SLATE } from "@/lib/chart-colors";
import { timeAgo } from "@shared/lib/format";
import { FUNDING_CHAIN_FRESHNESS_WARN_SECONDS } from "@shared/lib/funding/constants";

const USD_AXIS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const USD_TOOLTIP = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

interface Props {
  series: FundingMonthlyPoint[];
  chainFreshness: ChainFreshnessEntry[];
  lastSyncedAt: number;
  /** Cost target, used as a reference line. Falls back to the latest costs_usd on the series if 0. */
  monthlyTargetUsd: number;
}

interface FundingTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: FundingMonthlyPoint }>;
}

function FundingTooltip({ active, payload }: FundingTooltipProps) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  const total = point.community_donations_usd + point.founder_subsidy_usd;
  return (
    <PharosChartTooltip active>
      <TooltipLabel>{point.month}</TooltipLabel>
      <TooltipRow color={CHART_GREEN} label="Community" value={USD_TOOLTIP.format(point.community_donations_usd)} />
      <TooltipRow color={CHART_SLATE} label="Founder subsidy" value={USD_TOOLTIP.format(point.founder_subsidy_usd)} />
      <TooltipRow label="Costs" value={USD_TOOLTIP.format(point.costs_usd)} />
      <TooltipRow label="Donors" value={String(point.donor_count)} />
      <TooltipRow label="Total" value={USD_TOOLTIP.format(total)} bold />
    </PharosChartTooltip>
  );
}

export function FundingMonthlyChart({ series, chainFreshness, lastSyncedAt, monthlyTargetUsd }: Props) {
  const now = Math.floor(Date.now() / 1000);
  const stale = chainFreshness.filter(
    (c) => c.last_success_at > 0 && now - c.last_success_at > FUNDING_CHAIN_FRESHNESS_WARN_SECONDS,
  );
  const referenceValue = monthlyTargetUsd > 0
    ? monthlyTargetUsd
    : series.length > 0 ? series[series.length - 1].costs_usd : 0;

  return (
    <div className="space-y-3">
      {stale.length > 0 ? (
        <div className="rounded-md border px-4 py-2.5 text-sm border-border/60 bg-muted/40 text-muted-foreground">
          {stale.length === 1
            ? `${stale[0].chain} sync stale — last update ${timeAgo(stale[0].last_success_at)}.`
            : `Sync stale on ${stale.map((c) => c.chain).join(", ")}.`}
        </div>
      ) : null}
      <div className={`pharos-chart-stage ${CHART_HEIGHT}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <ChartGrid />
            <CategoricalXAxis dataKey="month" />
            <MonoYAxis tickFormatter={(v: number) => USD_AXIS.format(v)} width={70} />
            <Tooltip content={<FundingTooltip />} cursor={{ fill: "currentColor", opacity: 0.05 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="community_donations_usd" name="Community" stackId="donations" fill={CHART_GREEN} radius={[0, 0, 0, 0]} />
            <Bar dataKey="founder_subsidy_usd" name="Founder subsidy" stackId="donations" fill={CHART_SLATE} fillOpacity={0.7} radius={[3, 3, 0, 0]} />
            {referenceValue > 0 ? (
              <ReferenceLine
                y={referenceValue}
                stroke="var(--color-muted-foreground)"
                strokeDasharray="4 4"
                label={{ value: `Costs ${USD_AXIS.format(referenceValue)}`, position: "right", fill: "var(--color-muted-foreground)", fontSize: 11 }}
              />
            ) : null}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <a
          href="https://github.com/TokenBrice/stablecoin-dashboard/blob/main/docs/funding-page.md#pricing-methodology"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          How USD amounts are computed →
        </a>
        <a
          href="/api/funding-summary"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          View raw data →
        </a>
        {lastSyncedAt > 0 ? <span>Last sync {timeAgo(lastSyncedAt)}</span> : null}
      </div>
    </div>
  );
}
```

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
  it("renders categories with subtotals, total, and the volunteer footer line", () => {
    render(<CostBreakdown items={ITEMS} />);
    expect(screen.getByText(/Ike/)).toBeInTheDocument();
    expect(screen.getByText(/\$1,500/)).toBeInTheDocument();
    expect(screen.getByText(/Volunteer/)).toBeInTheDocument();
    expect(screen.getByText(/CoinGecko/)).toBeInTheDocument();
    expect(screen.getByText(/\$1,629/)).toBeInTheDocument();
    expect(
      screen.getByText("Brice's time is the bet; community support funds Ike and infra."),
    ).toBeInTheDocument();
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
                <span className="font-mono tabular-nums text-muted-foreground">{USD.format(item.usd_per_month)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="flex items-baseline justify-between border-t border-border/60 pt-2">
        <p className="text-sm font-medium text-foreground">Monthly total</p>
        <p className="font-mono text-sm font-medium tabular-nums text-foreground">{USD.format(total)}/m</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Brice&apos;s time is the bet; community support funds Ike and infra.
      </p>
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
import type { ChainFreshnessEntry, FundingDonorWallEntry } from "@shared/lib/funding/types";

const NOW = Math.floor(Date.now() / 1000);

const DONORS: FundingDonorWallEntry[] = [
  {
    address: "0xabcdef0000000000000000000000000000000000",
    display: "alice.eth",
    total_usd: 250.5,
    most_recent_at: NOW - 3600,
    most_recent_chain: "ethereum",
    explorer_url: "https://etherscan.io/address/0xabc",
  },
];

const FRESHNESS: ChainFreshnessEntry[] = [
  { chain: "ethereum", last_success_at: NOW - 1800, last_attempt_at: NOW - 1800, last_error: null },
  { chain: "base", last_success_at: NOW - 1800, last_attempt_at: NOW - 1800, last_error: null },
  { chain: "optimism", last_success_at: NOW - 1800, last_attempt_at: NOW - 1800, last_error: null },
  { chain: "arbitrum", last_success_at: NOW - 1800, last_attempt_at: NOW - 1800, last_error: null },
  { chain: "polygon", last_success_at: NOW - 1800, last_attempt_at: NOW - 1800, last_error: null },
  { chain: "gnosis", last_success_at: NOW - 1800, last_attempt_at: NOW - 1800, last_error: "rate limited" },
];

describe("DonorWall", () => {
  it("renders donor displays linked via the chain-aware explorer URL", () => {
    render(<DonorWall donors={DONORS} chainFreshness={FRESHNESS} lastSyncedAt={NOW - 1800} />);
    const link = screen.getByRole("link", { name: /alice\.eth/ });
    expect(link).toHaveAttribute("href", "https://etherscan.io/address/0xabc");
    expect(screen.getByText(/\$250\.50/)).toBeInTheDocument();
    expect(screen.getByText(/1h ago/)).toBeInTheDocument();
  });

  it("renders the empty state with a freshness sub-line derived from chain_freshness", () => {
    render(<DonorWall donors={[]} chainFreshness={FRESHNESS} lastSyncedAt={NOW - 1800} />);
    expect(screen.getByText("No community donations yet.")).toBeInTheDocument();
    expect(screen.getByText(/Last sync .* · 5\/6 chains healthy/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Donor wall implementation**

Create `src/components/funding/donor-wall.tsx`:

```typescript
import { ExternalLink } from "lucide-react";
import type { ChainFreshnessEntry, FundingDonorWallEntry } from "@shared/lib/funding/types";
import { timeAgo } from "@shared/lib/format";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

interface DonorWallProps {
  donors: FundingDonorWallEntry[];
  chainFreshness: ChainFreshnessEntry[];
  lastSyncedAt: number;
}

function freshnessSummary(chainFreshness: ChainFreshnessEntry[], lastSyncedAt: number): string {
  const total = chainFreshness.length;
  const healthy = chainFreshness.filter((c) => c.last_error === null && c.last_success_at > 0).length;
  const lastSync = lastSyncedAt > 0 ? timeAgo(lastSyncedAt) : "pending";
  return `Last sync ${lastSync} · ${healthy}/${total} chains healthy`;
}

export function DonorWall({ donors, chainFreshness, lastSyncedAt }: DonorWallProps) {
  if (donors.length === 0) {
    return (
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">No community donations yet.</p>
        <p className="text-[11px] text-muted-foreground">{freshnessSummary(chainFreshness, lastSyncedAt)}</p>
      </div>
    );
  }
  return (
    <ul className="space-y-2 text-sm">
      {donors.map((d) => (
        <li key={d.address} className="flex items-baseline justify-between gap-3">
          <a
            href={d.explorer_url}
            target="_blank"
            rel="noopener noreferrer"
            className="pharos-focus-ring inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
          >
            {d.display}
            <ExternalLink className="h-3 w-3" />
          </a>
          <span className="flex items-baseline gap-3 text-muted-foreground">
            <span className="font-mono tabular-nums">{USD.format(d.total_usd)}</span>
            <span className="text-xs">{timeAgo(d.most_recent_at)}</span>
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

Expected: 6 tests pass (3 KPI row + 1 cost breakdown + 2 donor wall).

- [ ] **Step 9: Commit**

```bash
git add src/components/funding/
git commit -m "feat(funding): KPI row, chart, cost breakdown, donor wall components"
```

---

## Task 16: Components — support CTAs + year-end horizon

**Files:**
- Create: `src/components/funding/support-ctas.tsx`
- Create: `src/components/funding/year-end-horizon.tsx`

**Voice & layout contract (consolidated from copy + design review):**

- CTA card titles use bare nouns: `Wallet`, `Giveth`, `Star on GitHub`, `Share`, `Contribute`, `Flag bad data`. No verbs in titles.
- Two visual tiers. Financial CTAs (Wallet, Giveth) are larger cards with a frost-blue accent border, sitting on top in a 2-card row. The four non-monetary CTAs collapse into a compact strip below — single row of four narrower cards (`grid-cols-2 lg:grid-cols-4`) under a kicker label `Other ways to help`.
- Wallet card displays the truncated address `0x5d69…860DB` in the button (full address in `aria-label`); shows six chain badges below; description stays one line.
- Copy-to-clipboard feedback uses `aria-live="polite"` on a status element, not a footer toggle.
- Footer line below all CTAs is the tightened version (one sentence). The verbose explainer is gone.
- Year-end horizon is a single paragraph; the meta-commentary second paragraph is dropped. `out of pocket → directly`; `the honest scoreboard → the honest ledger`.
- `@shared/lib/funding/constants` is the single source of truth for `PHAROS_FUNDING_ENS`, `PHAROS_FUNDING_WALLET`, `PHAROS_FUNDING_WALLET_DISPLAY` — imported directly by this file.

- [ ] **Step 1: Support CTAs**

Create `src/components/funding/support-ctas.tsx`:

```typescript
"use client";

import { useState } from "react";
import { ExternalLink, Flag, Heart, Star, Wallet, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import { FeedbackModal } from "@/components/feedback-modal";
import { cn } from "@/lib/utils";
import Image from "next/image";
import { PHAROS_FUNDING_ENS, PHAROS_FUNDING_WALLET, PHAROS_FUNDING_WALLET_DISPLAY } from "@shared/lib/funding/constants";
import { formatAddress } from "@shared/lib/format";
import { CHAIN_META } from "@shared/lib/chains";
import type { FundingChain } from "@shared/lib/funding/types";

const GIVETH_URL = "https://giveth.io/project/pharos-watch:-transparent-stablecoins-analytics";
const GITHUB_URL = "https://github.com/TokenBrice/stablecoin-dashboard";

// Chain ids in the order they render in the wallet card badges.
const SUPPORTED_CHAINS: FundingChain[] = ["ethereum", "base", "optimism", "arbitrum", "polygon", "gnosis"];

// Address truncation uses the shared formatAddress helper — no local copy.
interface CtaCardProps {
  icon: typeof Wallet;
  title: string;
  description: string;
  action: React.ReactNode;
  emphasized?: boolean;
}

function CtaCard({ icon: Icon, title, description, action, emphasized }: CtaCardProps) {
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-2 rounded-xl border bg-background/40 p-4",
        emphasized
          ? "border-l-[3px] border-l-frost-blue border-border/60"
          : "border-border/60",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className={cn("h-4 w-4", emphasized ? "text-sky-700 dark:text-frost-blue/82" : "text-foreground")} />
        <p className="text-sm font-medium text-foreground">{title}</p>
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="mt-auto pt-2">{action}</div>
    </div>
  );
}

export function SupportCtas() {
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  return (
    <section id="how-to-support">
      <div className="space-y-6">
        {/* Financial tier — larger, frost-blue accent */}
        <div className="grid gap-3 sm:grid-cols-2">
          <CtaCard
            icon={Wallet}
            title="Wallet"
            description={`${PHAROS_FUNDING_ENS} resolves to the same address on every supported chain. ETH, stablecoins, and other ERC-20 tokens are accepted.`}
            emphasized
            action={
              <div className="space-y-2">
                <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background px-3 py-1.5">
                  <span className="flex-1 truncate font-mono text-xs">
                    {formatAddress(PHAROS_FUNDING_WALLET_DISPLAY)}
                  </span>
                  <CopyButton text={PHAROS_FUNDING_WALLET_DISPLAY} />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {SUPPORTED_CHAINS.map((c) => {
                    const meta = CHAIN_META[c];
                    return (
                      <span
                        key={c}
                        className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px]"
                      >
                        {meta?.logoPath ? (
                          <Image src={meta.logoPath} alt="" width={12} height={12} />
                        ) : null}
                        {meta?.name ?? c}
                      </span>
                    );
                  })}
                </div>
              </div>
            }
          />
          <CtaCard
            icon={Heart}
            title="Giveth"
            description="A public-goods funding platform. Donations route to the same wallet; the page surfaces them under a 'via Giveth' label."
            emphasized
            action={
              <Button asChild variant="outline" className="min-h-9 w-full justify-between">
                <a href={GIVETH_URL} target="_blank" rel="noopener noreferrer">
                  Giveth
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
            }
          />
        </div>

        {/* Decision guide under the two financial cards */}
        <p className="text-xs text-muted-foreground leading-relaxed">
          Easiest: wallet — same address on every chain. Cheapest gas: Base or Gnosis.
          Via Giveth: supports their public-goods pool; donations arrive at the wallet
          and appear on the wall as a single "via Giveth" entry.
        </p>

        {/* Non-monetary tier — compact strip (3 cards, no Share in v1) */}
        <div className="space-y-2">
          <p className="pharos-kicker text-muted-foreground">Other ways to help</p>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
            <CtaCard
              icon={Star}
              title="Star on GitHub"
              description="A star helps others find Pharos when they search GitHub."
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
              icon={Wrench}
              title="Contribute"
              description="MIT-licensed. Issues and PRs welcome."
              action={
                <Button asChild variant="outline" className="min-h-9 w-full justify-between">
                  <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noopener noreferrer">
                    GitHub issues
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
              }
            />
            <CtaCard
              icon={Flag}
              title="Flag bad data"
              description="Report data issues or mis-classifications via the feedback form."
              action={
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-9 w-full justify-between"
                  onClick={() => setFeedbackOpen(true)}
                >
                  Feedback
                  <Flag className="h-3.5 w-3.5" />
                </Button>
              }
            />
          </div>
        </div>
      </div>
      <FeedbackModal open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </section>
  );
}
```

- [ ] **Step 2: Year-end horizon**

Create `src/components/funding/year-end-horizon.tsx`:

```typescript
const SHARE_URL =
  "https://x.com/intent/tweet?text=" +
  encodeURIComponent("Pharos — independent stablecoin analytics, MIT-licensed. https://pharos.watch");

export function YearEndHorizon() {
  return (
    <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
      <p>
        Pharos aims to fund itself by the end of 2026 without subsidy from Brice. Until then, he covers the gap
        directly. We review trajectory each quarter — if it is clearly behind, this paragraph will say so rather than
        leave the commitment stale.
      </p>
      <p className="text-xs">
        If you can&apos;t support financially, {" "}
        <a
          href={SHARE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          sharing Pharos
        </a>{" "}
        helps others find it.
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/funding/support-ctas.tsx src/components/funding/year-end-horizon.tsx
git commit -m "feat(funding): support CTAs + year-end horizon copy block"
```

---

## Task 17: Page — `/funding/page.tsx`

**Files:**
- Create: `src/app/funding/page.tsx`
- Create: `src/app/funding/funding-page-client.tsx`
- Create: `src/app/funding/error.tsx`
(FAQ is a small internal helper inside `funding-page-client.tsx` — no separate file.)

**Wiring contract:**

- All four content sections wrap their components in `TonalSection` (from `@/components/tonal-section`, see Task 14.5), not raw `Card+CardHeader+CardTitle`. Tones: cost = `data`, donor = `insight`, CTAs = `brand`, year-end = `brand`. The year-end card intentionally reuses `brand` (frost-blue), NOT `classification` (violet) — violet is reserved sitewide for the governance-tier semantic and would conflict here.
- Card titles: `Monthly costs`, `Recent supporters`, `How to support`, `Path to sustainability`. Declarative, descriptive — no directive verbs.
- The KPI row receives `monthlySeriesLength` so it can branch into the "First month in flight" copy when the trailing window is incomplete (see Task 15 Step 2).
- The chart receives `monthlyTargetUsd` derived from `kpis.current_month_target_usd` so the cost reference line is always pinned to the canonical monthly cost figure (matches the spec's `$1,677` reference).
- Top-level wrapper uses `space-y-8` to match `/about`'s rhythm (verified — `src/app/about/page.tsx:438` wraps content in `<div className="space-y-8">`).
- Skeleton blocks use the shared `Skeleton` primitive (`@/components/ui/skeleton`, `data-slot="skeleton"`) and mirror the live layout (kicker line + primary line + secondary line per KPI card; section header + body lines per section) so the page does not visually jump on hydration.
- Inline-error and error-boundary copy: `"Funding data is temporarily unavailable."` only — no `"Please try again shortly."` follow-on. The hook already auto-refetches.
- Page metadata description drops the redundant "sustains/sustainability" pairing.

- [ ] **Step 1: Server component shell with metadata**

Create `src/app/funding/page.tsx`:

```typescript
import type { Metadata } from "next";
import { FundingPageClient } from "./funding-page-client";
import { FeaturePageShell } from "@/components/feature-page-shell";

export const metadata: Metadata = {
  title: "Funding — Pharos",
  description: "On-chain donations, running costs, and Pharos's path to being fully community-funded.",
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
        "An honest ledger of what Pharos costs to run, what supporters cover, and where we are on the path to a self-funded project.",
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
import { TonalSection } from "@/components/tonal-section";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// FundingFaq is defined below as a small internal helper — not a separate
// file — because it is purely static content with no reuse.

export function FundingPageClient() {
  const { data, isLoading, error } = useFundingSummary();

  if (isLoading) return <FundingPageSkeleton />;
  if (error || !data) {
    return <p className="text-sm text-muted-foreground">Funding data is temporarily unavailable.</p>;
  }

  return (
    <div className="space-y-8">
      {/* Inline muted skip-link for willing supporters. Sits above the KPI row,
          under the lead paragraphs rendered by FeaturePageShell. */}
      <p className="text-xs text-muted-foreground">
        <a href="#how-to-support" className="underline underline-offset-2 hover:text-foreground">
          Skip to how to support →
        </a>
      </p>
      <FundingKpiRow kpis={data.kpis} monthlySeriesLength={data.monthly_series.length} />
      <Card className="rounded-xl">
        <CardContent className="p-4">
          <FundingMonthlyChart
            series={data.monthly_series}
            chainFreshness={data.chain_freshness}
            lastSyncedAt={data.last_synced_at}
            monthlyTargetUsd={data.kpis.current_month_target_usd}
          />
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <TonalSection eyebrow="Where it goes" title="Monthly costs" tone="data">
          <CostBreakdown
            items={data.line_items}
            currentCommunityUsd={data.kpis.current_month_community_usd}
            currentFounderUsd={data.kpis.current_month_founder_subsidy_usd}
            lifetimeFounderUsd={data.kpis.total_founder_subsidy_usd}
            costLastReviewedAt={data._meta.cost_last_reviewed_at}
          />
        </TonalSection>
        <TonalSection eyebrow="Supporters" title="Recent supporters" tone="insight">
          <DonorWall
            donors={data.recent_donors}
            chainFreshness={data.chain_freshness}
            lastSyncedAt={data.last_synced_at}
            totalDistinctCommunityDonors={data.kpis.distinct_community_donors_lifetime}
          />
        </TonalSection>
      </div>
      <TonalSection eyebrow="Get involved" title="How to support" tone="brand">
        <SupportCtas />
      </TonalSection>
      <TonalSection eyebrow="Questions" title="FAQ" tone="neutral">
        <FundingFaq />
      </TonalSection>
      <TonalSection eyebrow="Where we're going" title="Path to sustainability" tone="brand">
        <YearEndHorizon />
      </TonalSection>
    </div>
  );
}

/**
 * Compact FAQ block. Three Q/A pairs, plain prose (no accordion) so the
 * content is immediately scannable. Total body ≤ 80 words per design.md.
 */
function FundingFaq() {
  const qa: Array<{ q: string; a: string }> = [
    {
      q: "Is my donation tax-deductible?",
      a: "No — Pharos is not a registered charity. Giveth donations may qualify in some jurisdictions; check Giveth's documentation.",
    },
    {
      q: "What do supporters get?",
      a: "Public recognition on the wall unless you ask for a custom label. All Pharos features stay free for everyone — there is no paid tier.",
    },
    {
      q: "What happens to donations if Pharos stops operating?",
      a: "The MIT-licensed code and the on-chain ledger remain available. Donations are non-refundable.",
    },
  ];
  return (
    <dl className="space-y-3">
      {qa.map(({ q, a }) => (
        <div key={q} className="space-y-1">
          <dt className="text-sm font-medium text-foreground">{q}</dt>
          <dd className="text-sm text-muted-foreground">{a}</dd>
        </div>
      ))}
    </dl>
  );
}

function FundingPageSkeleton() {
  return (
    <div className="space-y-8">
      {/* KPI row — kicker + primary + secondary per card */}
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="rounded-xl border-l-[3px] border-l-border/40">
            <CardContent className="space-y-2 p-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-32" />
              <Skeleton className="h-3 w-40" />
            </CardContent>
          </Card>
        ))}
      </div>
      {/* Chart */}
      <Card className="rounded-xl">
        <CardContent className="p-4">
          <Skeleton className="h-72 w-full" />
        </CardContent>
      </Card>
      {/* Cost + donor row */}
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i} className="rounded-xl border-l-[3px] border-l-border/40">
            <CardContent className="space-y-3 p-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-32 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
      {/* CTAs */}
      <Card className="rounded-xl border-l-[3px] border-l-border/40">
        <CardContent className="space-y-3 p-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-28 w-full" />
        </CardContent>
      </Card>
      {/* Year-end */}
      <Card className="rounded-xl border-l-[3px] border-l-border/40">
        <CardContent className="space-y-3 p-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
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
      <p>Funding data is temporarily unavailable.</p>
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

## Whitelisted pricing assets

To prevent a spoofed-ticker spam token (attacker deploys "USDC" at a custom address) from getting a bogus market_data.current_price.usd cached into `funding_price_cache`, pricing only runs for a code-reviewed whitelist of assets. Every other ERC20 routes to `price_source='zero-no-price'` with `usd_at_receipt=0` and is excluded from dollar totals.

Current whitelist (per-chain contract map lives in `worker/src/lib/funding/coingecko-historical.ts` `PRICED_ASSETS`):

- **Native assets:** ETH (Ethereum, Base, Optimism, Arbitrum), MATIC (Polygon), xDAI (Gnosis)
- **ERC20:** WETH, USDC, USDT, DAI, WBTC (chain-by-chain canonical deployments)

Expanding the whitelist is a code change, not a JSON edit.

## Data ingestion

- Daily cron (`sync-funding-donations`) fires at 07:00 UTC, isolated trigger.
- Each chain processed sequentially under Cloudflare's 6-connection budget; per-chain failure does not abort siblings. Response bodies are drained via `cancelResponseBodyQuietly` on every exit path.
- `funding_chain_sync` records per-chain freshness + block-number cursor + last error; the `chain_freshness` field on the API surfaces it to the page.
- ENS reverse resolution is forward-verified: a name is displayed only when forward resolution returns the same address (standard practice against spoofed reverse records). Cache TTL is 30 days. Per-run resolutions are capped at 50 (top-ranked by recency + total_usd) to keep the worker inside its 30s CPU budget.

## Ownership & cadence

Three files are manually maintained; stale data makes the page lie. Commitments:

- `shared/data/funding/cost-line-items.json` — reviewed by @TokenBrice on the 1st of each month. The `last_reviewed_at` field is surfaced on the page footer so readers can see freshness at a glance.
- `shared/data/funding/spam-denylist.json` — reviewed within 7 days of any new inbound transfer that lands on the donor wall unexpectedly (airdrop noise).
- `shared/data/funding/donor-labels.json` — updated within 48h of any labeled-donor request (founder addresses, pool contracts, or named community supporters).

## Source code

- Worker subsystem: `worker/src/lib/funding/`, `worker/src/cron/sync-funding-donations.ts`, `worker/src/api/funding-summary.ts`
- Frontend: `src/app/funding/`, `src/components/funding/`, `src/hooks/use-funding-summary.ts`
- Shared: `shared/lib/funding/`, `shared/data/funding/`, `shared/lib/api-endpoints/schemas/funding-summary.ts`
- D1 schema: `worker/migrations/0106_funding_tables.sql`

## Methodology version

Current version: **1**. Bump `FUNDING_METHODOLOGY_VERSION` (in `shared/lib/funding/data.ts`) whenever pricing, spam filter, or attribution rules change materially. Per CLAUDE.md, version numbers are numeric, not semver — v1 → v1.1 → v2.

## Spec & history

Implementation lives in the source paths above; design rationale is in the repo's `agents/plans/` notes for 2026-04-18.
```

- [ ] **Step 2: Update api-reference.md**

Read `docs/api-reference.md` first and match the depth of the `peg-summary` entry (response shape reference, cache semantics, freshness headers, example envelope). Add:

```markdown
### `GET /api/funding-summary`

Returns the entire `/funding` page payload: KPIs (community-only coverage, community/founder split, uncovered gap), trailing-12-month series with per-month cost snapshots, cost line items, top-20 most-recent ENS-resolved donors, and per-chain freshness.

**Cron:** `sync-funding-donations` runs daily at 07:00 UTC.
**Cache:** worker cache s-maxage 1h; browser max-age 5min; `Last-Modified` / `X-Data-Age` freshness headers via `addFreshnessHeaders`.
**Schema:** `fundingSummaryResponseSchema` in `shared/lib/api-endpoints/schemas/funding-summary.ts` (strict-contract; Zod-validated).
**Response type:** `FundingSummaryResponse` (see `shared/lib/funding/types.ts`).
**Example:**
\`\`\`json
{
  "kpis": { "current_month_coverage_pct": 18, "current_month_community_usd": 300, ... },
  "monthly_series": [ { "month": "2026-04", ... } ],
  "line_items": [ ... ],
  "recent_donors": [ ... ],
  "chain_freshness": [ { "chain": "ethereum", "last_success_at": 1744934400, ... } ],
  "last_synced_at": 1744934400,
  "_meta": { "funding_methodology_version": 1, "cost_last_reviewed_at": 1744934400 }
}
\`\`\`
```

Also add a row to the main endpoint table (top of the file, typically lines 13–80) with `GET /api/funding-summary | Donations vs costs for the /funding page` matching the format of adjacent rows.

- [ ] **Step 3: Update architecture.md**

Read `docs/architecture.md` first. Add a row to the main API-endpoint table (lines 13–80) for `GET /api/funding-summary`. Then add a short section under the existing subsystem list:

```markdown
### Funding subsystem

A daily worker cron (`sync-funding-donations`, 07:00 UTC, isolated trigger, sequential chain processing) ingests inbound transfers to `pharos-watch.eth` across 6 chains (Ethereum/Base/OP/Arbitrum/Polygon via Alchemy `getAssetTransfers`, Gnosis via Gnosisscan REST — paginated via `page`/`offset`). Donations are USD-priced via CoinGecko historical (Pro or Demo tier per `normalizeCgApiKey`), restricted to a code-reviewed whitelist of priced assets (ETH/WETH/USDC/USDT/DAI/WBTC/xDAI/MATIC) to prevent spoofed-ticker spam from poisoning the price cache. Donations are aggregated monthly into `funding_monthly` (finalized=1 locks the snapshot at month close). Per-chain freshness lives in `funding_chain_sync`. The `/api/funding-summary` endpoint serves the entire `/funding` page payload from D1. See `docs/funding-page.md` for the pricing methodology, ownership cadence, and whitelist.
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
# Alchemy: pass explicit fromBlock so the smoke test doesn't scan from
# genesis (slow, wasteful); "0x0" is acceptable only because the wallet
# currently has ~1 inbound tx. Switch to a recent block once volume grows.
curl -sS "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"alchemy_getAssetTransfers\",\"params\":[{\"toAddress\":\"$ADDR\",\"fromBlock\":\"0x0\",\"category\":[\"external\",\"internal\",\"erc20\"],\"withMetadata\":true,\"order\":\"asc\"}]}" \
  | jq '.result.transfers | length'
# Polygon/Optimism: note the category list drops "internal" (not supported)
# Gnosisscan: paginated probe — assert status is "1" or "0", not "NOTOK".
curl -sS "https://api.gnosisscan.io/api?module=account&action=tokentx&address=$ADDR&page=1&offset=10&apikey=$GNOSISSCAN_API_KEY" | jq '.status, .message'
```

Expected: Alchemy returns at least 1 (the known inbound tx); Gnosisscan returns `"1"` with `"OK"` or `"0"` with `"No transactions found"` — NOT `"NOTOK"` (rate-limit) or a `"Max rate limit reached"` message.

- [ ] **Step 3: Run the cron locally end-to-end**

```bash
cd worker && npx wrangler dev
```

In a second shell, trigger the scheduled handler. The exact path depends on Wrangler version — verify with:

```bash
cd worker && npx wrangler dev --help 2>&1 | grep -A2 'scheduled\|test-scheduled' | head -10
```

For Wrangler ≥3.x the local URL is typically `http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+7+*+*+*`. For older versions it may be `/__scheduled`. Use whichever the help output indicates:

```bash
curl -X POST "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+7+*+*+*"
```

Expected: Worker logs include `[funding] sync complete:` with `per_chain` entries for all 6 chains.

- [ ] **Step 4: Verify the API**

```bash
curl -s http://localhost:8787/api/funding-summary | jq '{ kpis, recent_donor_count: (.recent_donors | length), chain_freshness_count: (.chain_freshness | length), is_cold_start: .kpis.is_cold_start }'
```

Expected: `chain_freshness_count == 6`, and `kpis.current_month_target_usd == 1676.85`. `is_cold_start` should be `true` until the first community donation arrives (Brice's labeled founder address does not count). `recent_donor_count` will be `0` until the first community donation arrives.

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
