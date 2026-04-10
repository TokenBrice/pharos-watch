# Plan: remediate `usdk-kast` / `xo-exodus` price, DEX, and liquidity-history gaps

## Goal

Resolve the user-visible “broken page” symptoms for `usdk-kast` and `xo-exodus` without fabricating market data:

- restore a defensible price
- preserve truthful direct-liquidity semantics
- make liquidity-history behavior explicit instead of hidden

## Non-goals

- do not invent direct DEX pools for either token
- do not alias their liquidity score to another asset’s pools
- do not add manual one-off price constants

## Plan v1

1. Add pricing fallbacks for `usdk-kast` and `xo-exodus`.
2. Reuse `wm-m0` DEX pools for both assets so their liquidity card and liquidity history stop looking empty.
3. Show the liquidity chart even when the score is missing.
4. Add tests and docs.

## Review v1

### Findings

1. High: step 2 would fabricate direct DEX liquidity for the wrong token. `wm-m0` pool evidence is not evidence for `usdk-kast` or `xo-exodus`, and aliasing it into canonical liquidity would break the methodology.
2. Medium: step 1 is underspecified. The plan says “add pricing fallbacks” but does not define the parent asset, the source label, or how historical prices should be replayed.
3. Low: step 4 does not name the exact docs and methodology surfaces that must change.

## Plan v2

1. Add an explicit authoritative inherited-price provider in `worker/src/lib/authoritative-price-sources.ts` for:
   - `usdk-kast -> wm-m0`
   - `xo-exodus -> wm-m0`
2. Mirror the existing `usdai-usd-ai -> pyusd-paypal` pattern for both live and historical prices:
   - live override reads the already-published tracked `wm-m0` price
   - historical backfill replays the tracked `wm-m0` series
   - published source remains explicit as an authoritative override rather than pretending the child token had its own market quote
3. Keep canonical DEX/liquidity logic unchanged for the exact mints:
   - no `tradedContracts` aliasing
   - no token-resolution aliasing
   - no synthetic pool injection
4. Improve the detail-page empty state in `src/components/dex-liquidity-card.tsx` so unrated `unobserved` assets explicitly say there is no observed direct DEX market for the token.
5. Remove the `isRated` gate that currently suppresses liquidity history for unrated assets.
6. Add tests for:
   - live inherited price resolution
   - historical inherited price replay
   - DEX card rendering for unobserved unrated assets
7. Update:
   - `docs/pricing-pipeline.md`
   - `docs/dex-liquidity.md`
   - `docs/stablecoin-detail-page.md`
   - `docs/data-pipeline.md`
   - `src/app/methodology/sections/core-sections-pricing.tsx`
   - the pricing methodology changelog/version note path if the source semantics change

## Review v2

### Findings

1. Low: “remove the `isRated` gate” is still too loose. If it simply renders the existing zero-value trend line for an `unobserved` asset, the page can imply measured zero TVL instead of “no direct market observed.”

## Plan v3

### Workstream 1: authoritative inherited price

1. Extend `worker/src/lib/authoritative-price-sources.ts` with a small config-driven inherited-price mapping for `usdk-kast` and `xo-exodus`, both pointing to `wm-m0`.
2. Reuse the existing authoritative provider mechanics rather than creating a separate fallback pass:
   - live: read the tracked parent asset from the in-memory `assetsById` context
   - historical: replay the parent tracked series through the existing market-backfill helper
3. Keep the published provenance explicit:
   - use the authoritative override source path, not a fake child-market source
   - document that these assets inherit `wm-m0` because Pharos models them as instantly redeemable M0-extension units rather than independently discovered traded markets
4. Add regression coverage for:
   - `usdk-kast` inherited live price from `wm-m0`
   - `xo-exodus` inherited live price from `wm-m0`
   - historical replay for both ids
   - null-parent behavior when `wm-m0` is unavailable

### Workstream 2: keep canonical liquidity honest

1. Do not change `worker/src/cron/dex-liquidity/token-resolution.ts`, `worker/src/lib/dexscreener.ts`, discovery staging, or liquidity scoring to alias these assets to another token.
2. Preserve current `unobserved` placeholder persistence in `worker/src/cron/dex-liquidity/persistence.ts` for both assets until trusted direct market evidence exists for their exact mints.
3. Improve the card copy for `liquidityEvidenceClass === "unobserved"` so the page states the real condition:
   - no observed direct DEX market for this token
   - liquidity score remains unrated because Pharos scores exact-token pool evidence, not related-asset liquidity
4. Keep any related-market navigation separate from canonical liquidity metrics. The implementation may point users to existing M0 cohort / related-stablecoin surfaces, but it must not merge those metrics into the card totals or score.

### Workstream 3: fix liquidity-history presentation

1. Replace the current `isRated` history gate in `src/components/dex-liquidity-card.tsx` with evidence-aware rendering:
   - rated assets: keep `TvlTrendChart`
   - `unobserved` history: render a dedicated unobserved-history state instead of a zero-value market chart
2. Reuse the existing history API payload and its semantics:
   - `coverageClass`
   - `liquidityEvidenceClass`
   - `trendworthy`
3. The unobserved-history state should show that the backend has tracked the period and found no direct liquidity evidence, rather than implying measured zero-liquidity market action.
4. Add regression tests for:
   - the unobserved-history state rendering when `liquidityScore` is null
   - no accidental chart render for placeholder-only history

### Workstream 4: docs and methodology

1. Update `docs/pricing-pipeline.md` and `docs/data-pipeline.md` to document the inherited-authoritative price path for these M0 extensions.
2. Update `src/app/methodology/sections/core-sections-pricing.tsx` and the pricing methodology version/changelog note so `/methodology` reflects the new inherited-price coverage.
3. Update `docs/dex-liquidity.md` and `docs/stablecoin-detail-page.md` to document the distinction between:
   - canonical direct-token liquidity
   - unobserved placeholder history
   - optional related-market navigation that does not alter the score

### Validation

1. Run targeted tests first for authoritative pricing and detail-card rendering.
2. Before pushing, run:
   - `npm run lint`
   - `npm test`
   - `npm run build`
   - `cd worker && npx tsc --noEmit`
   - `npm run test:merge-gate`

## Review v3

### Findings

- none

### Result

- High issues: `0`
- Medium issues: `0`
- Low issues: `0`

Plan status: approved for implementation.
