# Post-wave-8 residual execution ledger

Implementation base: `360921587ed914fd47b271220c8b0f25b9bc4ef7`.

Offline replay cannot attribute score movement for this batch because the replay
envelope pins the deployed registry fingerprint. This ledger therefore records
only task completion and evidence disposition, with no score or counter claims.

| Task | Status | Evidence and disposition |
| --- | --- | --- |
| 1 — XAI cemetery retirement | DONE | SiloDAO's [deprecation plan and 2024-04-22 execution update](https://gov.silo.finance/t/a-plan-to-deprecate-xai-stablecoin/443) documents the retired mint module and burned credit lines. Ethereum `totalSupply()` at block 25,627,256 independently measured 5,358,653.226231736 XAI. XAI is removed from the tracked registry and retained as an `excluded` historical listing decision plus cemetery record. |
| 2 — yBOLD wrapper metrics | DONE | Yearn's [yBOLD documentation](https://docs.yearn.fi/getting-started/products/yvaults/yBold), [implementation](https://github.com/yearn/yBOLD), and the [Sherlock audit repository](https://github.com/sherlock-audit/2025-05-yearn-ybold) establish an ERC-4626 allocator of already-issued BOLD into Liquity Stability Pools. Wrapper-level collateralization and liquidation-capacity metrics and components are now `not-applicable`; parent BOLD ratios remain with `bold-liquity`. |
