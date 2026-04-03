# USDAI Liquidity Root Cause (2026-04-03)

## External evidence

- Tweet thread:
  - `https://x.com/ssmccul/status/2040076668321107992?s=20`
  - `https://x.com/ssmccul/status/2040077606788210936?s=20`
- Downloaded screenshots:
  - `agents/tmp/usdai-tweet/2040076668321107992-1.jpg`
  - `agents/tmp/usdai-tweet/2040076668321107992-2.jpg`
  - `agents/tmp/usdai-tweet/2040076668321107992-3.jpg`
  - `agents/tmp/usdai-tweet/2040077606788210936-1.jpg`

## What was wrong

USDAI Balancer liquidity was overstated by two separate duplicate-admission failures:

1. GeckoTerminal returned Plasma Balancer pool `0x4ba45fb7de134bcb24a6053bbe21c3a4be9f85ea` with `reserve_in_usd ~= $3.33M`, while Balancer's own API reports the same exact pool as `GYROE` with `totalLiquidity = $7.24`.
2. DeFiLlama pool `0511276f-4d37-4919-95ab-6cdf418ddd08` (`balancer-v3`, Plasma, `USDAI-WAPLAUSDT0`, `$547,701`) survived alongside the exact same Balancer direct-API pool `0x01e2c7fcde2b8d5d1413732c4e274ba5b06b1e54` because the DL identity path treated it as a weighted Balancer row instead of a stable-pair dedupe candidate.

## Why it happened

### 1. Sub-threshold direct pools were not reserving their exact ids

- `integrateDirectApiLiquidityPhase()` only registered retained direct-API pools in the known-pool index.
- The authoritative Balancer `0x4ba...` row was below the `$10K` scoring floor, so it never reserved its exact pool id.
- Later GeckoTerminal staging merged the same exact address with incompatible TVL semantics.

### 2. Balancer stable-pair identity fallback was missing for `balancer-v3`

- The DL row used project metadata `balancer-v3` with no stable subtype.
- The dedupe identity therefore resolved as weighted, while Balancer direct API resolved the same pool as stable.
- Exact dedupe was impossible because DL uses UUIDs, so the pool stayed as a second Balancer row.

## Fix implemented

- Reserve every direct-API exact pool id for later staged/fallback exact-address dedupe, even when the direct row itself is too small to score.
- Treat Balancer identity shape as stable for dedupe when the protocol is Balancer and the row is explicitly marked stablecoin-only, allowing `balancer-v3` DL stable pools to collapse against Balancer direct API.

## Files changed

- `worker/src/cron/dex-liquidity/orchestrator-phases.ts`
- `worker/src/cron/dex-liquidity/pool-identity.ts`
- `worker/src/cron/dex-liquidity/__tests__/orchestrator-phases.test.ts`
- `worker/src/cron/__tests__/sync-dex-liquidity.test.ts`
- `docs/dex-liquidity.md`
- `docs/liquidity-score-timeline.md`
- `src/app/methodology/sections/core/liquidity-section.tsx`
- `shared/lib/liquidity-score-version.ts`
