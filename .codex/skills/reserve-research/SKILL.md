---
name: reserve-research
description: Research and populate `reserves` data for a tracked stablecoin in the Pharos dashboard. Use when adding or auditing reserve composition, especially for the Safety Score V9 backing pillar, dependency graph edges, or reserve report quality.
---

# Reserve Research

Research the reserve composition and write a sourced `reserves` array (with the V9 scoring fields populated per slice) into the coin's registry entry when the evidence is good enough.

## Read First

- **Route the write first:** every reserves-domain field (`reserves`, `reserveReview`, `custodyProfile`) belongs in `shared/data/stablecoins/domains/reserves/<id>.json` and must stay out of the base file. Create the sidecar when absent. See `docs/process/stablecoin-research-sidecars.md` and `shared/data/stablecoins/AGENTS.md`.
- Read the coin's current entry (base JSON + any reserves sidecar, or `shared/data/stablecoins/coins.generated.json` for a canonical runtime view).
- Treat the runtime stablecoin re-export as import-only; reserve metadata edits belong in the JSON registry and must match `shared/lib/stablecoins/schema.ts`.
- Read `docs/report-cards.md` (Safety Score V9) for how the backing pillar consumes reserve slices.
- Preserve existing `collateral`, `pegMechanism`, `flags`, and `proofOfReserves` fields unless the user explicitly asked to revisit them.
- Reserve data (base or sidecar) is **not** V9 identity-bound — edits move scores without rotating the evaluation-build identity.

## Workflow

1. Read the current state:
- `collateral`
- `pegMechanism`
- `flags.backing`
- `flags.governance`
- `proofOfReserves`
- existing `reserves`, `reserveReview`, and `custodyProfile` from the reserves sidecar or merged runtime entry

2. Gather primary sources first:
- official transparency dashboard or proof-of-reserves page
- attestation PDFs
- issuer or protocol docs
- legal filings or fund fact sheets for RWA coins
- protocol dashboards for DeFi-backed coins

3. Use secondary sources only to fill gaps or confirm interpretation.

4. Convert the findings into 2-7 reserve slices that sum to 100 (tolerance: `RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT` in `shared/types/reserves.ts` — the source file wins; `check:stablecoin-data` fails outside it).

5. Populate the V9 scoring fields on each slice — these, not the legacy `risk` tier, are what the Safety Score V9 backing pillar reads (`worker/src/lib/safety-score-v9-extension-reserves.ts`):
- `assetClass`
- `issuerOrObligor`
- `liquidityHorizon`
- `maturityDaysMax` — only when a source states a hard maximum; **never convert a weighted-average maturity into `maturityDaysMax`**
- `riskFactors`

A slice with no `assetClass` and no `coinId` scores as bounded-unknown quality: an unpopulated slice is an unscored slice.

6. If a slice is backed by another tracked stablecoin, add:
- `coinId`
- optional `depType` when the relationship is clearly `wrapper` or `mechanism`

7. Author or refresh `reserveReview` alongside the composition (reviewer, review date, confidence, sources, composition basis, scope; `nonLinkDispositions` for reviewed unlinked slices — the sidecars doc and `shared/lib/stablecoins/schema.ts` define the required shape).

8. If the user asked for implementation, patch or create the reserves sidecar, converge the aggregate and dependent projections with `npm run prebuild -- --only stablecoin-client-registry,report-card-registry-fingerprint,legacy-stablecoin-redirects`, and run `npm run check:stablecoin-data`; for full additions, follow Phase 7 in `docs/process/adding-a-stablecoin.md`. If the request is research-only, stop after presenting the proposed array with sources and confidence.

## Risk Tiers (legacy field — still schema-required)

The 5-tier `risk` value is **not** read by Safety Score V9; keep it accurate for schema validity and legacy surfaces, but spend research effort on the V9 slice fields above. Per-symbol source of truth: `shared/lib/reserve-asset-risk.ts` — use its tier when a symbol is listed there. Rough guidance for unlisted symbols:

- `very-low`: ETH/WETH (base asset, no counterparty layer), cash, insured deposits, short-dated Treasuries, overnight repos
- `low`: stablecoins, tokenized Treasuries or money-market funds, ETH LSTs, high-quality on-chain collateral
- `medium`: BTC and wrapped/bridged BTC, tokenized gold, delta-neutral positions, structured yield products
- `high`: volatile native L1 assets, credit risk, LP tokens, complex DeFi strategies, off-exchange basis trades
- `very-high`: governance-token support, opaque reserves, sanctioned or distressed assets, purely algorithmic stabilization

When uncertain between two tiers, choose the riskier one and explain why.

## Guardrails

- Do not fabricate percentages when no credible breakdown exists.
- Every slice should be defensible from a source or a clearly stated approximation.
- Keep slice names concrete.
- If methodology changes, update the application docs and `/methodology`. If you are only adding data for one coin, no methodology doc update is needed.
