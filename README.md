# Pharos — Stablecoin Analytics Dashboard

Public-facing analytics dashboard tracking 120+ stablecoins across multiple peg currencies, backing types, and governance models. Pure information site — no wallet connectivity, no user accounts.

**Live at [pharos.watch](https://pharos.watch)**

## Features

- **Three-tier classification** — stablecoins categorized as CeFi, CeFi-Dependent, or DeFi based on actual dependency on centralized infrastructure, not marketing claims
- **Multi-peg support** — USD, EUR, GBP, CHF, BRL, RUB, gold-pegged, and CPI-linked stablecoins with cross-currency FX-adjusted totals
- **Peg Tracker** — continuous peg monitoring with a composite Peg Score (0–100) for every tracked stablecoin, depeg event detection with direction tracking, deviation heatmaps, and a historical timeline going back 4 years
- **Freeze & Blacklist Tracker** — real-time on-chain tracking of USDC, USDT, EURC, PAXG, and XAUT freeze/blacklist events across Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC, and Tron with BigInt-precision amounts
- **Stablecoin Cemetery** — 62 dead stablecoins documented with cause of death, peak market cap, and obituaries
- **Detail pages** — price chart, supply history, and chain distribution for each stablecoin
- **Backing type breakdown** — RWA-backed, crypto-backed, and algorithmic
- **Yield-bearing & NAV token filters** — identify tokens that accrue yield natively
- **Research-grade data pipeline** — structural validation, supply sanity checks, concurrent write protection, depeg deduplication, and price validation guardrails
- **Dark/light mode**

## Tech Stack

- **Frontend:** Next.js 16 (App Router, static export), React 19, TypeScript (strict)
- **Styling:** Tailwind CSS v4, shadcn/ui (Radix primitives)
- **Charts:** TanStack Query, Recharts, TradingView Lightweight Charts
- **API:** Cloudflare Worker (cron-based data fetching + REST endpoints)
- **Database:** Cloudflare D1 (SQLite — caches stablecoin data, logos, blacklist events, depeg events)
- **Hosting:** Cloudflare Pages

## Data Sources

All external API calls go through the Cloudflare Worker. The frontend never calls external APIs directly.

| Source | Purpose | Refresh |
|--------|---------|---------|
| [DefiLlama](https://defillama.com/) | Stablecoin supply, price, chain distribution, history | 5 min |
| [CoinGecko](https://www.coingecko.com/) | Gold-pegged token data (XAUT, PAXG), fallback price enrichment, supply overrides | 5 min (as fallback) |
| [DexScreener](https://dexscreener.com/) | Best-effort price fallback via on-chain DEX pair data | On demand |
| [Etherscan v2](https://etherscan.io/) | USDC, USDT, EURC, PAXG, XAUT freeze/blacklist events (EVM chains) | 15 min |
| [TronGrid](https://www.trongrid.io/) | USDT freeze events on Tron | 15 min |
| [dRPC](https://drpc.org/) | Archive RPC for L2 balance lookups at historical block heights | 15 min |
| [Exchange Rate API](https://open.er-api.com/) | Live RUB/USD rate (ECB doesn't publish RUB) | 2 hours |
| [frankfurter.app](https://frankfurter.app/) | ECB FX rates for EUR, GBP, CHF, BRL peg validation | 2 hours |
| [Bluechip](https://bluechip.org/) | Independent stablecoin safety ratings (SMIDGE framework) | 6 hours |
| [DeFiLlama Yields](https://yields.llama.fi/) | DEX pool TVL, volume, and composition for liquidity scoring | 10 min |
| [Curve Finance API](https://api.curve.finance/) | Pool A-factors, per-token balances for quality-adjusted TVL | 10 min |

## Getting Started

### Frontend

```bash
npm install
NEXT_PUBLIC_API_BASE=http://localhost:8787 npm run dev
```

### Worker API

```bash
cd worker
npx wrangler dev
```

To trigger crons manually:

```bash
npx wrangler dev --remote --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

### Other commands

```bash
npm run build    # Production build (includes type-checking)
npm run lint     # ESLint
cd worker && npx tsc --noEmit   # Type-check worker
```

## Project Structure

```
src/                              Frontend (Next.js static export)
├── app/
│   ├── page.tsx                  Homepage: stats, charts, filters, table
│   ├── peg-tracker/              Peg monitoring: scores, heatmap, timeline
│   ├── blacklist/                Freeze & blacklist event tracker
│   ├── cemetery/                 Dead stablecoin graveyard
│   ├── stablecoin/[id]/          Detail page per stablecoin
│   └── about/                    About & methodology
├── components/                   UI components (table, charts, cards)
├── hooks/                        Data fetching hooks (TanStack Query)
└── lib/                          Types, formatters, peg score, stablecoin master list

worker/                           Cloudflare Worker (API + cron jobs)
├── src/
│   ├── cron/                     Scheduled data sync (DefiLlama, CoinGecko, Etherscan, TronGrid)
│   ├── api/                      REST endpoints
│   └── lib/                      D1 helpers
└── migrations/                   D1 SQL migrations (8 total, includes depeg dedup + unique constraint)
```

## Infrastructure

```
Cloudflare Worker (API layer)
  ├── Cron: */5 * * * *    → sync stablecoin data (DefiLlama + CoinGecko gold) + chart history
  └── Cron: */15 * * * *   → sync blacklist events (Etherscan/TronGrid/dRPC) + USDS status

Cloudflare D1 (SQLite database)
  ├── cache                → JSON blobs (stablecoin list, per-coin detail, charts, logos) with CAS write guard
  ├── blacklist_events     → normalized freeze/blacklist events
  ├── blacklist_sync_state → incremental sync progress (block numbers for EVM, timestamps for Tron)
  ├── depeg_events         → peg deviation events with unique constraint + direction tracking
  └── price_cache          → historical price snapshots for depeg detection

Cloudflare Pages
  └── Static export from Next.js
```

## Data Reliability

The data pipeline includes multiple guardrails designed for research-grade accuracy:

- **Structural validation** — API responses are validated for required fields before caching; malformed objects are dropped
- **Supply sanity floor** — cache writes are skipped if total tracked supply falls below $100B, preventing partial outages from showing $0 market cap
- **Price validation ordering** — unreasonable prices are rejected before entering the 24-hour price cache, not after
- **Concurrent write protection** — compare-and-swap cache writes prevent slow sync runs from overwriting newer data
- **Depeg deduplication** — unique constraint on `(stablecoin_id, started_at, source)` prevents duplicate events; overlapping intervals are merged when computing peg scores
- **BigInt precision** — blacklist amounts use BigInt division to avoid JavaScript floating-point precision loss above 2^53
- **Cross-currency totals** — non-USD stablecoin supplies are converted via derived FX rates, not summed at face value
- **Thin peg group fallbacks** — currencies with <3 qualifying coins fall back to approximate FX rates when the median appears depegged
- **Freshness header** — `/api/stablecoins` returns `X-Data-Updated-At` so consumers can detect stale data
- **Atomic backfill** — depeg event backfills use transactional batch operations to prevent data loss on worker crashes
- **Retry logic** — all external API fetches use exponential backoff with configurable 404 handling

## Deployment

Automated via GitHub Actions (`.github/workflows/deploy-cloudflare.yml`) on push to `main`:

1. **Worker:** `npm ci` → `d1 migrations apply` → `wrangler deploy`
2. **Pages:** `npm ci` → `npm run build` → `wrangler pages deploy out`

Required GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
Required GitHub variable: `API_BASE_URL`

Worker secrets (set via `wrangler secret put`): `ETHERSCAN_API_KEY`, `TRONGRID_API_KEY`, `DRPC_API_KEY`, `ADMIN_KEY`

## License

MIT
