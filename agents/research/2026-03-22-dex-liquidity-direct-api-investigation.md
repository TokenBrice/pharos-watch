# 2026-03-22 Dex Liquidity Direct API Investigation

## Reported Run

- Job: `sync-dex-liquidity`
- Started at: `2026-03-22T00:40:15Z`
- Status: `degraded`
- Duration: `409,926 ms`
- Metadata flags:
  - `failedSources`: `raydium-api`, `orca-api`, `fluid-dex-api`
  - `fallbackMode`: `raydium-api-partial`, `orca-api-partial`, `fluid-dex-api-partial`
  - Coverage unchanged at `135`
  - Price-observation coins dropped from `116` to `114`

## Comparison

- Previous successful run: `2026-03-22T00:10:15Z`
- Status: `ok`
- Duration: `238,750 ms`
- No failed direct API sources

The degraded run added roughly `171 s` of wall time without tripping coverage guards, which points to partial upstream/runtime stalls rather than a scoring or persistence regression.

## Live Probing

- Remote D1 confirmed the degraded row and the prior healthy row.
- Isolated live probes showed:
  - `fetchRaydiumPools()` succeeding cleanly in about `4.5 s`
  - `fetchOrcaPools()` succeeding cleanly in about `4.8 s`
  - `fetchFluidPools()` spending significant time in resolver RPC enrichment and hitting repeated public-RPC `429` responses during local reproduction

## Root Cause

Two code issues matched the observed behavior:

1. `worker/src/cron/dex-liquidity/fetch-fluid.ts` built its RPC map at module load with `buildChainRpcs()` and therefore never used scheduled-runtime `ALCHEMY_API_KEY` / `DRPC_API_KEY`. Fluid resolver enrichment always fell back to public RPC endpoints in production.
2. `worker/src/cron/dex-liquidity/orchestrator.ts` started the direct API phase before UniV3/Aerodrome enrichment finished. That let direct API fetches, Fluid resolver RPCs, and subgraph requests share the same trigger-local connection pool, creating a plausible path for Raydium/Orca partial failures in the same run.

## Fix

- Thread `runtime.chainRpcs` into `syncDexLiquidity()` and `fetchFluidPools()`.
- Use the provided `chainRpcs` for Fluid resolver calls.
- Add a 15s timeout to the Fluid ticker fetch itself.
- Run the direct API stage after UniV3/Aerodrome enrichment instead of overlapping those fetch families.

## Verification

- Targeted tests:
  - direct API tests for Fluid resolver RPC selection
  - sync orchestration tests for delayed direct API start and `chainRpcs` plumbing
- Worker type-check
