# Coverage Page Contract

Contract for the public `/coverage/` route. This page explains which Pharos features are available per active stablecoin and gives users both count coverage and market-cap coverage.

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
- **Structured data:** `src/app/coverage/page.tsx` emits `COVERAGE_FAQ_JSON_LD` through a JSON-LD `<script>` in the page shell

The page uses `createClientFeaturePage(...)`, which wraps the route in the shared feature-page shell for public client-heavy surfaces. It remains indexable like the rest of the public feature routes.

---

## Coverage Dimensions

The matrix currently exposes these columns:

- `Price & Depeg`
- `Safety Score`
- `DEX Price`
- `Live Reserves Sync`
- `Redemption Backstop`
- `Yield`
- `Flows`
- `Blacklist`
- `Dependency Map`

Status semantics are intentionally user-facing:

- `Price & Depeg`: `Tracked`, `Price only` (NAV-priced assets), or `Missing`
- `Safety Score`: `Rated` or `NR`
- `DEX Price`: `Primary`, `Mixed`, `Fallback`, `Legacy`, `NR`, or `Unknown`
- `Live Reserves Sync`: `Live`, `Curated`, `Estimated`, or `None`
- `Redemption Backstop`: `Issuer`, `PSM`, `Queue`, `Collat.`, `Stable`, `Basket`, `Heur.`, `Config.`, or `—`
- `Yield`: `Ranked` or `—`
- `Flows`: `Full`, `Partial`, `Lagging`, `Bootstr.` , `Disabled`, or `—`
- `Blacklist`: `Tracked` or `—`
- `Dependency Map`: `Node` or `—`

---

## Source Of Truth Per Column

The page deliberately mixes structural coverage and live dataset coverage. The implementation entrypoint is `src/hooks/use-coverage-matrix-model.ts`, which builds one `CoverageRow` per active stablecoin and resolves each column through `src/lib/coverage.ts`.

| Column                | Hook / field used on `/coverage/`                                                                                          | Notes                                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Price & Depeg`       | `usePegSummary().data.coins[].id`, `consensusSources`, `priceConfidence` plus `ACTIVE_STABLECOINS[*].flags.navToken`       | `Tracked` requires a live peg-summary row. NAV tokens intentionally map to `Price only` even without depeg logic.                                                                                                                                    |
| `Safety Score`        | `useReportCards().data.cards[].overallScore`                                                                               | Coverage is `Rated` only when the report card has a non-null overall score.                                                                                                                                                                          |
| `DEX Price`           | `useDexLiquidity().data[id].coverageClass`                                                                                 | User-facing badge labels are mapped from liquidity `coverageClass`.                                                                                                                                                                                  |
| `Live Reserves Sync`  | `ACTIVE_STABLECOINS[*].liveReservesConfig` first, otherwise `getReserves(coin)` from `@shared/lib/reserve-templates`       | Live reserve adapters outrank curated or estimated reserve metadata.                                                                                                                                                                                 |
| `Redemption Backstop` | `useRedemptionBackstops().data.coins[id]`                                                                                  | The matrix reflects the live redemption-backstop snapshot exposed by the worker dataset, not static coin metadata alone. Configured-but-unrated routes render as `Config.`; low-confidence heuristic routes render as `Heur.`; neither counts as covered in the headline metric. |
| `Yield`               | `useYieldRankings().data.rankings[].id`                                                                                    | Coverage reflects current inclusion in the yield rankings, not theoretical yield-bearing eligibility.                                                                                                                                                |
| `Flows`               | `useMintBurnFlows().data.coins[].coverage.status`                                                                          | Mirrors the Ethereum mint/burn coverage state exposed on `/flows`.                                                                                                                                                                                   |
| `Blacklist`           | `BLACKLIST_STABLECOINS` from `@shared/types`                                                                               | Structural support flag, matching the shared filter enum used by the blacklist route and worker handlers. Current live-supported values are `USDC`, `USDT`, `PAXG`, and `XAUT`; `EURC` remains intentionally gated until mirrored zero-balance noise can be classified deterministically. |
| `Dependency Map`      | `useReportCards().data.cards` filtered to live cards, then `deriveDependencies(meta)` from `@shared/lib/reserve-templates` | This mirrors the live dependency-edge derivation used by `src/app/dependency-map/client.tsx`.                                                                                                                                                        |

Additional page-level sources:

| Page element                                                              | Source                                                                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Base coin universe                                                        | `ACTIVE_STABLECOINS` from `@shared/lib/stablecoins`                                                                                   |
| Market-cap weights                                                        | `/api/stablecoins` via `useStablecoins()`, using `getCirculatingRaw()` on the cached list payload                                     |
| Peg/backing/governance labels in each row                                 | `coin.flags.*` from tracked metadata, formatted through `@shared/lib/classification` short-label maps                                 |
| Pricing-source tiles                                                      | `usePegSummary().data.coins[].consensusSources`, grouped into market sources vs authoritative overrides in `useCoverageMatrixModel()` |
| Snapshot insight cards (`Widest today`, `Narrowest today`, `Major-heavy`) | Derived from the same per-feature summaries used by the feature snapshot rows                                                         |

---

## Feature Snapshot

The feature snapshot leads the page. It is the first stop for users who want to understand total Pharos coverage before drilling into individual assets.

Every row shows:

- covered coin count
- percent of tracked coins
- percent of tracked market cap
- a short per-feature breakdown
- direct link to the underlying surface when one exists

For `Live Reserves Sync`, the headline metric intentionally emphasizes `Live` reserve tracking. Curated and estimated reserve views still appear in the breakdown so the row distinguishes true live coverage from metadata-only reserve composition.

For `Redemption Backstop`, the headline metric intentionally emphasizes strong redemption coverage only. Low-confidence heuristic routes and configured-but-unrated routes still appear in the breakdown so the row does not imply the modeled registry disappeared.

Breakdowns are intentionally dense and should stay short:

- DEX: `primary / mixed / fallback`
- Live reserves: `live / curated / estimated`
- Redemption: `heuristic / configured / issuer / psm / queue / collateral / stable / basket`
- Flows: `full / partial / bootstrapping`
- Price: `tracked / price-only`

#### Source count enrichment

When `consensusSources` data is available from the peg-summary API, the "Tracked" badge shows a source count suffix: "Tracked (5 sources)" (or "Tracked (5)" in compact mode). Tooltip expands to show confidence level and source names (e.g., "High confidence — CoinGecko, DefiLlama, Pyth Network"). The feature snapshot breakdown adds a secondary source-depth distribution: `5+ sources: N · 3-4: N · 1-2: N`.

If a feature gains richer user-facing states, update both `src/lib/coverage.ts` and this document.

---

## UX Contract

- The feature snapshot comes first and answers the breadth question before the page shifts into per-coin inspection.
- Search filters by name and ticker.
- Quick filters narrow the table to one major feature slice (`Redemption`, `Live reserves`, `Yield`, `Flows`, `Blacklist`).
- Default sort is descending live market cap.
- On small screens, the matrix adapts into scan-first per-coin cards that preview the highest-signal statuses and expand for the remaining states.
- From `md` upward, the full comparison table renders with the first column sticky.
- The per-coin matrix comes second and is explicitly positioned as the asset-level drill-down surface.
- Coverage notes and the status legend live in an inline disclosure above the matrix, not in a separate explainer block.
- Shared stale-data banners surface freshness problems from the stablecoins, peg-summary, dex-liquidity, redemption-backstops, yield-rankings, mint-burn-flows, and report-cards queries without collapsing the structural coverage view.

The page should continue to render meaningfully when some live datasets are temporarily unavailable. In that case, the matrix still renders with structural coverage where possible and uses the shared stale-data banner to surface data-health issues.

---

## Update Rules

Update this page when any of the following change:

- a new user-facing feature becomes per-coin and has partial coverage
- an existing feature changes its coverage source of truth
- a status label or meaning changes
- the table gains or loses a column

If the change also affects route inventory, update [Architecture](./architecture.md) and the [Documentation Index](./README.md).
