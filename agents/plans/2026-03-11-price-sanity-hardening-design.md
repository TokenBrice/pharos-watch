# Price Sanity Hardening Design

**Date:** 2026-03-11
**Status:** Proposed
**Scope:** `isReasonablePrice`, dual-primary price arbitration, DEX price sanity, FX/metal reference loading, price-validation telemetry

## Problem

The current price sanity system uses one generic helper for three different jobs:

1. Guarding primary prices before they enter the stablecoins cache
2. Filtering fallback and DEX-derived prices
3. Filtering historical price points during depeg backfill

That one-size-fits-all design creates two opposite failure modes:

- It is sometimes too loose and lets clearly bad prices through
- It is sometimes too blunt and can reject extreme but legitimate failures

This is most visible for:

- Non-USD dual-primary disagreements, where the code currently defaults to DefiLlama for EUR/JPY/gold/silver instead of choosing the candidate closer to peg
- DEX price sanity, which does not use live FX or live metal spot and therefore falls back to static ranges
- Fractional gold tokens, where some paths do not consistently receive `commodityOunces`
- Low-nominal FX pegs such as JPY and IDR, where static fallback bounds can behave very differently from live-reference bounds

## Goals

- Preserve true catastrophic depegs when they are corroborated by trusted data
- Reject isolated bad prints from noisy fallback sources
- Use one canonical metadata context for every tracked asset
- Make FX and metal reference handling consistent across sync, DEX, and backfill paths
- Improve operator visibility into why a price was accepted or rejected

## Non-Goals

- Replace current upstream providers
- Change the depeg threshold methodology itself
- Change frontend behavior in this phase beyond improving the underlying price quality

## Current Failure Modes

| Area | Current behavior | Why it is risky |
|------|------------------|-----------------|
| Dual-primary, non-USD | On large DL vs CG disagreement, non-USD pegs default to DL | A bad EUR/JPY/gold price can beat a good CG price and still pass the broad sanity band |
| DEX sanity | DEX validation does not receive live FX or metal spot | DEX gold and low-nominal FX observations are judged against static fallback ranges that are sometimes far too loose and sometimes too strict |
| Fractional commodities | Some fallback paths rely on asset fields instead of canonical metadata | A valid fractional gold price can be judged as if it were a full-ounce token |
| Unknown peg context | Some sync paths trust upstream `pegType` directly | A tracked fixed-peg asset can fail open if upstream naming is missing or inconsistent |
| FX freshness | Different paths use different freshness rules | The same price can be accepted in one path and rejected in another |

## Proposed Design

## 1. Split Price Validation Into Explicit Modes

### Technical change

Replace the current single behavior with explicit validation modes:

- `primary_authoritative`
- `fallback_enrichment`
- `dex_observation`
- `historical_backfill`

Each mode uses the same canonical asset context, but different acceptance rules.

Recommended behavior:

- `primary_authoritative`
  - Allow deep downside failures when the source is trusted or corroborated
  - Keep strong upper-bound protection against obvious unit and API errors
- `fallback_enrichment`
  - Be stricter than primary mode
  - Require a price to be reasonably close to peg or reference unless another trusted source confirms it
- `dex_observation`
  - Be the strictest mode
  - DEX observations are supporting evidence, not the main source of truth
- `historical_backfill`
  - Allow wider downside moves than fallback/DEX
  - Do not let one arbitrary hard floor erase real historical failures

### Layman consequence

Before this change, the system had to choose one compromise rule for everything. That meant we could either keep the rule loose everywhere or risk blocking real crashes everywhere.

After this change, a trusted primary price and a thin DEX search result are no longer treated as if they deserve the same level of trust.

### Before / after example

Before this change, a global USD sanity rule could reject a `$0.0001` USDS price outright even if that collapse was real, because the same helper was trying to protect every path with one generic floor.

After this change, we can say:

- a `$0.0001` USDS price from one noisy fallback source is a likely fluke and should be rejected
- a `$0.0001` USDS price from two trusted sources is a real catastrophic failure and should be preserved

This lets us distinguish "one source glitched" from "the stablecoin actually broke."

## 2. Build One Canonical Validation Context Per Asset

### Technical change

Introduce a normalized `PriceValidationContext` built from tracked metadata first, not upstream payloads first.

Fields:

- canonical peg key
- peg class (`usd`, `fiat_fx`, `commodity`, `nav`, `variable`)
- `navToken`
- `commodityOunces`
- whether deep downside moves are allowed in the current mode

Tracked metadata should be the source of truth for:

- `pegType`
- BRL/`peggedREAL` normalization
- `commodityOunces`
- `navToken`

Upstream payload fields should only fill gaps for untracked assets.

### Layman consequence

Before this change, the same coin could be interpreted differently depending on which path touched it. A fractional gold token might be judged like a full-ounce gold token in one path and correctly in another.

After this change, every path sees the same definition of the asset.

### Before / after example

Before this change, a valid GGBR price could be judged using full-ounce gold rules in one fallback path, even though GGBR only represents `0.001` ounce.

After this change, GGBR is always treated as a `0.001` ounce gold token, so its sane range is scaled correctly everywhere.

## 3. Change Dual-Primary Arbitration To Be Reference-Driven For All Pegged Assets

### Technical change

When DefiLlama and CoinGecko disagree materially:

- derive the expected peg reference for the asset
- measure each candidate against that reference
- prefer the candidate closer to reference for every non-NAV pegged asset, not just USD pegs
- if both candidates are too far away, mark the result as low-confidence and avoid overwriting a better existing price unless corroborated

This applies to:

- EUR
- JPY
- BRL
- gold
- silver
- other fixed-value pegs

NAV tokens remain a special case because they are intentionally not pegged to a constant face value.

### Layman consequence

Before this change, if one source said a euro stablecoin was `$1.80` and the other said `$1.08`, the system could still choose `$1.80` just because the coin was not USD-pegged.

After this change, the system asks the obvious question first: "Which number looks more like the peg this token is supposed to track?"

### Before / after example

Before this change:

- DL says EUR stablecoin = `$1.80`
- CG says EUR stablecoin = `$1.08`
- code can keep `$1.80`

After this change:

- the EUR reference is around `$1.08`
- `$1.08` is clearly closer to peg than `$1.80`
- the system keeps `$1.08` unless stronger evidence says the peg really moved

## 4. Feed Live FX And Live Gold/Silver Spot Into DEX Price Sanity

### Technical change

DEX price sanity should load the same fresh reference set used by the main sync:

- live FX rates for fiat pegs
- live gold spot for gold pegs
- live silver spot for silver pegs

The DEX layer should stop relying on static fallback bounds during normal operation.

When fresh references are unavailable:

- use a clearly marked static fallback path
- lower trust in those observations
- never silently treat static fallback as equivalent to live reference validation

### Layman consequence

Before this change, DEX sanity was judging gold and some FX pegs with rough emergency ranges even during normal operation.

After this change, DEX prices are checked against the actual peg reference they are supposed to track.

### Before / after examples

Before this change, a GGBR DEX price of `$50` could look plausible to the fallback range even though GGBR tracks `0.001` ounce of gold and should be near a few dollars, not fifty.

After this change, the DEX layer uses live gold spot and GGBR's unit size, so `$50` is rejected as obvious noise.

Before this change, a JPYC DEX crash to `$0.0005` could be treated differently from the main sync path because DEX used static fallback bounds while the main sync used live JPY reference logic.

After this change, both paths judge the move against the same fresh JPY reference.

## 5. Unify FX/Metal Freshness Rules Across All Callers

### Technical change

Create one shared loader for price-validation references:

- returns fresh FX and metal references if within TTL
- returns stale/static fallback only with an explicit reason
- exposes whether validation was done with `fresh`, `stale`, or `static` references

Every caller should use the same loader:

- `syncStablecoins`
- `enrichMissingPrices`
- DEX price sanity
- backfill-depegs

### Layman consequence

Before this change, the same price could be accepted by one path and rejected by another just because one caller considered the FX cache fresh enough and another did not.

After this change, there is one answer to "what reference are we using right now?" and every caller uses it.

### Before / after example

Before this change, an 8-hour-old FX cache might be ignored in one path, used in another path, and skipped entirely in the DEX path.

After this change, the system has one shared freshness policy and one shared fallback behavior, so the result is predictable.

## 6. Add Acceptance Reasons, Rejection Reasons, And Focused Tests

### Technical change

Record why a price was accepted or rejected:

- source class
- validation mode
- reference type used (`fresh`, `stale`, `static`)
- candidate/reference ratio
- reason code such as:
  - `closer_to_reference`
  - `single_source_outlier`
  - `dex_above_max`
  - `missing_commodity_scale`
  - `unknown_peg_fell_back`

Add focused tests for:

- non-USD dual-primary divergence selection
- DEX gold and DEX JPY with live references
- fractional gold in fallback enrichment
- severe downside moves that should survive in authoritative mode
- stale-reference behavior

### Layman consequence

Before this change, operators could often see that a price was missing or present, but not clearly why the sanity layer made that decision.

After this change, the system can explain its decision in plain terms: "rejected because this was a thin DEX print 8x above live gold spot" or "accepted because two trusted sources agreed during a real crash."

### Before / after example

Before this change, if a price disappeared, an operator might only know that it failed some internal sanity rule.

After this change, the operator can see exactly what happened:

- source: DexScreener
- mode: `dex_observation`
- reference: fresh gold spot
- reason: `dex_above_max`

## File Touch Points

Expected implementation touch points:

- `worker/src/cron/enrich-prices.ts`
- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/sync-stablecoins/stages.ts`
- `worker/src/cron/dex-liquidity/price-sanity.ts`
- `worker/src/api/backfill-depegs.ts`
- `worker/src/cron/__tests__/enrich-prices.test.ts`
- `worker/src/cron/__tests__/sync-stablecoins.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts`
- `docs/data-pipeline.md`
- `docs/dex-liquidity.md`

## Acceptance Criteria

- A confirmed catastrophic depeg is not rejected solely because it falls below a generic peg floor
- A single noisy fallback price is not allowed through just because the global helper is permissive
- Non-USD dual-primary disagreements choose the candidate closer to peg unless the asset is NAV-like
- DEX sanity uses live FX and live metal references in normal operation
- Fractional gold tokens are validated with correct unit scaling in every path
- Operators can see why a price was accepted or rejected

## Rollout Notes

- This should be implemented in one feature branch because the value comes from consistency across all paths
- Docs should be updated alongside code, especially `docs/data-pipeline.md` and `docs/dex-liquidity.md`
- The first rollout should bias toward visibility: log and count new reason codes before tightening any policy further

## Summary In Plain English

The design changes the price sanity layer from "one blunt rule for everything" to "context-aware validation."

That gives the system a cleaner split:

- real crashes can still be preserved when trusted evidence says they are real
- thin, noisy, or obviously bad prices are filtered more aggressively
- FX, gold, and fractional gold are judged with the right reference data
- operators can understand the decision instead of guessing
