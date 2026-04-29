# FX Pricing Infrastructure: Adding MYR + KRW Peg Currencies

Date: 2026-04-29
Scope: research-only. Plans the diff to add `MYR` (Malaysian Ringgit) and `KRW` (Korean Won) to `PEG_CURRENCY_VALUES` so MYRC and KRWQ can be tracked as first-class non-USD fiat stablecoins.

---

## TL;DR

- Adding MYR + KRW is a **purely additive, no-runtime-deletion** change. The pricing pipeline already supports an arbitrary number of fiat pegs through `PRIMARY_CURRENCY_TO_PEG` in `worker/src/lib/fx-config.ts`; the schema enums in `shared/types/core.ts` and the labels/colors in `shared/lib/classification.ts` are the only places where each new peg must be enumerated.
- Frankfurter (ECB-backed) supports both `MYR` and `KRW` natively (verified at `https://api.frankfurter.dev/v1/currencies` on 2026-04-29). CoinGecko `/simple/price` `vs_currencies` also supports both `myr` and `krw`. No new data source is needed; the existing FX cron and the native-peg quote lane both flow through.
- Methodology bump is minor: pricing-pipeline `v5.0` → `v5.01` (changelog entry + timeline entry). The about page does **not** need a new data-source disclosure (Frankfurter, fawazahmed0, ExchangeRate-API, CoinGecko are already disclosed in `pricing-pipeline.md` / `worker-infrastructure.md`).
- Estimated touch surface: **~14 source files + 2 doc files + 2 timeline/changelog entries**, plus the per-coin JSONs and canonical-order entry for MYRC/KRWQ themselves (those are the normal "Adding a Stablecoin" path and not strictly part of "FX infrastructure").

---

## Investigation Trace

### 1. Where `PegCurrency` and `PEG_CURRENCY_VALUES` are consumed

| File | Lines | Category | Needs edit? |
|------|------:|----------|-------------|
| `shared/types/core.ts` | 18-42, 278-323 | Source-of-truth enum + `FilterTag` union | **Yes** — add `MYR`, `KRW`; add `myr-peg`, `krw-peg` to `FilterTag` |
| `shared/types/stablecoin-meta-schemas.ts` | 28, 41 | Re-imports `PEG_CURRENCY_VALUES`; no list duplication | No (auto-picks up) |
| `shared/lib/stablecoins/schema.ts` | 5, 152 | Re-imports `PEG_CURRENCY_VALUES`; no duplication | No (auto-picks up) |
| `shared/lib/classification.ts` | 109-364 (`PEG_METADATA`) | Per-peg display labels, badges, chart colors. `satisfies Record<PegCurrency, PegMetadata>` — **TS will fail compile if MYR/KRW are added to enum but missing here** | **Yes** — add `MYR` and `KRW` blocks |
| `shared/lib/filter-tags.ts` | 14-34, 36-59 | `FIAT_NON_USD_PEG_TAGS`, `OTHER_PEG_TAGS`, `NON_PEG_FILTER_TAG_LABELS` derive from `PEG_METADATA` — auto-pick up | No (auto-picks up) |
| `src/lib/peg-landing.ts` | 9-33, 65-99 | `ALL_SLUGS` is `Record<PegCurrency, string>` (TS-checked, total) and `PEG_INTRO` per-peg copy | **Yes** — add `MYR: "myr"`, `KRW: "krw"` to `ALL_SLUGS`; optionally add MYR/KRW intro copy |
| `src/lib/peg-taxonomy.ts` | 25-41 | Builds `PEG_TAXONOMY_PAGES` from `ACTIVE_PEGS`. Auto-picks up. | No |
| `src/app/stablecoins/[peg]/{page,client}.tsx` | — | Data-driven via `PEG_TAXONOMY_PAGES` / `PEG_SLUGS`. Auto-picks up. | No |
| `src/lib/alt-peg-emblems.ts` | 7-23 | `PEG_ANCHORS` — viewBox positions on the world map. **Test in `src/lib/__tests__/alt-peg-emblems.test.ts` only enforces existing pegs**, so additions do not break the test, but new clusters won't render unless we add anchors. | **Yes** — add `MYR: { x, y }` (Malaysia ~ 79, 49), `KRW: { x, y }` (South Korea ~ 81, 26) |
| `src/lib/alt-peg-geography.ts` | 11-27 | `PEG_COUNTRY_MAP` — ISO-3166 country codes per peg. **Geography test (`alt-peg-geography.test.ts`) iterates `buildAltPegLinkHubGroups()` and fails if any non-Other-region fiat peg is uncovered.** Once MYR/KRW have active coins, this test fails without entries. | **Yes** — add `MYR: ["MY"]`, `KRW: ["KR"]` |
| `src/lib/alt-peg-market.ts` | 100-128 (`getFiatPegRegion`) | Asian region switch. Default returns `"Other"` and skips geography test. | **Yes** — add `MYR` and `KRW` to the `Asia` arm |
| `src/app/alt-pegs/fiat-world-atlas/hover-context.tsx` | — | Uses `PegCurrency` as type only | No |
| `src/components/peg-distribution-grid.tsx` | 36 | `COLLAPSED_FIAT_PREVIEW_ORDER` is hand-curated USD/EUR/CHF; not exhaustive | No |
| `src/components/peg-heatmap.tsx` | 15-24 | Uses `PegCurrency` as type only | No |
| `src/app/{liquidity,yield,depeg}/client.tsx` | various | Type-only usages | No |
| `worker/src/lib/native-peg-quotes.ts` | 7-24 | `SUPPORTED_COINGECKO_NATIVE_PEG_CURRENCIES` map (CoinGecko `vs_currencies`). Required for the native-peg implied-price lane and historical native-peg replay. | **Yes** — add `["MYR", ["myr"]]`, `["KRW", ["krw"]]` |
| `worker/src/lib/fx-config.ts` | 1-77 | `PRIMARY_FX_CURRENCIES`, `PRIMARY_CURRENCY_TO_PEG`, `EXPECTED_FX_PEG_KEYS`, `FX_RATE_BOUNDS` | **Yes** — add MYR + KRW; set sane bounds (MYR ≈ 0.18-0.30 USD/MYR, KRW ≈ 0.0005-0.0010 USD/KRW) |
| `worker/src/lib/fx-cadence.ts` | 5-20 (`BUSINESS_DAILY_FX_PEGS`) | Frankfurter / ECB cadence set | **Yes** — add `peggedMYR`, `peggedKRW` |
| `worker/src/lib/__tests__/fx-cadence.test.ts` | 9-24 (`BUSINESS_DAILY_PEGS` parity assertion) | **Test asserts `[...BUSINESS_DAILY_FX_PEGS]` equals a hand-coded array. Fails if you add to fx-cadence.ts without updating the test.** | **Yes** — extend `BUSINESS_DAILY_PEGS` array to match |
| `worker/src/lib/stablecoin-charts-reconciliation.ts` | 20-71 (`pegTypeFromCurrency`) | Switch covering every `PegCurrency`; falls into `default: return null` and **throws "Unsupported peg currency"** at module-load time when ACTIVE_STABLECOINS contains a coin whose pegCurrency has no case here. | **Yes** — add `case "MYR"` / `case "KRW"` |
| `worker/src/lib/price-validation.ts` | 96-148 (`normalizePegTypeFromCurrency`, `classifyPegClass`) | `normalizePegTypeFromCurrency` synthesizes `pegged${pegCurrency}` already (no per-currency case needed). `classifyPegClass` has an explicit hard-coded include-list for `fiat_fx`. | **Yes** — add `pegType.includes("MYR") \|\| pegType.includes("KRW")` to the `classifyPegClass` chain in `price-validation.ts:124-144` |
| `worker/src/api/backfill-fx.ts` | 23-46 | `PEG_TO_FX` (Frankfurter codes) and `SECONDARY_PEG_TO_FX` (fawazahmed0 codes). Used by `backfill-depegs.ts` and `worker/scripts/repair-non-usd-fiat-depeg-history.ts`. | **Yes** — add `MYR: "MYR"`, `KRW: "KRW"` to `PEG_TO_FX` (both are on Frankfurter) |
| `scripts/fix-non-usd-depeg-fx.ts` | 52-58 | One-shot repair script with its own `PEG_TO_FX` (uses lowercase pegged keys). Already-archived; not executed in normal runs. | Optional — only matters if the script is rerun with MYR/KRW data. Safe to leave unless we re-run. |
| `worker/src/cron/yield-sync/benchmarks.ts` | 23-79 | Yield benchmark currencies are USD/EUR/CHF only — no MYR/KRW benchmark exists, so MYR/KRW yield-bearing variants would fall through to `fallback-usd` selection mode, which is the existing pattern for JPY/SGD/etc. | No |
| `worker/src/lib/depeg-trust-policy.ts` | 35, 106-113 | Lists `USD/VAR/OTHER/GOLD/SILVER` as currencies that bypass the native-peg corroboration step. MYR and KRW are fiat → they should require native-peg corroboration like JPY/EUR. | No (the catchall handles them correctly) |
| `worker/src/lib/native-peg-implied-prices.ts` | 1-90 | Generic — uses `normalizeSupportedPegCurrency` from `native-peg-quotes.ts`. Auto-picks up once that map includes MYR/KRW. | No |

### 2. FX rate ingestion pipeline (traced via JPY)

End-to-end flow for `peggedJPY`:

1. **Cron** — `worker/src/cron/sync-fx-rates.ts` runs every 15 minutes (gated to a 30-minute internal cooldown). Driven by `worker/src/handlers/scheduled/quarter-hourly.ts:13,21`.
2. **Primary fetch** — Frankfurter `https://api.frankfurter.dev/v1/latest?base=USD&symbols=...,JPY,...`. The currency list comes from `worker/src/lib/fx-config.ts:PRIMARY_FX_CURRENCIES`.
3. **Validation** — Each rate runs through `isValidFxRate(pegKey, rate, prevRate)` against `FX_RATE_BOUNDS` and a 20% delta cap. Bounds for `peggedJPY` are `[0.003, 0.03]`.
4. **Live secondary** — fawazahmed0 + ExchangeRate-API are the secondary/tertiary full-set fallbacks if Frankfurter is unavailable. Only `CNH/RUB/UAH/ARS` always go through fawazahmed0; the broader set only does on Frankfurter outage. (`SECONDARY_FX_CURRENCY_TO_PEG`)
5. **Overlay** — Curated Chainlink feeds (EUR, GBP, JPY, XAU, XAG) and OXR can refine the cache. JPY is one of the curated overlays.
6. **Storage** — Persisted to D1 cache key `fx-rates` (and metadata to `fx-rates-meta`). Format: `{ peggedJPY: 0.0067, ... }` where the value is **USD per 1 unit of the currency**. (`worker/src/lib/fx-rate-state.ts:9-10`)
7. **Cadence metadata** — `BUSINESS_DAILY_FX_PEGS` in `worker/src/lib/fx-cadence.ts:5-20` controls how `fx-rates-meta` ages each peg.
8. **Consumption** — `derivePegRates()` in `shared/lib/peg-rates.ts:34-114` reads the cache during `sync-stablecoins`. For thin peg groups (<3 coins), it uses the cached FX rate directly as `peg_reference`; for groups with 3+ tracked coins it uses median price. The result drives peg-deviation calc (`worker/src/lib/depeg-helpers.ts`), peg-summary, and the alt-pegs charts.
9. **Native-peg implied-price lane** — Independently of the FX cache, `fetchCurrentNativePegQuotes()` in `worker/src/lib/native-peg-quotes.ts` queries CoinGecko `/simple/price?vs_currencies=jpy` for each coin's geckoId. Used in `worker/src/lib/native-peg-implied-prices.ts` and `worker/src/api/backfill-depegs-replay.ts`. **This is the lane that gates direct native-peg corroboration on `confirm_required` depegs for non-USD fiat assets.**
10. **Per-currency configs** — only `FX_RATE_BOUNDS` (validation), `BUSINESS_DAILY_FX_PEGS` (cadence), and `SUPPORTED_COINGECKO_NATIVE_PEG_CURRENCIES` (native lane) are per-currency. Decimal precision is **not** stored anywhere — display formatting uses `Intl.NumberFormat`-style helpers and is unit-of-USD agnostic.

### 3. Verifying CoinGecko + Frankfurter coverage (live, 2026-04-29)

- `https://api.frankfurter.dev/v1/currencies` → both `MYR` ("Malaysian Ringgit") and `KRW` ("South Korean Won") are present. Frankfurter publishes ECB reference rates daily on business days.
- `https://api.coingecko.com/api/v3/simple/supported_vs_currencies` → both `myr` and `krw` are in the supported list.
- Both currencies are also covered by Open Exchange Rates and ExchangeRate-API (default coverage), so the existing tertiary fallback chain applies.

### 4. Currency-specific data needs

| Currency | Symbol | Decimals (display) | Frankfurter | CG `vs_currencies` | OXR | Notes |
|----------|--------|-------------------:|-------------|-------------------|-----|-------|
| MYR | RM | 2 | yes | yes | yes | Malaysia uses RM prefix; locale `ms-MY`. |
| KRW | ₩ | 0 | yes | yes | yes | South Korea uses 0 decimals. Pharos has no per-currency decimal config today; depeg deviation is computed in **bps versus a USD-denominated peg reference**, so 0-decimal display does not break math. UI formatters that show "1,234 KRW" should use `Intl.NumberFormat(locale, { maximumFractionDigits: 0 })` if and when a UI surface displays raw KRW. **No such surface exists today** — Pharos always displays USD-denominated marks for non-USD coins. |

Suggested `FX_RATE_BOUNDS`:

- `peggedMYR: [0.18, 0.30]` (recent range ≈ 0.21-0.24 USD/MYR; 20% buffer either side)
- `peggedKRW: [0.0005, 0.0010]` (recent range ≈ 0.00068-0.00074 USD/KRW; ample buffer)

---

## Diff Plan (ordered by dependency)

### Phase A — Type system + schema (must be first, TS will fail compile until A.2 lands)

1. **`shared/types/core.ts`**
   - Insert `"MYR"` and `"KRW"` into `PEG_CURRENCY_VALUES` (between `IDR` and `SGD` alphabetically, or grouped with Asian fiats per existing convention — JPY/IDR/SGD are clustered).
   - Insert `"myr-peg"` and `"krw-peg"` into the `FilterTag` union string literal list (~line 278-323).
2. **`shared/lib/classification.ts`** (`PEG_METADATA` block)
   - Add MYR + KRW entries with `label`, `shortLabel`, `filterTag`, `filterLabel`, `badge.cls`, and `chart` color. Pick unused Tailwind color tokens. Suggested:
     - MYR: `bg-emerald-600/10 text-emerald-700 ... hex #059669` (or any unused).
     - KRW: `bg-violet-600/10 text-violet-800 ... hex #7c3aed` (need to avoid CNH `#9333ea` collision; pick a different shade or family).
   - Verifies via `satisfies Record<PegCurrency, PegMetadata>` — compiler will tell you if a key is missing.

After Phase A: TS compiles. `FILTER_TAG_LABELS`, `PEG_BADGE_STYLES`, `PEG_CHART_COLORS`, `FIAT_NON_USD_PEG_TAGS`, `OTHER_PEG_TAGS` auto-derive.

### Phase B — Frontend taxonomy + map placement

3. **`src/lib/peg-landing.ts`** — add `MYR: "myr"` and `KRW: "krw"` to `ALL_SLUGS` (TS-total, fails without). Optionally add `PEG_INTRO.MYR` and `PEG_INTRO.KRW` copy.
4. **`src/lib/alt-peg-market.ts`** (`getFiatPegRegion`) — add `case "MYR":` and `case "KRW":` to the Asia arm.
5. **`src/lib/alt-peg-emblems.ts`** (`PEG_ANCHORS`) — add `MYR: { x: 79, y: 49 }` and `KRW: { x: 82, y: 26 }`. Tune by hand against the rendered atlas.
6. **`src/lib/alt-peg-geography.ts`** (`PEG_COUNTRY_MAP`) — add `MYR: ["MY"]`, `KRW: ["KR"]`. The geography parity test will fail if the new pegs ship as active without these.

### Phase C — Worker FX pipeline

7. **`worker/src/lib/fx-config.ts`**
   - Append `"MYR"`, `"KRW"` to `PRIMARY_FX_CURRENCIES`.
   - Add `MYR: "peggedMYR"`, `KRW: "peggedKRW"` to `PRIMARY_CURRENCY_TO_PEG`.
   - Add `peggedMYR: [0.18, 0.30]`, `peggedKRW: [0.0005, 0.0010]` to `FX_RATE_BOUNDS`.
   - `EXPECTED_FX_PEG_KEYS` and `REALTIME_FX_CURRENCY_TO_PEG` auto-derive.
8. **`worker/src/lib/fx-cadence.ts`** — add `"peggedMYR"`, `"peggedKRW"` to `BUSINESS_DAILY_FX_PEGS`.
9. **`worker/src/lib/fx-cadence.test.ts`** — extend the `BUSINESS_DAILY_PEGS` literal array (line 9-24) to include the two new keys, in the same order as the canonical set in fx-cadence.ts.
10. **`worker/src/lib/native-peg-quotes.ts`** — add `["MYR", ["myr"]]` and `["KRW", ["krw"]]` to `SUPPORTED_COINGECKO_NATIVE_PEG_CURRENCIES`.
11. **`worker/src/lib/stablecoin-charts-reconciliation.ts`** — add `case "MYR": return "peggedMYR";` and `case "KRW": return "peggedKRW";` to `pegTypeFromCurrency`.
12. **`worker/src/lib/price-validation.ts`** — add `pegType.includes("MYR")` and `pegType.includes("KRW")` to the include-list in `classifyPegClass` (~line 124-144).
13. **`worker/src/api/backfill-fx.ts`** — add `MYR: "MYR"`, `KRW: "KRW"` to `PEG_TO_FX` (Frankfurter supports both).

### Phase D — Methodology + docs

14. **`shared/lib/pricing-pipeline-version.ts`** — bump current version `5.0` → `5.01`. Add a new entry to `changelog`:
    ```
    {
      version: "5.01",
      title: "MYR and KRW peg-currency support",
      date: "2026-04-29",
      effectiveAt: <unix>,
      summary: "Added MYR (Malaysian Ringgit) and KRW (Korean Won) to the supported peg-currency set so MYRC and KRWQ can be tracked through the existing Frankfurter / fawazahmed0 / ExchangeRate-API FX lane and the CoinGecko native-peg corroboration lane.",
      impact: [
        "FX cron now requests MYR and KRW from Frankfurter and validates them against per-peg bounds",
        "Native-peg implied-price lane corroborates MYR / KRW depegs via direct CoinGecko myr / krw quotes",
        "Stablecoin charts reconciliation, price-validation classifyPegClass, and FX cadence metadata cover the new pegs",
      ],
      commits: [],
      reconstructed: false,
    }
    ```
    Note: per CLAUDE.md "methodology versions must increase numerically, not semver-style." After 5.0 use 5.01 for a minor update.
15. **`docs/pricing-pipeline-timeline.md`** — prepend a v5.01 section in the same format as v5.0.
16. **`docs/pricing-pipeline.md`** — bump "Current methodology version: `v5.0`" to `v5.01` (line 24).
17. **`docs/depeg-detection.md`** (and `docs/methodology-page.md` if it lists supported pegs) — review for any explicit currency lists that need MYR/KRW added.

### Phase E — Per-coin registry (the actual MYRC + KRWQ entries)

This is the standard `agents/process/adding-a-stablecoin.md` flow. Out of scope for "FX infrastructure" but required for the change to be useful:

- `shared/data/stablecoins/coins/myrc-blox.json` (CoinGecko `blox-myrc`, Malaysia jurisdiction, RM-redemption pegMechanism)
- `shared/data/stablecoins/coins/krwq-krwq.json` (CoinGecko `krwt`, on Base + Ethereum)
- `shared/data/stablecoins/canonical-order.json` — insert both IDs in canonical position
- Regenerate `shared/data/stablecoins/coins.generated.json`
- `data/logos.json` and `data/ai-summaries.json` entries
- For both, set `flags.pegCurrency: "MYR"` / `"KRW"` and `detailProvider: "coingecko"` (neither is in DefiLlama's stablecoins list per the 2026-04-21 gap sweep).

---

## Minimal vs Complete

### Absolute Minimum (peg recognized, depeg lane works, no UI breakage)

Phase A.1, A.2, B.3 (slug only, no intro), C.7, C.8, C.9, C.10, C.11, C.12, C.13, plus **at least one** active coin with that peg. **9 source-file edits + 1 test edit + per-coin JSON.**

This is enough to:
- Compile clean (TS-total enums)
- FX cron fetches and validates MYR/KRW rates
- `derivePegRates` produces a peg reference
- Depeg detection runs through the existing non-USD lane (Frankfurter rate × native-peg corroboration)
- Stablecoins API returns the coin with valid `pegType`, `priceConfidence`, etc.

If you ship without B.4-6, the alt-pegs world atlas just doesn't render the new clusters (regions stay "Other"). The geography test fails as soon as the coin is `active` because non-Other-region fiat pegs without country mappings are flagged.

### Complete / Polished

All of Phase A-D. Adds:
- Visual cluster placement on the world atlas (B.4-6)
- SEO landing-page intro copy (B.3 optional)
- Methodology version bump and changelog entry (D.14-15)
- Doc currency-version sync (D.16-17)

---

## Risk + Gotcha Callouts

1. **`worker/src/lib/__tests__/fx-cadence.test.ts:9-24` will hard-fail** if you add a peg to `BUSINESS_DAILY_FX_PEGS` without updating the parity array. This is the single most likely test failure. Catch it via Phase C.9.
2. **`worker/src/lib/stablecoin-charts-reconciliation.ts:78-80` throws at module load** for unknown peg currencies once a coin with that peg becomes active. The error is "Unsupported peg currency for stablecoin-charts reconciliation: <id>". This means **C.11 must land in the same change as the per-coin JSON** — otherwise the worker boot path crashes.
3. **`shared/lib/classification.ts:PEG_METADATA` uses `satisfies Record<PegCurrency, PegMetadata>`** — if you add to the enum without adding the metadata block, the TS error is at `satisfies` and not at consumption sites. Phase A.2 must follow A.1 in the same commit.
4. **Geography test (`src/lib/__tests__/alt-peg-geography.test.ts:6-15`) fails when a fiat peg with `region !== "Other"` has no `PEG_COUNTRY_MAP` entry.** B.4 (region) and B.6 (country map) must land together.
5. **`PEG_CHART_COLORS` collisions are visual-only**, not enforced by tests. The CNH color is `#9333ea` (purple-600); pick a non-overlapping color for KRW (e.g., a different violet shade or pink).
6. **No tests assert the full `PEG_CURRENCY_VALUES` list.** `src/lib/__tests__/classification.test.ts:120-128` only checks that `PEG_CURRENCY_COUNT > 0` and is an integer. No snapshot tests of `/api/stablecoins` lock in the peg list.
7. **`docs/about-page.md` and `src/app/about/page.tsx` do not currently list FX providers by name** (Frankfurter, fawazahmed0, ExchangeRate-API are disclosed only in `docs/pricing-pipeline.md` and `docs/worker-infrastructure.md`). Per CLAUDE.md, the about page only needs an update **if a new data source is introduced** — and adding MYR/KRW does not introduce a new source. **No about-page change needed.**
8. **OXR free tier is 1,000 req/month**; adding 2 more `symbols=` parameters per call is free (still one request). No quota impact.
9. **Frankfurter is rate-unlimited but ECB-cadenced**: KRW + MYR will return the previous business-day reference, same as JPY/EUR. The `business-daily` cadence in `BUSINESS_DAILY_FX_PEGS` is correct.
10. **Historical depeg replay** (`worker/src/api/backfill-depegs.ts`, `worker/scripts/repair-non-usd-fiat-depeg-history.ts`) auto-uses MYR/KRW once `PEG_TO_FX` includes them (D.13). No code changes needed beyond the map entry.
11. **`SECONDARY_FX_CURRENCY_TO_PEG` is unrelated** — that map is the always-on path for CNH/RUB/UAH/ARS (currencies Frankfurter doesn't publish). MYR and KRW go through the **primary** Frankfurter path, so no entry there.
12. **Yield benchmark fall-through is acceptable**: `worker/src/cron/yield-sync/benchmarks.ts:74-79` only natively supports USD/EUR/CHF benchmarks. MYR/KRW yield-bearing tokens (none planned today) would land in `selectionMode: "fallback-usd"`, the same pattern already used for JPY/SGD coins.

---

## Validation Commands (run in this order after the change)

```bash
# 1. Per-coin schema + canonical order
tsx scripts/generate-stablecoin-per-coin-asset.ts
npm run check:stablecoin-data

# 2. Fast TS gates
npm run lint
cd worker && npx tsc --noEmit && cd -

# 3. Unit + integration tests (will catch fx-cadence parity test, classification test, geography test, stablecoin-charts-reconciliation throw)
npm test

# 4. Aggregated pre-build gate (lint, typecheck, every check:* in parallel)
npm run validate:prebuild

# 5. Build to catch SEO / static-route generation issues
npm run build

# 6. Merge gate (Pages build + worker typecheck for deploy-impacting diffs)
npm run test:merge-gate
```

After deploy:
- `POST /api/backfill-cg-prices?stablecoin=myrc-blox` (no llamaId, has geckoId)
- `POST /api/backfill-cg-prices?stablecoin=krwq-krwq`
- Verify `/api/stablecoins` includes both with non-null `price`, `priceConfidence`, valid `pegType` of `peggedMYR` / `peggedKRW`.
- Verify `https://api.pharos.watch/api/peg-summary` returns the new peg buckets.
- Spot-check `/stablecoins/myr/` and `/stablecoins/krw/` landing pages.
- Spot-check the alt-pegs world atlas — Malaysia and South Korea should render emblem clusters.

---

## File Path Map (absolute)

Modified:
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/types/core.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/classification.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/pricing-pipeline-version.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/peg-landing.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/alt-peg-market.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/alt-peg-emblems.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/alt-peg-geography.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/fx-config.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/fx-cadence.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/fx-cadence.test.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/native-peg-quotes.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/stablecoin-charts-reconciliation.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/price-validation.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-fx.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/docs/pricing-pipeline.md`
- `/home/ahirice/Documents/git/stablecoin-dashboard/docs/pricing-pipeline-timeline.md`

Per-coin (the actual MYRC / KRWQ assets, separate "Adding a Stablecoin" workstream):
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/coins/myrc-blox.json` (new)
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/coins/krwq-krwq.json` (new)
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/canonical-order.json`
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/coins.generated.json` (regenerated)
- `/home/ahirice/Documents/git/stablecoin-dashboard/data/logos.json`
- `/home/ahirice/Documents/git/stablecoin-dashboard/data/ai-summaries.json`
- Logo files under `/home/ahirice/Documents/git/stablecoin-dashboard/public/logos/`

Read-only (consulted, no edits required):
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/types/stablecoin-meta-schemas.ts` (re-imports)
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/stablecoins/schema.ts` (re-imports)
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/filter-tags.ts` (auto-derives)
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/peg-taxonomy.ts` (auto-derives)
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-fx-rates.ts` (driven by fx-config.ts)
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/fx-realtime.ts` (driven by REALTIME_FX_CURRENCY_TO_PEG)
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/benchmarks.ts` (USD/EUR/CHF only — fall-through is fine)
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/depeg-trust-policy.ts` (catchall handles fiat correctly)
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/native-peg-implied-prices.ts` (driven by native-peg-quotes.ts map)
- `/home/ahirice/Documents/git/stablecoin-dashboard/scripts/fix-non-usd-depeg-fx.ts` (one-shot archived script; only update if rerun)
