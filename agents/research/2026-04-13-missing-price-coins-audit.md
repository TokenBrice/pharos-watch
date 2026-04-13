# Missing-Price Coins Audit (2026-04-13)

Research artifact from Workstream 6 of `agents/plans/2026-04-13-status-stability-hardening-plan.md`. Extracts the actual list of stablecoins that were missing prices in the `stablecoins` cache at the time of the audit and classifies them so a follow-up plan can root-cause and fix them individually.

## Methodology

```bash
cd worker
npx wrangler d1 execute stablecoin-db --remote --command \
  "SELECT value FROM cache WHERE key = 'stablecoins'" --json > /tmp/stablecoins-cache.json
```

Then parse with Python to list all `peggedAssets[].price == null`, split into canonical (in `shared/data/stablecoins/canonical-order.json`) vs DefiLlama residuals (non-canonical IDs that are pulled into the cache as side output of the DL sync).

## Headline numbers

| Bucket | Count |
|---|---|
| Total assets in cache | 403 |
| Canonical assets in cache | 184 (of 194 canonical IDs) |
| DL residual assets in cache | 219 |
| Missing prices (all) | 57 |
| Missing prices (canonical only) | **9** |
| Missing prices (DL residuals only) | 48 |
| Current ratio using current formula (`missing / total`) | 14.14% |
| Ratio restricted to canonical-only | **4.89%** |

The 10 canonical IDs missing from the cache entirely (`184 < 194`) are separately interesting — they should appear in the cache even if pricing fails. This is a secondary issue outside the scope of the Workstream 6 audit.

## Key insight: the denominator is wrong

The `missingPriceRatio` used by `/api/status` data-quality derivation is computed as `missingPrices / totalStablecoins`, where `totalStablecoins` is `stablecoinAssets.length` — i.e., the full `peggedAssets` list pulled from DefiLlama plus supplemental tokens. In prod that list has 403 entries, 219 of which are DL residuals we are **not** actively tracking (numeric DL IDs like `"104"`, `"111"`, `"125"`, etc. that have not been adopted into `canonical-order.json`).

Of the 57 missing-price entries in the current cache, **48 are DL residuals**. Restricting the denominator to canonical-tracked coins only drops the ratio from 14.14% to 4.89%, well below any threshold.

This confirms the Workstream 1 analysis: the 15% flapping boundary was being crossed not because of any real degradation, but because of the inflated denominator. The Workstream 1 threshold raise (0.15 → 0.18) handles the current situation, but the more surgical fix — scoping the ratio to canonical-tracked coins only — should be tracked as a follow-up.

## Canonical coins currently missing prices (9)

These are tracked stablecoins that we expect to have live prices but don't. Each needs individual investigation.

| id | symbol | peg mechanism | Probable cause / next step |
|---|---|---|---|
| `usbd-bima` | USBD | crypto-backed | Bima — check price source config (DL/CG) and whether it was recently delisted or pre-launch |
| `ctusd-citrea` | ctUSD | fiat-backed | Citrea — likely pre-launch, check if listed in CG/DL yet |
| `usdq-quill` | USDQ | crypto-backed | Quill — investigate, likely missing DEX pool listing or CG ID collision with a retired peg |
| `tryb-bilira` | TRYB | fiat-backed | BiLira — check Turkish-lira price source config |
| `gbpm-mento` | GBPm | crypto-backed | Mento GBP — check DEX pool on Celo |
| `usdnr-nerona` | USDnr | rwa-backed | Nerona — likely pre-launch |
| `chfau-allunity` | CHFAU | rwa-backed | AllUnity CHF — likely pre-launch or low-liquidity |
| `evausdc-eva` | evaUSDC | rwa-backed | Added 2026-04-11 (`fb5f066d`) — check price enrichment pipeline wiring |
| `evausdt-eva` | evaUSDT | rwa-backed | Added 2026-04-11 (`fb5f066d`) — same |

The two eva tokens were added in `fb5f066d` on 2026-04-11 and should have been wired up in the same commit. Worth checking whether they have CG IDs registered or need manual price-source overrides.

## DL residuals currently missing prices (48 — partial list)

These are untracked DefiLlama coins that show up in the cache because the DL API returns them. They're not in `canonical-order.json`. A follow-up plan should either (a) scope the `missingPriceRatio` denominator to canonical coins only (recommended), or (b) drop non-canonical residuals from the cache write entirely.

Sample: `104` (DUSD), `111` (DAI+), `12` (USDN), `125` (eUSD(v2)), `127` (LCNY), `131` (UAHT), `133` (NARS), `134` (CASH), `138` (eUSD), `139` (eEUR), `140` (eGBP), `143` (USDV), `161` (EURD), `174` (rUSD), `187` (KNOX), `207` (DYAD), `210` (DEUSD), `232` (PINTO), `236` (syUSD), `244` (USDL), `264` (USDE), `267` (MEAD), `268` (YU), `273` (USDaf), `279` (paraUSD), `280` (CNHT), `281` (MXNT), `301` (JUSD), `315` (USPD), `351` (RUBT), `352` (BRTH), `371` (XOFm), `37` (USDJ), `44` (USX), `45` (aSEED), `46` (USD+), `49` (EURT), `53` (SEUR), `57` (USH), `67` (BEAN), `81` (USK), `85` (USDR), `91` (IBEUR), `96` (CUSD), plus a few more.

Most of these are either pre-launch, deprecated (e.g., USTC from Terra collapse), or so illiquid that no price source will reliably return a number. They should not drive public status degradation.

## Recommended follow-ups

1. **~~Scope `missingPriceRatio` denominator to canonical coins only.~~** ✅ **Implemented 2026-04-13** in `worker/src/lib/status/data-quality.ts` using the `ACTIVE_IDS` set from `shared/lib/stablecoins`. The filter excludes both DL residuals and pre-launch canonical coins. New tests in `worker/src/api/__tests__/status.test.ts` cover the `buildMixedCacheDb` cases. The prod normal-state ratio drops from 14.14% (57/403) to ~4.89% (9/184).
2. **Triage the 9 canonical missing coins.** Each needs individual investigation: is it pre-launch (keep as missing), is the price-source config wrong (fix), or should it be removed from canonical tracking (delete). **Still open.**
3. **Decide whether to drop DL residuals from the cache write.** They are used for discovery candidate surfacing, so removing them entirely is a tradeoff. At minimum, a separate `cacheWriteResidualFilter` could exclude them from the main `stablecoins` payload and keep them in a separate `discovery-residuals` cache key. **Still open but lower priority now that residuals no longer affect the status ratio.**
4. **~~Add a test that fixes the denominator at the canonical tracked count.~~** ✅ **Implemented 2026-04-13** — the `missingPriceRatio canonical scoping` describe block in `worker/src/api/__tests__/status.test.ts` covers both "residuals unpriced but ignored" and "canonical missing without dilution by residuals".

## Status of the immediate fix

Both layers of the fix have now landed:

**Layer 1 — Workstream 1 threshold raise** (`ca4ab112`): 0.15 → 0.18 for `ratioDegraded`, 0.40 → 0.45 for `ratioStale`. This was the minimal stabilizer that unblocked the flapping problem using the old (inflated) denominator.

**Layer 2 — Canonical scoping** (follow-up #1 above, 2026-04-13): `getDataQuality` now filters `stablecoinAssets` through `ACTIVE_IDS` before computing `totalStablecoins` and `missingPrices`. The prod normal-state ratio drops from 14.14% (57/403) to ~4.89% (9/184) — well below the elevated band, so the `missing_prices_elevated` info cause will stop firing too.

Combined effect:

- Prod normal: 4.89% → comfortably healthy
- Elevated band fires at 15% of 184 = 28 missing active canonical
- Degraded fires at 18% of 184 = 34 missing active canonical
- Stale fires at 45% of 184 = 83 missing active canonical

Even if all 9 currently-missing-canonical coins went unpriced AND another 18 existing coins lost their prices (total 27), the system would still be healthy (below 15% elevated floor). A meaningful regression is now required to drive status transitions.

Remaining open follow-ups: triage the 9 canonical missing coins, and decide whether to split DL residuals out of the main `stablecoins` cache write.

## Follow-up triage (2026-04-13)

User-requested follow-up after removing `gbpm-mento`, `evausdc-eva`, and `evausdt-eva` from tracking.

Current remaining visible missing-price set from the table screenshot:

| id | symbol | Finding | Action |
|---|---|---|---|
| `ctusd-citrea` | ctUSD | DefiLlama stablecoins list is addressless, but `coins.llama.fi/prices/current/citrea:<contract>` returns a fresh ctUSD quote. The existing pass only tried contract lookup when the upstream row had `address`. | Fixed: Pass 1 now falls back to curated tracked `contracts` metadata when the upstream row is addressless. |
| `usdnr-nerona` | USDnr | No direct CG/DL/DexScreener quote found. It is modeled locally as an M0 extension/wrapper, matching the existing `usdk-kast` and `xo-exodus` inheritance pattern. | Fixed: added `usdnr-nerona -> wm-m0` authoritative tracked-parent inheritance. |
| `usbd-bima` | USBD | CoinGecko returns no USD price, DefiLlama list and coins API return no contract price, and DexScreener exact lookups for curated Ethereum/BSC contracts return no pools. Symbol search hits unrelated Solana `USBD` tokens, so it is unsafe. | Leave missing until BIMA exposes a reliable redemption or market API. |
| `usdq-quill` | USDQ | CoinGecko has a stale USD mark; DefiLlama list and coins API return no current price; DexScreener exact Scroll lookup returns no pairs. GeckoTerminal has only dust pools with zero recent volume, far below the existing GT probe TVL floor. | Leave missing. Do not use symbol search because it resolves unrelated Ethereum USDQ markets. |
| `tryb-bilira` | TRYB | CoinGecko native TRY/USD quote exists but was stale beyond the freshness gate; DefiLlama list/coins return no price; DexScreener exact lookups only found sub-$100 Avalanche liquidity. | Leave missing unless a fresh native quote returns or a real market/API source appears. |
| `chfau-allunity` | CHFAU | CoinGecko returns `last_updated_at: 0`, DefiLlama coins has no contract price, and DexScreener has no exact/search pool. | Leave missing until AllUnity or an aggregator exposes a live price. |

Methodology version updated to Pricing Pipeline `v4.31` for the two implemented pricing-path changes.
