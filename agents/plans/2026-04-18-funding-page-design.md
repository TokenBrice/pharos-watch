# Funding Page Design

**Date:** 2026-04-18
**Status:** Spec — pending implementation plan
**Owner:** TokenBrice
**Route:** `/funding/` (stealth release — no nav entry in v1)

## Goals

1. Provide users full transparency on what Pharos costs to operate, who bears those costs, and how supporters cover them.
2. Make the path to project sustainability legible through a monthly donations-vs-costs view.
3. Surface the ways someone can support Pharos (financial and non-financial) without ever being pushy.

## Non-goals

- Convert visitors aggressively. No banners, modals, urgency timers, or guilt copy.
- Replace the existing Feedback flow. The page links into it; it does not duplicate it.
- Track in-kind contributions of time. Brice's volunteer status is acknowledged in copy, not imputed as a number.
- Sponsor-a-line-item interaction (considered, dropped for v1).
- Paid API tier (deferred — all API access remains free in v1).
- Recurring crypto subscriptions like Hypersub (deferred — only Giveth is set up today).
- Fiat / card donation paths (firm no — out of scope for Pharos).

## In scope (v1)

- Live on-chain ingestion of inbound transfers to `pharos-watch.eth` (`0x5d698362EDb8AEa1C2b2483096BDeE3265D860DB`) across **6 chains**: Ethereum, Base, Optimism, Arbitrum, Polygon, Gnosis.
- A `/funding/` page using Layout B (KPI dashboard) — three KPI cards on top, monthly bar chart, two-column cost breakdown + ENS-resolved donor wall, full-width support CTAs, closing year-end horizon.
- Daily worker cron syncing donations and writing aggregates to D1.
- Single API endpoint serving the page: `GET /api/funding-summary`.
- Manual JSON files for cost line items and donor address labels.
- Hand-curated spam-token denylist per chain.

## Out of scope (deferred)

- Navigation links to `/funding/` (stealth release; add later after validation).
- Sponsor-a-line-item interactive widget.
- Hypersub / Drips / Splits-based recurring crypto support.
- Paid API tier as a funding stream.
- "Months Brice has subsidized" KPI (decided against in Q6).
- Imputed in-kind cost for Brice's volunteer time.

## Architecture & data flow

```
[Daily worker cron]                       [Page render path]
  funding/sync-donations.ts                 src/app/funding/page.tsx
    │                                         │
    │ For each of 6 chains:                   │ TanStack Query:
    │   • Alchemy alchemy_getAssetTransfers   │   useFundingSummary()
    │     (eth/base/op/arb/polygon)           │   GET /api/funding-summary
    │   • Gnosisscan API (gnosis)             │     staleTime: 24h
    │     - tokentx (ERC20)                   │     refetchInterval: 48h
    │     - txlist (native xDAI)              │     (per project hook timing rule)
    │     - txlistinternal (contract sends)   │
    │                                         │ Renders:
    │ For each new transfer:                  │   <FundingKpiRow />
    │   • dedup: PK (chain, tx_hash, log_idx) │   <FundingMonthlyChart />
    │   • spam-token denylist filter          │   <CostBreakdown /> | <DonorWall />
    │   • CoinGecko historical USD            │   <SupportCtas />
    │     price at receipt block date         │   <YearEndHorizon />
    │   • ENS reverse-resolve sender          │
    │     (Ethereum L1, with forward-verify)  │
    │                                         │
    │ Recompute monthly aggregate for         │
    │ affected month(s); finalize prior       │
    │ months on day 1 of new month.           │
    ▼
  D1: funding_donations,
      funding_monthly,
      funding_ens_cache,
      funding_price_cache,
      funding_chain_sync
    │
    ▼
  GET /api/funding-summary  (cached payload)
    { kpis, monthly_series, line_items,
      recent_donors, chain_freshness, last_synced_at }
```

**Key design choices**

- **Daily cron, not hourly.** Donations are low-frequency. Daily cadence keeps the Alchemy `getAssetTransfers` budget tiny and avoids hammering Gnosisscan free tier.
- **Alchemy `alchemy_getAssetTransfers` for 5/6 chains.** Single call per chain returns external + ERC20 + internal transfers to the wallet. Reuses existing Alchemy infrastructure.
- **Gnosisscan REST API for Gnosis.** Alchemy doesn't support Gnosis in our setup. Gnosisscan free tier is sufficient at expected volume; Blockscout is a backup if rate-limited.
- **CoinGecko historical pricing.** Reuses existing CoinGecko Analyst API key. One call per (token, date), cached in `funding_price_cache` to bound spend. Pricing methodology is pinned: see *Pricing methodology* below.
- **Single cached API endpoint.** `/api/funding-summary` returns the entire page payload. Matches the Pharos pattern (static export + client-side fetch via TanStack Query).
- **ENS forward-verified resolution.** Standard practice — only display an ENS name when forward resolution of that name returns the same address. Prevents spoofed reverse-record attacks.

### Cron execution model

The cron must respect Cloudflare's per-trigger 6-connection pool (see CLAUDE.md). With 6 chains plus CoinGecko historical and ENS L1 lookups, a naive parallel fan-out would exhaust the pool. Execution is therefore explicitly sequential and isolated:

- **Chains processed one at a time** — `for...of` loop; each chain's response body is fully consumed (or `cancelResponseBodyQuietly`'d) before the next chain's fetch opens. ENS lookups and CoinGecko historical calls run after all chains finish, then the monthly aggregate recompute runs last.
- **Per-chain failure isolation** — a chain that throws (Alchemy timeout, Gnosisscan 429, etc.) records the error in `funding_chain_sync.last_error` and the cron continues to the next chain. One bad chain never aborts the run.
- **Per-chain freshness exposed** — `funding_chain_sync` rows surface in the `/api/funding-summary` payload as `chain_freshness: { ethereum: ts, base: ts, ..., gnosis: ts }`. The page can show "Gnosis sync stale (2 days)" rather than failing silently.
- **Idempotency** — `funding_donations` PK on `(chain, tx_hash, log_index)` makes inserts idempotent under retry. Monthly aggregate uses `INSERT OR REPLACE` keyed on `month`. Re-running the cron the same day is safe.

### Pricing methodology

USD conversion is pinned to remove ambiguity and to match Pharos's reproducibility standards:

- **Endpoint:** CoinGecko `/coins/{id}/history?date=DD-MM-YYYY&localization=false` returning `market_data.current_price.usd` for that UTC day.
- **Granularity:** daily UTC close. Intraday volatility is **not** captured — a donation received at 23:55 UTC on day D is priced at the day-D close, not the day-D+1 close.
- **Timezone:** all `block_timestamp` values, month-boundary aggregations (`YYYY-MM`), and price-cache `price_date` keys are UTC. No local-time conversions anywhere in the pipeline.
- **Asset key:** `funding_price_cache.asset_key` is `<chain>:<asset_address|native>` lowercased, mapped to a CoinGecko coin id via the existing `CG_CHAIN_MAP` and detail-platform lookups already used by the stablecoin pipeline.
- **Disclosure:** the page renders a small "How USD amounts are computed" footnote beneath the monthly chart, linking to a methodology note in `docs/funding-page.md`. This mirrors how `/methodology` discloses peg-score and DEWS computation.

## Data model

### D1 tables

```sql
-- One row per inbound transfer; the audit log; powers donor wall + monthly aggregates.
CREATE TABLE funding_donations (
  chain TEXT NOT NULL,                    -- ethereum|base|optimism|arbitrum|polygon|gnosis
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,             -- 0 for native transfers; ERC20 log index otherwise
  block_number INTEGER NOT NULL,
  block_timestamp INTEGER NOT NULL,       -- unix seconds (UTC)
  from_address TEXT NOT NULL,             -- lowercased
  asset_symbol TEXT NOT NULL,             -- 'ETH', 'USDC', etc.
  asset_address TEXT,                     -- NULL for native; lowercased contract addr for ERC20
  amount_raw TEXT NOT NULL,               -- string for big-int safety
  amount_decimal REAL NOT NULL,           -- normalized by token decimals
  usd_at_receipt REAL NOT NULL,           -- amount_decimal * historical USD price
  price_source TEXT NOT NULL,             -- coingecko-historical|coingecko-spot-fallback|manual-override
  is_spam INTEGER NOT NULL DEFAULT 0,     -- spam-filter result; excluded from totals
  is_refund INTEGER NOT NULL DEFAULT 0,   -- manual flag if a donation gets refunded out
  notes TEXT,                             -- optional manual annotation
  inserted_at INTEGER NOT NULL,
  PRIMARY KEY (chain, tx_hash, log_index)
);
CREATE INDEX funding_donations_block_ts ON funding_donations(block_timestamp);
CREATE INDEX funding_donations_from ON funding_donations(from_address);

-- Monthly aggregate; denormalized for fast page render.
CREATE TABLE funding_monthly (
  month TEXT PRIMARY KEY,                 -- 'YYYY-MM'
  donations_usd REAL NOT NULL,            -- sum of non-spam, non-refund USD
  costs_usd REAL NOT NULL,                -- snapshot of cost line item total at month end
  donor_count INTEGER NOT NULL,           -- distinct from_address that month
  finalized INTEGER NOT NULL DEFAULT 0,   -- 1 once month closes (immutable historical record)
  computed_at INTEGER NOT NULL
);

-- ENS reverse-lookup cache (Ethereum L1 canonical resolver).
CREATE TABLE funding_ens_cache (
  address TEXT PRIMARY KEY,               -- lowercased
  ens_name TEXT,                          -- resolved name, or NULL if no name
  forward_verified INTEGER NOT NULL,      -- 1 if forward resolution of name returns this address
  resolved_at INTEGER NOT NULL            -- TTL boundary (30 days)
);

-- Per-chain sync cursor + freshness; powers chain_freshness in the API payload.
CREATE TABLE funding_chain_sync (
  chain TEXT PRIMARY KEY,                 -- one row per chain in scope
  last_block_seen INTEGER NOT NULL,       -- highest block scanned (incremental cursor)
  last_success_at INTEGER NOT NULL,       -- last cron run that succeeded for this chain
  last_attempt_at INTEGER NOT NULL,       -- last cron run that attempted this chain
  last_error TEXT                         -- NULL on success; error message on failure
);

-- Per-(asset, date) USD price cache to bound CoinGecko historical calls.
CREATE TABLE funding_price_cache (
  asset_key TEXT NOT NULL,                -- 'ethereum:0x...' or 'ethereum:native'
  price_date TEXT NOT NULL,               -- 'YYYY-MM-DD' (UTC)
  usd_price REAL NOT NULL,
  source TEXT NOT NULL,                   -- coingecko-historical|coingecko-spot-fallback
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (asset_key, price_date)
);
```

### Manually maintained JSON

`shared/data/funding/cost-line-items.json` — source of truth for current monthly costs:

```json
[
  { "label": "Ike",                 "category": "team",  "usd_per_month": 1500,    "note": "Growth & comms" },
  { "label": "Brice",               "category": "team",  "usd_per_month": 0,       "note": "Volunteer (uncompensated until Pharos is sustainable)" },
  { "label": "CoinGecko API",       "category": "infra", "usd_per_month": 129,     "note": "Analyst tier" },
  { "label": "Alchemy",             "category": "infra", "usd_per_month": 40,      "note": "Pay-as-you-go, ~$40 typical" },
  { "label": "Cloudflare Workers",  "category": "infra", "usd_per_month": 5 },
  { "label": "Domain registration", "category": "infra", "usd_per_month": 2.85 }
]
```

`shared/data/funding/donor-labels.json` — explicit labels for known senders (founder subsidy, Giveth pool, etc.):

```json
[
  { "address": "0xYourEOA...lowercased", "label": "TokenBrice (founder subsidy)" }
]
```

(Giveth pool address added after on-chain confirmation during implementation.)

`shared/data/funding/spam-denylist.json` — known spam ERC20 contracts per chain:

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

(Seeded empty; appended as we observe spam.)

`worker/src/lib/funding-config.ts` — recipient address constant:

```typescript
export const PHAROS_FUNDING_WALLET = "0x5d698362edb8aea1c2b2483096bdee3265d860db";
export const PHAROS_FUNDING_ENS = "pharos-watch.eth";
```

## Page structure

Route: `src/app/funding/page.tsx`. Wrapped in `FeaturePageShell` (matches /about). Single TanStack Query hook (`useFundingSummary`) backs the entire page.

```
FeaturePageShell
  breadcrumbName: "Funding"
  title: "Funding"
  leadParagraphs:
    "Pharos is a public good. This page is the honest ledger:
     what it costs, what supporters cover, and where we are on
     the path to sustainability."

  children:
    <FundingKpiRow />                         (3 cards, side-by-side)
      • This month coverage    (tone: brand)
        "$X / $1,677 covered (Y%)"
      • Trailing 3-month avg   (tone: insight)
        "Trending at Y% covered (3-mo avg)"
      • Total raised lifetime  (tone: data)
        "$X.X k from N donors"

    <FundingMonthlyChart />                    (full width, Recharts BarChart)
      • Paired bars per month: donations (green) vs costs (red)
      • Trailing 12 months, sliding window
      • Tooltip: month detail + donor count
      • Footnote beneath chart: "How USD amounts are computed →"
        links to docs/funding-page.md#pricing-methodology
      • If any chain in chain_freshness is older than 36h, render a
        small muted note (e.g. "Gnosis sync stale — last update 2d ago")

    <CostBreakdown />  |  <DonorWall />        (two-column)
      Cost panel (tone: data):
        • Line items in 2 groups (Team, Infrastructure)
        • Total: "$1,676.85/m"
        • Volunteer note for Brice's $0 row
      Donor wall (tone: insight):
        • Top 20 most recent (non-spam) donors
        • Display: ENS name (if forward-verified) OR truncated 0xabcd…1234
        • Custom labels from donor-labels.json applied
        • USD amount + relative time + Etherscan link

    <SupportCtas />                            (full width, AboutSection tone: brand)
      Six CTAs grouped into two rows for visual hierarchy:
        Financial (top row, 2 cards):
          • Wallet:  pharos-watch.eth + copy button + "ETH and ERC20 on 6 chains"
          • Giveth:  external link to the project (URL stripped of ?apcid)
        Non-monetary (bottom row, 4 cards):
          • Star on GitHub:  link to repo
          • Share Pharos:  pre-filled X share intent
          • Contribute:  link to GitHub issues
          • Flag bad data:  opens existing <FeedbackModal />

    <YearEndHorizon />                         (closing AboutSection, tone: classification)
      "Goal: sustainable funding by Dec 2026.
       Today, Brice covers the gap monthly. The aim is to retire
       that line by year-end through community support."
```

**Component reuse:**
- `FeaturePageShell` (existing)
- `AboutSection` (existing — extract to a generic `<TonalSection>` only if /funding ends up reusing it heavily)
- `<FeedbackModal />` and existing feedback-button infrastructure (existing)
- Recharts primitives from `chart-primitives.tsx` (existing)
- Skeleton primitives (existing)
- Tone classes from `getToneClasses()` (existing)
- Lucide icons (no emoji): `Wallet`, `Heart`, `Star`, `Share2`, `Wrench`, `Flag`

**Loading & empty states:**
- Loading: skeleton bars for chart, skeleton rows for donor wall, skeleton blocks for KPIs
- Empty current month ("no donations yet this month"): muted neutral copy, not an alarm
- Sparse history (1-2 months only): chart still renders, copy explains the page is new

## Edge cases & operational details

| Edge case | Handling |
|---|---|
| Spam tokens (airdropped scams) | Per-chain denylist `spam-denylist.json`. On insert, set `is_spam=1`. Excluded from totals + donor wall. |
| Internal txns (ETH from a contract) | Alchemy `getAssetTransfers` `category: 'internal'`. For Gnosis, Gnosisscan `txlistinternal`. |
| Giveth payout flow | Confirmed during implementation: identify the Giveth payout contract address, label its sends as "via Giveth" through `donor-labels.json` so the wall doesn't show "0xGivethContract" repeatedly. |
| Refunds / outbound returns | Manual `is_refund=1` flag on the donation row (admin operation, no automated detection). Excluded from totals when set. |
| Same address donating multiple times | Donor wall coalesces by `from_address` (sum, latest timestamp). Distinct-donor count uses `COUNT(DISTINCT from_address)`. |
| Token with no CoinGecko historical price | Fall back to current spot price; tag `price_source='coingecko-spot-fallback'`. If still no price, set `usd_at_receipt=0` and `is_spam=1`. |
| Pricing methodology | Pinned in *Pricing methodology* under Architecture. Daily UTC close via `/coins/{id}/history`; intraday volatility not captured; disclosed on the page via methodology footnote. |
| Per-chain sync failure | Recorded in `funding_chain_sync.last_error`; cron continues to next chain. `chain_freshness` in API payload exposes staleness; page renders a muted note when any chain is >36h stale. |
| ENS spoofing | Only display ENS when `forward_verified=1`. |
| ENS cache TTL | 30 days. Re-resolve on miss or expiry. |
| CoinGecko historical budget | Bounded by `funding_price_cache` — one call per (asset_key, date). |
| Cost line item changes mid-month | Edit JSON; current month recomputes. At month close, `funding_monthly.finalized=1` locks the snapshot so historical bars don't shift. |
| Wallet/ENS change | Constant in `worker/src/lib/funding-config.ts`. If it ever changes, add the new address and aggregate both. |

## Voice & copy guidelines

- Match Pharos's existing /about voice: honest, plain, concrete. No campaign language, no urgency, no banners or modals.
- Replace donation-page tropes:
  - "Donate now!" → "Support Pharos"
  - "Help us hit our goal!" → "Where we are vs sustainability"
  - "Every dollar matters" → omit entirely
- Numbers always shown with their context, not in isolation.
- The year-end horizon paragraph closes with a factual statement, not a CTA.
- Match `/about`'s tonal vocabulary: short, declarative sentences, no exclamation marks.

## Testing approach

Per Pharos's MEMORY.md "real fixtures, not mocks" rule:

- Pre-implementation: `curl` Alchemy `getAssetTransfers` and Gnosisscan `tokentx`/`txlist`/`txlistinternal` against the actual wallet; commit responses as fixtures.
- Unit tests:
  - Spam-token filter (matches denylist, excludes from totals)
  - ENS forward-verify logic (rejects mismatched forward resolution)
  - Monthly aggregation math (sum, distinct donor count, exclude is_spam/is_refund)
  - USD pricing fallback chain (historical → spot → zero+spam)
- Integration test: end-to-end ingest using fixtures, assert D1 state and `/api/funding-summary` response shape.
- Pre-deploy smoke: live `curl` to Alchemy and Gnosisscan; assert response field shapes haven't drifted.
- Coverage: ≥66% lines (project threshold).

## Documentation updates

Per CLAUDE.md operating rules:

- `docs/api-reference.md` — document `GET /api/funding-summary`
- `docs/architecture.md` — describe the funding subsystem (cron, tables, ingestion path)
- `docs/funding-page.md` — new doc covering data ingestion notes; must include a `## Pricing methodology` section (linked from the page footnote) describing the daily-UTC-close pricing approach and CoinGecko endpoint used
- `docs/scripts.md` — if any new admin scripts are added (e.g. mark-refund), document them
- `src/app/about/page.tsx` — add "Funding" to the data sources / pages list (`AboutFeatureRow`) **only after the stealth-release validation period**, not in v1

## Open questions / deferred

- Brice's EOA address for `donor-labels.json` — confirmed at implementation time
- Giveth payout contract address per chain — confirmed at implementation time by inspecting one Giveth donation
- Initial spam-token denylist seed entries — left empty in v1; populated as observed
- Navigation entry to `/funding/` — deferred until after stealth-release validation
- A "support Pharos" footer link — deferred to the same validation milestone

## Success criteria

- Page renders correctly with a single inbound transfer (current state) and remains coherent as more arrive.
- Daily cron picks up new transfers within 24h, no duplicate rows under retries, no false positives from spam tokens after the denylist is seeded.
- ENS donor wall shows verified names only; addresses without ENS show as `0xabcd…1234` with Etherscan link.
- KPI numbers match a hand-computed audit of the underlying `funding_donations` rows.
- Voice review: a reader who has never seen Pharos doesn't feel pressured to donate after reading the page.
