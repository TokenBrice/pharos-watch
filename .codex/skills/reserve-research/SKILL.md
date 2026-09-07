---
name: reserve-research
description: Research and populate stablecoin reserve composition, review provenance, custody evidence, dependency edges, and backing-pillar slice fields.
---

Read `docs/editorial-style.md`; its `technical-evidence` register governs prose.

# Reserve Research

Read the current methodology version, `docs/process/stablecoin-research-sidecars.md`, `docs/report-cards.md`, the coin’s base/merged entry, and its reserves sidecar. `shared/lib/stablecoins/schema.ts` and `shared/types/reserves.ts` own shapes/tolerances. Write `reserves`, `reserveReview`, and `custodyProfile` only to `shared/data/stablecoins/domains/reserves/<id>.json`; create it when absent.

## Workflow

1. Inventory collateral, peg mechanism, backing/governance flags, proof configuration, existing reserve slices/review, and custody profile. Preserve non-reserve fields unless explicitly in scope.
2. Gather primary evidence: transparency dashboards, attestations, issuer/protocol docs, legal filings/fund facts, and protocol dashboards. Use secondary sources only to fill or corroborate gaps.
3. Convert credible findings into concrete slices totaling 100 within the source-owned tolerance. Do not fabricate percentages.
4. Populate current backing fields from evidence: `assetClass`, `issuerOrObligor`, `liquidityHorizon`, `riskFactors`, and `maturityDaysMax` only for a stated hard maximum—never convert weighted-average maturity. Link tracked stablecoin backing with `coinId` and justified `depType`.
5. Keep schema-required legacy `risk` accurate using `shared/lib/reserve-asset-risk.ts`; for an unlisted symbol, choose the more conservative defensible tier and explain uncertainty. The current backing pillar uses structured slice fields, not this legacy tier.
6. Author/refresh `reserveReview` with sources, basis/date, reviewed scope, reviewer/date/confidence, and required dispositions. Add `custodyProfile` only when its provider/control claims are evidenced.

For research-only work, present proposed JSON, sources, basis date, approximations, and confidence. For approved implementation, patch the sidecar, run `npm run bootstrap:generated` and `npm run check:stablecoin-data`, and follow the addition validation phase when relevant.

Keep slice names specific; unknown structure remains explicit. A slice without `assetClass` or `coinId` is bounded unknown, not safe. A one-coin data update is not a methodology change.
