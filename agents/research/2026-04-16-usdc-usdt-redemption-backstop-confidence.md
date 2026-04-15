# USDC and USDT redemption backstop confidence research

Date: 2026-04-16

## Scope and success criteria

Research whether USDC (`usdc-circle`) and USDT (`usdt-tether`) have enough public redemption-route evidence to raise their redemption backstop contribution in Pharos Safety Score Liquidity / Exit.

Success means finding a defensible current-capacity signal, not just a legal right to eventual redemption. Under the current methodology, medium-confidence issuer redemption is still excluded from Safety Score liquidity when `capacitySemantics` is `eventual-only`.

## Current Pharos state

Live `/api/redemption-backstops` shows both assets as:

- `resolutionState: resolved`
- `routeFamily: offchain-issuer`
- `score: 65`
- `capacityConfidence: documented-bound`
- `capacitySemantics: eventual-only`
- `modelConfidence: medium`
- `provider: supply-full-model`
- `immediateCapacityUsd: null`
- `immediateCapacityRatio: null`

Live `/api/report-cards` detail confirms the exclusion reason: redemption backstop 65/100 exists, but it is "not used for Safety Score uplift (eventual-only route)".

## USDC findings

Primary sources reviewed:

- Circle Transparency: https://www.circle.com/transparency
- Circle USDC Terms: https://www.circle.com/legal/usdc-terms

Circle's public materials support a documented direct issuer route for eligible Circle Mint users:

- The terms describe Circle Mint eligibility/KYC and say eligible users can redeem USDC for USD at 1 USD per 1 USDC, less applicable fees.
- The same terms reserve operational discretion to delay, decline, suspend, or limit issuance/redemption in specific compliance, legal, or operational cases.
- The transparency page provides reserve composition with a parseable `As of Apr 09, 2026` disclosure date and current reserve categories. The adapter already parses these fields.

Adapter status:

- `circle-transparency` emits reserve composition plus route metadata, but no `capacityUsd` or `capacityRatioOfSupply`.
- `LIVE_RESERVE_ADAPTER_DEFINITIONS["circle-transparency"].redemptionTelemetry.capacity` is `none`, so the validator intentionally rejects treating the adapter as a live capacity source.
- The transparency page does not expose a current redemption queue, same-day liquidity bucket, hard daily redemption limit, or processed/pending redemption capacity.

Conclusion for USDC: the existing `documented-bound` / `eventual-only` model is appropriate. The evidence can justify stronger source provenance, but not an immediate-bounded Safety Score liquidity uplift.

## USDT findings

Primary sources reviewed:

- Tether Transparency: https://tether.to/en/transparency
- Tether legal terms: https://tether.to/en/legal/
- Tether fees: https://tether.to/en/fees/
- Tether transparency JSON: https://app.tether.to/transparency.json

Tether's public materials support a documented direct issuer route for verified Tether customers:

- Legal terms state redemption is through the site, subject to minimum amounts and requirements, at 1 USD per USDt less fees where applicable.
- Terms state issuance/redemption requires verified customer status and identify redemption as a contractual right personal to that customer.
- The fee page lists a 100,000 USD minimum redemption amount and a redemption fee equal to the greater of 1,000 USD or 0.1%.
- The transparency page says tokens are backed 100% by reserves and circulation metrics are typically refreshed daily.

Adapter/API status:

- `https://app.tether.to/transparency.json` currently exposes per-chain token totals/reserve balances plus `total_assets`, `total_liabilities`, and `shareholder_eq`.
- It does not expose reserve-category composition, redemption queue state, current fiat-settlement capacity, daily redemption limit, route status, or source timestamp suitable for scoring-grade freshness.
- The repo's `tether` adapter is still correctly classified as `weak-live-probe` with no redemption capacity telemetry. The current `usdt-tether` live reserve config uses `curated-validated`, which is more appropriate for reserve composition than the coarse JSON feed.

Conclusion for USDT: the existing `documented-bound` / `eventual-only` model is appropriate. There is no public adapter-grade signal that would make it immediate-bounded or live-direct.

## Recommendation

Do not change Safety Score liquidity eligibility for USDC or USDT from the adapter evidence currently available.

What was safe to improve:

- Update reviewed route documentation sources in `OFFCHAIN_ISSUER_BACKSTOP_CONFIGS` so the public redemption-backstop row cites issuer terms and fee pages directly, instead of relying only on transparency/proof links.

What would be needed to raise Safety Score contribution:

- A public issuer API or page with a bounded current redemption capacity, pending queue, daily processing capacity, or route status that can age out and fail closed.
- Or a methodology change allowing documented offchain issuer full-supply redeemability to uplift Liquidity / Exit despite `eventual-only` semantics. That would be a broader scoring policy change and would need methodology/version updates.

