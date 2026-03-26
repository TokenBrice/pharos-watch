# Yield Intelligence Operations

This note supplements [`docs/yield-intelligence.md`](./yield-intelligence.md) with runtime guardrails for the `sync-yield-data` cron.

## Slot Context

- `sync-yield-data` runs in the half-hourly slot after `sync-stablecoin-charts`, `sync-dex-liquidity`, `compute-dews`, and `stability-index`.
- The yield cron must finish inside the shared half-hourly wall-clock budget; optional upstreams cannot be allowed to stall the slot.

## Runtime Guardrails

- Deterministic on-chain vault reads now run one asset at a time with a 6 second per-RPC timeout and explicit per-URL failover.
- When both a provider RPC and a public fallback are configured for a deterministic yield source, the reader probes the fallback/public URL first to avoid inheriting a sticky provider failure across the whole half-hourly slot.
- Single-coin optional adapters are time-boxed to 12 seconds:
  - `BIMA sUSBD`
  - `Hashnote USYC`
  - `Ondo USDY oracle`
  - `B.Protocol LQTY-only`
- Protocol API families use an 8 second per-request timeout, no retries, and a 25 second family budget:
  - `Morpho`
  - `Pendle`
  - `Yearn/Kong`
  - `Beefy`
- Optional RPC families use a 30 second family budget:
  - `Compound V3`
  - `Aave V3`
- Aave on-chain reads are batched two assets at a time to stay below the Worker connection ceiling when the half-hourly slot is already processing other external sources.

## Failure Semantics

- Deterministic on-chain rows, curated DeFiLlama rows, price-derived rows, and rate-derived rows remain the primary publication path.
- When an optional source budget is exhausted, the cron logs a warning and continues with the best remaining data instead of timing out the entire run.
- Chain-looped optional families keep any partial results they already collected before the budget expires.
- The intended failure mode for optional upstream stress is reduced supplemental coverage, not a missing `yield-rankings` publish.
