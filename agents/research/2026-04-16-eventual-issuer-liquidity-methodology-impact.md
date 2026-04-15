# Eventual issuer redemption uplift methodology impact

Date: 2026-04-16

## Question

Explore the methodology change that would allow documented offchain issuer full-supply redeemability to uplift Safety Score Liquidity / Exit despite `capacitySemantics = "eventual-only"`.

This is a policy exploration only. No scoring code was changed.

## Candidate policy simulated

The simulated rule is intentionally narrow:

- route family is `offchain-issuer`
- `resolutionState = resolved`
- `modelConfidence != low`
- `capacityConfidence = documented-bound`
- `capacitySemantics = eventual-only`
- provider is `supply-full-model`
- route status is not `paused`, `degraded`, or `cohort-limited`
- severe active depeg gate is preserved, so `activeDepegBps >= 2500` still excludes the route unless there is live-direct permissionless redemption evidence

If eligible, the route uses the existing redemption score already capped by the `offchain-issuer` route-family cap of 65. The existing best-path formula is otherwise unchanged:

`effectiveExit = min(100, max(dex, redemption) + min(dex, redemption) * 0.10)`

## Snapshot

Inputs pulled from live `pharos.watch` site-data endpoints:

- report cards updated at `2026-04-15 22:15:29 UTC`
- redemption backstops updated at `2026-04-15 21:15:56 UTC`
- active report cards: 180

## Headline impact

Broadly enabling this policy would affect more than USDC and USDT:

- 74 active assets become direct candidates
- 74 assets receive a direct Liquidity / Exit change
- direct Liquidity / Exit delta among candidates: min `+6`, median `+20`, max `+65`, average `+25.95`
- 99 active assets receive an overall-score change after dependency propagation
- 59 active assets change letter grade: 52 direct candidates and 7 dependency-only downstream assets
- overall-score delta among changed assets: min `+1`, median `+4`, max `+19`, average `+5.34`

## USDC and USDT

| Asset | Liquidity current | Liquidity simulated | Overall current | Overall simulated | Grade |
| --- | ---: | ---: | ---: | ---: | --- |
| USDC | 71 | 78 | 75 | 77 | B+ -> B+ |
| USDT | 63 | 71 | 70 | 72 | B -> B |

For the two assets that motivated the question, the change is moderate: `+7/+8` Liquidity / Exit and `+2` overall, with no grade change.

## Largest direct overall changes

| Asset | Liquidity | Overall | Grade |
| --- | ---: | ---: | --- |
| M by M0 | 11 -> 66 | 47 -> 66 | D -> B- |
| MNEE | 13 -> 66 | 51 -> 69 | C- -> B- |
| Tether USA-T | 12 -> 66 | 51 -> 69 | C- -> B- |
| Midas mTBILL | 20 -> 67 | 57 -> 73 | C -> B |
| StablR USDR | 19 -> 67 | 56 -> 72 | C -> B |
| EURI | 22 -> 67 | 58 -> 73 | C -> B |
| Quantoz EURQ | 22 -> 67 | 54 -> 69 | C- -> B- |
| IDRT | 15 -> 67 | 43 -> 58 | D -> C |
| Pleasing USD | 27 -> 68 | 45 -> 59 | D -> C |
| Hex Trust USDX | 4 -> 65 | 34 -> 48 | F -> D |

The largest effects are not the large coins. They are issuer-backed assets with little or no measured DEX liquidity. This is the main methodological tradeoff.

## No-DEX candidates

Some candidates currently have no DEX liquidity score and would become rated for Liquidity / Exit solely from documented issuer redemption:

| Asset | Liquidity current | Liquidity simulated | Overall current | Overall simulated | Grade |
| --- | ---: | ---: | ---: | ---: | --- |
| BUIDL | NR | 65 | 67 | 71 | B- -> B |
| TBILL | NR | 65 | 72 | 75 | B -> B+ |
| USYC | NR | 65 | 64 | 69 | C+ -> B- |
| AxCNH | NR | 65 | 59 | 65 | C -> B- |
| rwaUSDi | NR | 65 | 57 | 64 | C -> C+ |
| CHFAU | NR | 65 | NR | NR | NR -> NR |

This is defensible only if the Liquidity / Exit dimension is explicitly broadened from "current market/current buffer exit" to "credible par exit including primary-market legal redemption." It is not defensible if the dimension is meant to measure immediately observable exit liquidity.

## Downstream dependency-only grade changes

Seven assets change grade without directly qualifying, because their upstream dependency scores improve:

| Asset | Overall | Grade | Dependency delta |
| --- | ---: | --- | ---: |
| wM | 52 -> 58 | C- -> C | +19 |
| ctUSD | 45 -> 51 | D -> C- | +19 |
| USD0 | 54 -> 56 | C- -> C | +7 |
| USDai | 64 -> 65 | C+ -> B- | +2 |
| USDU | 64 -> 65 | C+ -> B- | +2 |
| JUPUSD | 64 -> 65 | C+ -> B- | +3 |
| USX | 59 -> 60 | C -> C+ | +2 |

## Implementation surface

Code changes would be centered in `shared/lib/report-card-peg-liquidity.ts`:

- add a predicate such as `isDocumentedIssuerEventualRoute(redemption)`
- change `getSafetyEligibleRedemptionScore()` so this predicate bypasses the blanket `eventual-only` exclusion
- change `getRedemptionExclusionReason()` so these routes are not labeled `eventual-only route`
- update detail copy to say the route is used as capped documented issuer redemption, not as immediate capacity
- preserve severe-depeg exclusion unless the route is live-direct, dynamic, permissionless, and atomic/immediate

Tests to update/add:

- replace the blanket "does not let eventual-only redemption uplift liquidity" assertion with:
  - non-issuer eventual-only still excluded
  - documented-bound offchain issuer eventual-only can uplift
  - low-confidence issuer eventual-only still excluded
  - severe active depeg still excludes documented issuer eventual-only
  - queue and live-direct behavior unchanged
- add snapshot-level tests in `worker/src/lib/__tests__/report-cards-snapshot.test.ts` for raw input `redemptionUsedForLiquidity`

Documentation/versioning required:

- bump Safety Score methodology from v7.04 to the next numeric version
- update `shared/lib/safety-score-version-data.ts`
- update `docs/report-cards.md`
- update `docs/report-cards-timeline.md`
- update `/methodology` Safety Scores copy and scoring changelog content
- update `docs/redemption-backstops.md` language where it currently says eventual-only routes never uplift Safety Score liquidity
- run doc-sync checks after the version/doc update

The redemption-backstop methodology version likely does not need to change if row construction and route scoring stay unchanged. The consumer semantics live in Report Cards.

## Recommendation

Do not ship the broad policy without an explicit product decision that Liquidity / Exit should include primary-market legal redemption, not only immediate/observable exit capacity.

The policy is reasonable for USDC and USDT in isolation, but a general rule materially upgrades many smaller issuer assets and tokenized fund-style products that have thin or nonexistent secondary liquidity. A safer version would either:

- use a separate "Primary-market exit" sublabel and keep the score contribution visibly capped,
- require some non-null DEX liquidity before issuer redemption earns a diversification uplift,
- introduce a lower issuer-eventual cap than the current 65,
- or explicitly allowlist systemically important issuers, though that is less methodologically clean.

