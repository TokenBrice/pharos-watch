---
name: reserve-research
description: Research and populate `reserves` data for a tracked stablecoin in the Pharos dashboard. Use when adding or auditing reserve composition in `shared/data/stablecoins/coins/*.json`, especially for report-card quality, dependency-risk linking, or reserve-based resilience scoring.
---

# Reserve Research

Research the reserve composition, classify each slice with the repo's 5-tier reserve risk model, and write a sourced `reserves` array into the coin's JSON entry under `shared/data/stablecoins/coins/*.json` when the evidence is good enough.

## Read First

- Read the coin's current entry in `shared/data/stablecoins/coins/*.json` (or `shared/data/stablecoins/coins.generated.json` for a canonical runtime view).
- Treat the runtime stablecoin re-export as import-only; reserve metadata edits belong in the per-coin JSON registry and must match `shared/lib/stablecoins/schema.ts`.
- Read `docs/report-cards.md` when you need the live reserve-risk scoring rules.
- Preserve existing `collateral`, `pegMechanism`, `flags`, and `proofOfReserves` fields unless the user explicitly asked to revisit them.

## Workflow

1. Read the current state:
- `collateral`
- `pegMechanism`
- `flags.backing`
- `flags.governance`
- `proofOfReserves`
- existing `reserves`

2. Gather primary sources first:
- official transparency dashboard or proof-of-reserves page
- attestation PDFs
- issuer or protocol docs
- legal filings or fund fact sheets for RWA coins
- protocol dashboards for DeFi-backed coins

3. Use secondary sources only to fill gaps or confirm interpretation.

4. Convert the findings into 2-7 reserve slices that sum to roughly 95-100.

5. If a slice is backed by another tracked stablecoin, add:
- `coinId`
- optional `depType` when the relationship is clearly `wrapper` or `mechanism`

6. If the user asked for implementation, patch the coin's per-coin JSON file, regenerate `shared/data/stablecoins/coins.generated.json`, and run `npm run check:stablecoin-data`; for full additions, follow Phase 7 in `docs/process/adding-a-stablecoin.md`. If the request is research-only, stop after presenting the proposed array with sources and confidence.

## Risk Tiers

- `very-low`: cash, insured deposits, short-dated Treasuries, overnight repos, physical gold or silver
- `low`: stablecoins, tokenized Treasuries or money-market funds, high-quality on-chain LST-heavy collateral
- `medium`: BTC, ETH, wBTC, delta-neutral positions, tokenized gold, structured yield products
- `high`: altcoins, credit risk, LP tokens, complex DeFi strategies, off-exchange basis trades
- `very-high`: opaque reserves, governance-token support, sanctioned or distressed assets, purely algorithmic stabilization

When uncertain between two tiers, choose the riskier one and explain why.

## Guardrails

- Do not fabricate percentages when no credible breakdown exists.
- Every slice should be defensible from a source or a clearly stated approximation.
- Keep slice names concrete.
- If methodology changes, update the application docs and `/methodology`. If you are only adding data for one coin, no methodology doc update is needed.
