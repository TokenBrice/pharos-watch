# Stablecoin Support Review — 2026-04-21

Assumption: “add if possible” means a coin should clear the current Pharos add process without inventing unsupported supply, reserve, redemption, or methodology inputs.

## Added

- `audf-forte`
  - Reason: AUD peg support already exists locally, Forte publishes public reserve-report and legal surfaces, and the coin has verified EVM contracts with a clean CoinGecko admission path.
  - Scope shipped: metadata, contracts, curated reserves, a documented offchain-issuer redemption backstop, logo, editorial summary, canonical order, and legacy redirect alias.

- `doc-money-on-chain`
  - Reason: DefiLlama admission exists (`llamaId=30`), official Money On Chain docs clearly support BTC-backed collateral and permissionless DOC-to-rBTC redemption, and reserve composition is defensible as a single `rBTC` slice.
  - Scope shipped: metadata, contracts, curated reserves, a documented collateral-redemption backstop, logo, editorial summary, canonical order, and legacy numeric redirect alias.

- `usdrif-rif`
  - Reason: DefiLlama admission exists (`llamaId=159`), RIF On Chain docs support mint/redeem semantics, and reserve composition is defensible as a single `RIF` slice.
  - Caveat accepted: no live-reserve adapter or redemption-backstop config shipped in this pass; the add is static-metadata / static-reserve support only.
  - Scope shipped: metadata, contracts, curated reserves, logo, editorial summary, canonical order, and legacy numeric redirect alias.

## Deferred

- `myrc-blox`
  - Best deferred candidate.
  - Strong reserve evidence exists, including public attestation PDFs and official contract addresses.
  - Blocker: proper support requires explicit `MYR` peg / FX plumbing. That is a pricing-pipeline expansion and would require methodology/docs updates in the same change.

- `cngn-compliant-naira`
  - Blockers: `NGN` peg / FX support is missing locally, and the public reserve surface is not strong enough yet. The public transparency / proof-of-funds pages still show zeroed counters, so reserve evidence is too brittle for a clean tracked add.

- `dllr-sovryn`
  - Blocker: official sources support a `DOC + ZUSD` basket, but I did not find a defensible current basket split. Adding DLLR without that would force invented reserve percentages and incomplete dependency coverage because `ZUSD` is not tracked.

- `money-defi-money`
  - Blocker: the protocol announced a shutdown effective May 7, 2025, and current docs still do not provide a defensible reserve packet or holder-level redemption model for a normal active tracked add.

## Notes

- I intentionally did **not** add live reserve configs in this pass.
  - `audf-forte` now carries a documented offchain-issuer redemption route, but stronger reserve automation would still require a machine-readable reserve source rather than static PDFs.
  - `doc-money-on-chain` now carries a documented collateral-redemption route, but score-grade reserve passthrough still needs a dedicated Rootstock / Money On Chain live reserve adapter.
  - `usdrif-rif` still remains a static-metadata / static-reserve add; a weaker queue-style or reviewed static redemption treatment may still be warranted later rather than a strong direct rail.
- I also intentionally did **not** expand peg support to `MYR` or `NGN` in this pass.
  - That would move the change from “curated data add” into “pricing pipeline / methodology expansion”.
