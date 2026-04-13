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

1. **Scope `missingPriceRatio` denominator to canonical coins only.** Modify `worker/src/lib/status/data-quality.ts` to filter `stablecoinAssets` against the canonical ID set from `shared/data/stablecoins/canonical-order.json` before computing `totalStablecoins` and `missingPrices`. This is the most surgical fix.
2. **Triage the 9 canonical missing coins.** Each needs individual investigation: is it pre-launch (keep as missing), is the price-source config wrong (fix), or should it be removed from canonical tracking (delete).
3. **Decide whether to drop DL residuals from the cache write.** They are used for discovery candidate surfacing, so removing them entirely is a tradeoff. At minimum, a separate `cacheWriteResidualFilter` could exclude them from the main `stablecoins` payload and keep them in a separate `discovery-residuals` cache key.
4. **Add a test** that fixes the denominator at the canonical tracked count so threshold drift can be caught via unit tests instead of prod flapping.

## Status of the immediate fix

The Workstream 1 threshold raise (0.15 → 0.18 for `ratioDegraded`, 0.40 → 0.45 for `ratioStale`) handles the current situation comfortably:

- Current ratio 14.14% < 18% → healthy
- Even if 10 more coins became unpriced (ratio 16.6%) → still healthy
- Requires 73+ missing prices out of 403 to degrade → meaningful regression

The deeper fixes above are strict improvements but not blocking. Filed as follow-up tasks.
