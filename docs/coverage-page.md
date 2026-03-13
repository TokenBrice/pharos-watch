# Coverage Page

Contract for the public `/coverage/` route. This page explains which Pharos features are available per tracked stablecoin and gives users both count coverage and market-cap coverage.

---

## Purpose

The coverage page answers two questions:

1. Which Pharos features are available for a given stablecoin right now?
2. How broad is each feature across the tracked universe, by both coin count and tracked market cap?

The page is intentionally product-facing, not admin-facing. It should describe user-visible coverage, not internal cron health.

---

## Route Shape

- **Route:** `/coverage/`
- **Server shell:** `src/app/coverage/page.tsx`
- **Client implementation:** `src/app/coverage/client.tsx`
- **Error boundary:** `src/app/coverage/error.tsx`
- **Core helpers:** `src/lib/coverage.ts`

The page uses `FeaturePageShell` and is indexable like the rest of the public feature surfaces.

---

## Coverage Dimensions

The matrix currently exposes these columns:

- `Price & Depeg`
- `Safety Score`
- `DEX Price`
- `Reserves`
- `Yield`
- `Flows`
- `Blacklist`
- `Bluechip`
- `Dependency Map`

Status semantics are intentionally user-facing:

- `Price & Depeg`: `Tracked`, `Price only` (NAV-priced assets), or `Missing`
- `Safety Score`: `Rated` or `NR`
- `DEX Price`: `Primary`, `Mixed`, `Fallback`, `Legacy`, `NR`, or `Unknown`
- `Reserves`: `Live`, `Curated`, `Estimated`, or `None`
- `Yield`: `Ranked` or `—`
- `Flows`: `Full`, `Partial`, `Lagging`, `Bootstr.` , `Disabled`, or `—`
- `Blacklist`: `Tracked` or `—`
- `Bluechip`: grade (`A`, `B+`, etc.) or `—`
- `Dependency Map`: `Node` or `—`

---

## Source Of Truth Per Column

The page deliberately mixes structural coverage and live dataset coverage:

| Column | Source |
|-------|--------|
| `Price & Depeg` | `/api/peg-summary` plus `StablecoinMeta.flags.navToken` |
| `Safety Score` | `/api/report-cards` |
| `DEX Price` | `/api/dex-liquidity` (`coverageClass`) |
| `Reserves` | `shared/lib/stablecoins.ts` + `getReserves()` from `shared/lib/reserve-templates.ts` |
| `Yield` | `/api/yield-rankings` |
| `Flows` | `/api/mint-burn-flows` aggregate `coins[].coverage.status` |
| `Blacklist` | `BLACKLIST_STABLECOINS` symbol allowlist from `@shared/types` |
| `Bluechip` | `/api/bluechip-ratings` |
| `Dependency Map` | `/api/report-cards` `dependencyGraph.edges` |

Current market-cap weights come from `/api/stablecoins` using `getCirculatingRaw()`.

---

## Feature Snapshot

The feature snapshot leads the page. It is the first stop for users who want to understand total Pharos coverage before drilling into individual assets.

Every row shows:

- covered coin count
- percent of tracked coins
- percent of tracked market cap
- a short per-feature breakdown
- direct link to the underlying surface when one exists

For `Reserves`, the headline metric intentionally emphasizes `Live` reserve tracking. Curated and estimated reserve views still appear in the breakdown so the row distinguishes true live coverage from metadata-only reserve composition.

Breakdowns are intentionally dense and should stay short:

- DEX: `primary / mixed / fallback`
- Reserves: `live / curated / estimated`
- Flows: `full / partial / bootstrapping`
- Price: `tracked / price-only`

If a feature gains richer user-facing states, update both `src/lib/coverage.ts` and this document.

---

## UX Contract

- The feature snapshot comes first and answers the breadth question before the page shifts into per-coin inspection.
- Search filters by name and ticker.
- Quick filters narrow the table to one major feature slice (`Live reserves`, `Yield`, `Flows`, `Blacklist`, `Bluechip`).
- Default sort is descending live market cap.
- On small screens, the matrix adapts into scan-first per-coin cards that preview the highest-signal statuses and expand for the remaining states.
- From `md` upward, the full comparison table renders with the first column sticky.
- The per-coin matrix comes second and is explicitly positioned as the asset-level drill-down surface.
- Coverage notes and the status legend live in an inline disclosure above the matrix, not in a separate explainer block.

The page should continue to render meaningfully when some live datasets are temporarily unavailable. In that case, the matrix still renders with structural coverage where possible and uses the shared stale-data banner to surface data-health issues.

---

## Update Rules

Update this page when any of the following change:

- a new user-facing feature becomes per-coin and has partial coverage
- an existing feature changes its coverage source of truth
- a status label or meaning changes
- the table gains or loses a column

If the change also affects route inventory, update [Architecture](./architecture.md) and the [Documentation Index](./README.md).
