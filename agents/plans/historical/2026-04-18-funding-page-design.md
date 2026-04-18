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
- A `/funding/` page using Layout B (KPI dashboard) — three KPI cards on top, monthly bar chart, two-column cost breakdown + ENS-resolved donor wall, full-width support CTAs, compact FAQ, closing year-end horizon.
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
- "Share Pharos" CTA — dropped from v1 as off-mission for a funding page; sharing is mentioned once as an inline link in the year-end horizon instead.
- Donor privacy opt-out — public chain addresses are public by construction; donors who need privacy use a privacy-preserving wallet path.

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
  GET /api/funding-summary  (cached payload, Zod-validated,
                             wrapped in withErrorHandler +
                             addFreshnessHeaders — matches
                             peg-summary shape)
    { kpis:          { community_only coverage %,
                       community $ this month + lifetime,
                       founder subsidy $ this month + lifetime,
                       uncovered $ this month (= gap to target),
                       trailing 3-mo community coverage %,
                       is_cold_start },
      monthly_series (per-month costs_usd included so chart can
                      render cost history as a step line),
      line_items,
      recent_donors, chain_freshness, last_synced_at,
      _meta: { funding_methodology_version, cost_last_reviewed_at } }
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
  { "label": "Brice",               "category": "team",  "usd_per_month": 0,       "note": "Uncompensated until Pharos is self-funded" },
  { "label": "CoinGecko API",       "category": "infra", "usd_per_month": 129,     "note": "Analyst tier" },
  { "label": "Alchemy",             "category": "infra", "usd_per_month": 40,      "note": "Pay-as-you-go, ~$40 typical" },
  { "label": "Cloudflare Workers",  "category": "infra", "usd_per_month": 5,       "note": "Paid plan" },
  { "label": "Domain registration", "category": "infra", "usd_per_month": 2.85,    "note": "pharos.watch, annualized" }
]
```

`shared/data/funding/donor-labels.json` — explicit labels and roles for known senders (founder subsidy, Giveth pool, etc.):

```json
[
  { "address": "0xYourEOA...lowercased", "label": "TokenBrice (founder subsidy)", "kind": "founder" },
  { "address": "0xGivethPool...lowercased", "label": "via Giveth", "kind": "pool" }
]
```

The `kind` field drives separation in the API: `"founder"` is excluded from the `distinct_donors_lifetime` count and the `community_donations_usd` series, but kept in the chart as a separate stacked layer. `"pool"` (Giveth) counts as community. Unspecified donors are treated as community by default. (Giveth pool address added after on-chain confirmation during implementation.)

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
    "An honest ledger of what Pharos costs to run, what supporters
     cover, and where we are on the path to a self-funded project."
    (Immediately below: one inline muted link "Skip to how to support →"
     anchored to #how-to-support, so a willing supporter doesn't
     have to scroll through four sections to find the wallet.)

  children:
    <FundingKpiRow />                         (3 cards, side-by-side)
      KPI math is COMMUNITY-ONLY. The founder subsidy is not
      mixed into coverage %. The uncovered gap is the founder
      subsidy, not a hidden number — we surface it explicitly.

      • This month coverage        (tone: brand)
        Primary:   "Y%"  where Y = community_usd / target * 100
        Secondary: "$X community · $Z founder · $W uncovered"
                   (when community covers target, $W = 0 and
                    founder line drops off; when community is
                    short, $W equals the founder subsidy to date
                    this month.)
        Cold-start: primary = "Tracking begins",
                    secondary = "this month's donations will
                    populate as they arrive"

      • Community donations         (tone: insight)
        Primary:   "$X.X k"  (total community lifetime, excludes founder)
        Secondary: "from N supporters since tracking began"
        Cold-start: primary = "No community donations yet",
                    secondary = "the wall and chart will populate
                    as they arrive"

      • Trailing 3-month coverage   (tone: data)
        Primary:   "Y%"  (community / cost average over 3 months)
        Secondary: "average of the last 3 months"
        Cold-start: primary = "First month in flight",
                    secondary = "average appears once 3 months
                    of data exist"

    <FundingMonthlyChart />                    (full width, Recharts)
      • Stacked bars per month:
          - community_donations_usd (emerald, foreground)
          - founder_subsidy_usd (muted slate, stacked on top)
      • Cost reference is a per-month step line (not a flat
        horizontal reference) driven by each row's costs_usd so
        historical months with different costs render honestly.
        Uses Recharts <Line dataKey="costs_usd" type="stepAfter"
        dot={false} stroke=foreground/high-contrast/>.
      • Trailing 12 months, sliding window. Months with zero data
        before the cron's first successful run are omitted; the
        x-axis starts at the first month with any cost or donation.
      • Tooltip: community, founder, costs, donors, total per month.
      • Chart wrapper must carry role="img" and an aria-label
        describing the chart (matches repo's chart accessibility
        pattern — see radar-chart.tsx, flow-chart.tsx).
      • Footnote beneath chart (two rows):
          Row 1: "Pricing methodology →" (links to methodology
                  section of docs/funding-page.md) · "View raw
                  data →" (links to /api/funding-summary) ·
                  "View on Etherscan →" (links the wallet address).
          Row 2: "Last sync Xh ago" in `pharos-meta` style.
      • If any chain in chain_freshness is older than 36h, render a
        muted banner ABOVE the chart (data-availability pattern):
        "Gnosis sync is behind — last updated 2d ago."
        Multi-chain case: "2 chains are behind sync — Gnosis (2d),
        Polygon (4d)."
      • Reuses chart-primitives.tsx (CategoricalXAxis, MonoYAxis,
        PharosChartTooltip, pharos-chart-stage); colors come from
        chart tokens, not hex literals.

    <CostBreakdown />  |  <DonorWall />        (two-column)
      Cost panel (tone: data):
        • Line items in 2 groups (Team, Infrastructure)
        • Total: "$1,676.85/m"
        • Footer line (two stacked lines, `pharos-meta`):
            "This month: $X community · $Y founder subsidy."
            "Lifetime founder subsidy: $Z."
          Makes the founder contribution a visible number, not
          a muted stack segment only.
        • Short volunteer note on Brice's $0 row only (text from
          cost-line-items.json note field).
      Donor wall (tone: insight):
        • Top 20 most recent community donors (excludes founder
          subsidy from the wall; founder line surfaces only in the
          chart and the cost-breakdown footer above)
        • Display: ENS name (if forward-verified) OR shared
          `formatAddress(addr)` helper (0x5d6983...860DB format)
        • Custom labels from donor-labels.json applied
        • USD amount + relative time + chain-aware explorer link
        • Overflow footer: when
          distinct_community_donors_lifetime > 20, render
          "Showing most recent 20 of N supporters. View full
          history →" linking to /api/funding-summary.
        • Empty state: "No community donations yet." plus a subtle
          freshness line ("Last sync Xh ago · 6/6 chains healthy").

    <SupportCtas />                            (full width, TonalSection tone: brand)
      Anchor: id="how-to-support" so the skip-link above targets it.
      Two visually distinct tiers:
        Financial (top, larger cards with frost-blue accent):
          • Wallet:  pharos-watch.eth + copy button + 6-chain
                     badges (using CHAIN_META.logoPath per chain,
                     not plain text)
          • Giveth:  external link + one-line factual description
                     (no matching-bait, no "quadratic" jargon in
                     the user-facing card — plain explanation).
        Under the two financial cards, a 3-line decision guide
        in `text-xs text-muted-foreground` (not a heading):
          "Easiest: wallet — same address on every chain.
           Cheapest gas: Base or Gnosis.
           Via Giveth: supports their public-goods pool; arrives
           at the wallet as 'via Giveth' in the wall."
        Other ways to help (compact strip, 3 cards — Share is
        dropped, see Out of scope):
          • Star on GitHub
          • Contribute (open issues)
          • Flag bad data (opens <FeedbackModal />)

    <FundingFaq />                             (TonalSection tone: neutral)
      A 3-question FAQ in an accordion or simple stacked Q/A block.
      Question/answer pairs:
        Q: "Is my donation tax-deductible?"
        A: "No — Pharos is not a registered charity. Giveth
            donations may qualify in some jurisdictions; check
            Giveth's documentation."
        Q: "What do supporters get?"
        A: "Public recognition on the wall unless you ask for
            a custom label. All Pharos features stay free for
            everyone — there is no paid tier."
        Q: "What happens to donations if Pharos stops operating?"
        A: "The MIT-licensed code and the on-chain ledger remain
            available. Donations are non-refundable."
      Keep under ~80 words total across all three answers.

    <YearEndHorizon />                         (closing TonalSection, tone: brand)
      Single paragraph, no meta-commentary:
      "Pharos aims to fund itself by the end of 2026 without
       subsidy from Brice. Until then, he covers the gap
       directly. We review trajectory each quarter — if it's
       clearly behind, this paragraph will say so rather than
       leave the commitment stale."
      Followed by a single-line closing in `pharos-meta`:
      "If you can't support financially, sharing Pharos helps
       others find it." — this is the only Share surface on
       the page.
```

**Component reuse:**
- `FeaturePageShell` (existing)
- `AboutSection` (existing — extracted to a generic `<TonalSection>` in `src/components/tonal-section.tsx` since /funding uses seven tonal section cards; `/about` is migrated to import from the new primitive by direct rename, not by a local alias)
- `MetricStatCard` (existing — `src/components/metric-stat-card.tsx`) — KPI cards consume this, not a hand-rolled KpiCard
- `CopyButton` (existing — `src/components/copy-button.tsx`) — wallet CTA uses this directly (icon-swap + aria-label flip), no hand-rolled clipboard + aria-live region
- `formatAddress()` from `@shared/lib/format` — all address truncation (wallet CTA, donor wall fallback) goes through this; do not define local truncate helpers
- `CHAIN_META` from `shared/lib/chains.ts` — 6-chain badges in the wallet CTA use `logoPath` per chain, not plain text
- `buildExplorerUrl()` from `shared/lib/explorer.ts` — donor wall explorer links come from this; do not hardcode per-chain URL builders in the plan's config file (the plan's `ETHERSCAN_*_URL_BY_CHAIN` constants should be dropped in favor of this helper)
- `<FeedbackModal />` and existing feedback-button infrastructure (existing)
- `chart-primitives.tsx` (`CategoricalXAxis`, `MonoYAxis`, `ChartGrid`) + `pharos-chart-tooltip.tsx` (`PharosChartTooltip`, `TooltipLabel`, `TooltipRow`) + `pharos-chart-stage` CSS class — required, no hand-rolled axes
- `Skeleton` primitive (`data-slot="skeleton"`), not raw `animate-pulse`
- `getToneClasses()` exported alongside `TonalSection` — any additional tonal surface (KPI card, FAQ card) consumes this, not hand-typed tone classes
- `timeAgo()` from `@shared/lib/format` — no in-component formatRelative duplicates
- Lucide icons (no emoji): `Wallet`, `Heart`, `Star`, `Wrench`, `Flag` (Share icon is removed — no Share CTA in v1)

**Loading & empty states:**
- Loading: `Skeleton` primitive blocks mirroring the live layout — KPI row as three `MetricStatCard`-shaped placeholders (kicker + primary + secondary); chart as `h-72 w-full`; two-column cost+donor row as ~6 narrow rows each (not a single `h-32` block) so the hydration transition doesn't jump; CTAs as two cards stacked on three compact ones; FAQ as three short rows; horizon as one paragraph block.
- Empty current month: cold-start KPI branch (above) handles it; donor wall shows "No community donations yet." plus freshness line.
- Sparse history (<3 months): KPI cold-start branches replace metrics with "Tracking begins" / "First month in flight" / "No community donations yet" copy; chart starts at the first non-empty month rather than padding the past with empty bars.
- Cold-start is gated on `is_cold_start = (lifetime_community_total === 0)` at the API level; KPI-by-KPI branching uses that flag + `monthlySeriesLength < 3` so branches stay consistent.

## Edge cases & operational details

| Edge case | Handling |
|---|---|
| Spam tokens (airdropped scams) | Per-chain denylist `spam-denylist.json`. On insert, set `is_spam=1`. Excluded from totals + donor wall. |
| Internal txns (ETH from a contract) | Alchemy `getAssetTransfers` `category: 'internal'`. For Gnosis, Gnosisscan `txlistinternal`. |
| Giveth payout flow | Confirmed during implementation: identify the Giveth payout contract address, label its sends as "via Giveth" through `donor-labels.json` so the wall doesn't show "0xGivethContract" repeatedly. |
| Refunds / outbound returns | Manual `is_refund=1` flag on the donation row (admin operation, no automated detection). Excluded from totals when set. |
| Same address donating multiple times | Donor wall coalesces by `from_address` (sum, latest timestamp). Distinct-donor count uses `COUNT(DISTINCT from_address)`. |
| Token with no CoinGecko historical price | Fall back to current spot price; tag `price_source='coingecko-spot-fallback'`. If still no price, set `usd_at_receipt=0` and `price_source='zero-no-price'`; **do not** flag as spam (an unknown long-tail token is not spam — exclude from totals via `usd_at_receipt > 0` filter instead). |
| Spam token with a spoofed CoinGecko match | An attacker-deployed token using a legitimate-asset symbol could get matched by CoinGecko's contract→id endpoint and carry a bogus price. Mitigation: pricing only runs for a hardcoded whitelist of known good tokens (ETH, WETH, USDC, USDT, DAI, WBTC, xDAI, MATIC) by per-chain coin-id table; every other ERC20 defaults to `zero-no-price` and is excluded from dollar totals via `usd_at_receipt > 0`. Expansion of the whitelist is a reviewed code change, not a JSON edit. |
| Founder subsidy attribution | Donor labels carry a `kind` field. Rows whose sender matches a `kind: "founder"` label are excluded from `distinct_community_donors_lifetime`, `community_donations_usd`, and the donor wall, but are included in the chart as a separate stacked series AND as explicit lines in the CostBreakdown footer ("This month: $X community · $Y founder subsidy" + "Lifetime founder subsidy: $Z") and in the KPI1 secondary. The founder number is never hidden or only-derivable. |
| Founder EOA + Giveth labels seeded before first cron | `donor-labels.json` must carry Brice's EOA (`kind: "founder"`) BEFORE the first production cron run, otherwise the inbound tx counts as community and the promotion-gate criterion fails. Implementation plan sequences this explicitly (see Task 12 reordered to run before the ingestion cron is armed). Giveth pool labels can be added later after a test donation confirms the pool address. |
| Coverage KPI math | Coverage % is COMMUNITY-ONLY (`community_usd / target * 100`), not `(community + founder) / target`. The latter always reads ~100% because the founder by definition closes the gap, and that reading contradicts the transparency goal. The uncovered gap equals the founder subsidy (until community surpasses target) and is surfaced as an explicit KPI secondary and cost-breakdown footer line, not implied. |
| Cost evolution across the 12-month window | The chart renders `costs_usd` as a per-month step line (`<Line type="stepAfter" />`) driven by each row's stored `costs_usd`, NOT as a single flat reference line at the current $1,677 target. Finalized months keep the cost snapshot that was canonical when they closed; the current month reflects today's `cost-line-items.json`. This honors `funding_monthly.finalized=1`. |
| ENS resolutions per run | ENS eth_calls on the single L1 endpoint are capped at 50 per cron run, prioritized by `LIMIT 50` over distinct senders ordered by `MAX(block_timestamp) DESC` and `SUM(usd_at_receipt) DESC`. Uncapped fan-out would burn worker CPU on spammy days (200+ distinct senders). Top-20 donor wall is always fully resolved. |
| Donor wall overflow | The wall shows the 20 most-recent community donors. When `distinct_community_donors_lifetime > 20`, the wall renders a footer row: "Showing most recent 20 of N supporters. View full history →" linking to `/api/funding-summary`. |
| Verifiability affordance | The page exposes a "View raw data →" link to `/api/funding-summary` beneath the chart so any reader can recompute the math from the JSON. Alongside it: "Pricing methodology →" linking to the in-repo methodology doc, and "View on Etherscan →" linking the wallet address. |
| Pricing methodology | Pinned in *Pricing methodology* under Architecture. Daily UTC close via `/coins/{id}/history`; intraday volatility not captured; disclosed on the page via methodology footnote. The exact CoinGecko plan (Analyst/Demo vs Pro) is confirmed during Task 4 implementation against the existing `normalizeCgApiKey` helper — the endpoint host + auth header follow whatever the repo already uses. |
| Per-chain sync failure | Recorded in `funding_chain_sync.last_error`; cron continues to next chain. `chain_freshness` in API payload exposes staleness; page renders a muted note when any chain is >36h stale. |
| ENS spoofing | Only display ENS when `forward_verified=1`. |
| ENS cache TTL | 30 days. Re-resolve on miss or expiry. |
| CoinGecko historical budget | Bounded by `funding_price_cache` — one call per (asset_key, date). |
| Cost line item changes mid-month | Edit JSON; current month recomputes. At month close, `funding_monthly.finalized=1` locks the snapshot so historical bars don't shift. Months with zero donations still get a finalized row so the chart's cost line has data points for every month since tracking began. |
| Wallet/ENS change | Constants live in `shared/lib/funding/constants.ts` (single source, imported by both worker and frontend). If the wallet ever changes, add the new address and aggregate both. |
| Manual-data drift | Cost line items, donor labels, and spam denylist are manual JSONs — drift makes the page lie. Ownership and cadence commitments live in `docs/funding-page.md` (reviewed 1st of each month; see *Documentation updates*). The cost JSON carries a `last_reviewed_at` field surfaced in the page footer so readers can see how fresh the cost snapshot is. |

## Voice & copy guidelines

- Match Pharos's existing /about voice: honest, plain, concrete. No campaign language, no urgency, no banners or modals.
- Replace donation-page tropes with concrete substitutions (implementers should not improvise):
  - "Donate now!" → "Support Pharos" (section heading) or "Wallet / Giveth" (card titles)
  - "Help us hit our goal!" → omit; the numbers already show the gap
  - "Every dollar matters" → omit entirely
  - "Join us" / "Be part of" → omit
  - "Your support" / "Without you" → factual equivalents: "community support", "supporters"
  - Rhetorical questions ("Spotted something off?") → declarative: "Report data issues via feedback."
- Prefer nouns over verbs in card titles (`Wallet`, `Giveth`, `Star on GitHub`, `Contribute`, `Flag bad data`). Action lives in the button label, not the card title.
- Numbers always shown with their context, not in isolation.
- Consistency:
  - Use "Brice" in body copy (matches the cost-line-item label). Use "founder" only when referring to the role itself (e.g., "founder subsidy" as a named stream).
  - Use "supporters" in user-facing copy, "donors" in schema/DB/engineering copy.
  - Monospace `pharos-watch.eth` and truncated addresses with backticks in code, use `font-mono tabular-nums` in JSX; never mix.
- The year-end horizon paragraph closes with a factual statement, not a CTA. It also commits to a quarterly review cadence so the commitment self-updates rather than going stale.
- Match `/about`'s tonal vocabulary: short, declarative sentences, no exclamation marks, no rhetorical questions.

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

- `docs/api-reference.md` — document `GET /api/funding-summary` with response schema reference, cache semantics, freshness headers, and an example envelope (match the depth of the peg-summary entry).
- `docs/architecture.md` — describe the funding subsystem (cron, tables, ingestion path) AND add a row to the main endpoint table (lines 13–80) for `GET /api/funding-summary`.
- `docs/funding-page.md` — new doc covering data ingestion notes; must include:
  - a `## Pricing methodology` section (linked from the page footnote) describing the daily-UTC-close pricing approach and CoinGecko endpoint used;
  - an `## Ownership & cadence` section committing to: cost-line-items.json reviewed by @TokenBrice on the 1st of each month (surfaced as `last_reviewed_at` in the JSON), spam-denylist.json reviewed within 7 days of any new inbound transfer, donor-labels.json updated within 48h of a labeled-donor request.
  - a `## Whitelisted assets` section naming the hardcoded pricing whitelist so expansion is a reviewed change, not a JSON edit.
- `docs/scripts.md` — if any new admin scripts are added (e.g. mark-refund), document them.
- `src/app/about/page.tsx` — add "Funding" to the data sources / pages list (`AboutFeatureRow`) **only after the stealth-release validation period**, not in v1. Simultaneously in the same follow-up PR: add a small "Support Pharos" link in the site footer and update the README's "About" section to reference `/funding/`.

## Stealth → promotion criteria

V1 ships `noindex` and unlinked. Promotion (nav entry, footer link, removing `noindex`, optionally announcing on the existing /about page and via @PharosWatch) is gated by these objective criteria, not vibes:

**Pipeline integrity (automated checks):**

- 14 consecutive successful daily cron runs across all 6 chains (`chain_freshness.last_success_at` within 36h for every chain), zero insert-skipped-duplicate increments in logs (tracked via `meta.changes` on `INSERT OR IGNORE`), monthly aggregate matches a manual recompute of the underlying donations.
- `/api/funding-summary` validated against the Zod schema returned without errors for 7 consecutive days.
- No false-positive spam flags: a manual review of the `funding_donations` table confirms no legitimate donation was incorrectly marked `is_spam=1`.
- Brice's labeled subsidy correctly excluded: API confirms `distinct_community_donors_lifetime` does NOT count the founder address.

**Strategic readiness (human checks):**

- Copy reviewed end-to-end by at least two people other than the plan authors, covering: lead paragraph, KPI cards and cold-start branches, year-end horizon paragraph, FAQ answers, all CTA card descriptions, and the stale-chain banner.
- Page walked on mobile (375px viewport) and desktop in both light and dark themes by at least one first-time user, with the prompt "tell me what this page is asking of you." If the reader feels pressured or misidentifies the goal, promotion is delayed until copy is reworked.

When all criteria are met (~3 weeks after deploy assuming nominal operation), promotion is a single follow-up PR: `AboutFeatureRow` entry + footer link + README mention + `metadata.robots` removal + FAQ JSON-LD (for SEO).

## Open questions / deferred

- Brice's EOA address for `donor-labels.json` — seeded BEFORE the first production cron run so the initial ingested tx labels correctly (see implementation plan Task 12 reordering).
- Giveth payout contract address per chain — confirmed at implementation time by inspecting one test donation.
- Initial spam-token denylist seed entries — left empty in v1; populated as observed (per the ownership cadence above).
- Whitelisted pricing assets — initial set is `{ETH, WETH, USDC, USDT, DAI, WBTC, xDAI, MATIC}`; any expansion is a reviewed code change.
- Navigation entry, footer link, README mention, and `noindex` removal — deferred until the promotion criteria above are met.
- Recurring crypto subscriptions (Hypersub/Drips), paid API tier, sponsor-a-line-item, fiat/card donation paths — explicitly out of scope per brainstorming decisions.
- Share CTA — removed from the CTA strip in v1; one inline `sharing Pharos` link lives in the year-end horizon closing line.

## Success criteria

- Page renders correctly with a single inbound transfer (current state) and remains coherent as more arrive.
- Daily cron picks up new transfers within 24h, no duplicate rows under retries, no false positives from spam tokens after the denylist is seeded.
- ENS donor wall shows verified names only; addresses without ENS render via shared `formatAddress()`.
- KPI numbers match a hand-computed audit of the underlying `funding_donations` rows; coverage % is community-only and never reads as ~100% while the founder still subsidizes.
- Founder subsidy is a visible number on the page (cost-breakdown footer + KPI1 secondary + chart tooltip), not only derivable from a stacked bar segment.
- Voice review: a reader who has never seen Pharos doesn't feel pressured to donate after reading the page; a willing supporter can reach the wallet in ≤2 clicks (skip-link + copy-button).
