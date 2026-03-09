---
title: "Expand lending protocol allowlist"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "low"
done: false
---

## Goal

Add vetted lending protocols to `LENDING_PROTOCOL_ALLOWLIST` to expand auto-discovery coverage.

## Task

1. **Read `worker/src/cron/yield-config.ts`** — Find `LENDING_PROTOCOL_ALLOWLIST` (line ~313-334). It's a Set of DeFiLlama project slug strings, organized by tier comments.

2. **Add new protocols** based on the orchestrator's research output. The orchestrator will amend this ticket with exact slugs and tier assignments.

   **Tier 1 additions** (add after `"yearn-finance",`):
   ```typescript
   "compound-v2",       // $112M TVL, ETH stablecoin markets (USDT $20M, DAI $5.8M, USDC $3.1M)
   "dolomite",          // $284M TVL, ETH+ARB stablecoin markets (USD1 $64M, USDC $15M)
   ```

   **Tier 2 additions** (add after `"pendle",`):
   ```typescript
   "curve-llamalend",        // $59M TVL, crvUSD lending on ETH ($32.5M top pool)
   "exactly",                // $32M TVL, USDC lending on Optimism (6 pools, $1.7M each)
   "flux-finance",           // $43M TVL, USDT/USDC on ETH (Ondo ecosystem)
   "gains-network",          // $21M TVL, USDC vaults on ARB ($12.2M) + Base ($1.9M)
   "lazy-summer-protocol",   // $45M TVL, USDC vaults on ETH ($14.8M) + Base ($3.6M)
   "moonwell-lending",       // $46M TVL, USDC on Base ($7.4M)
   "silo-v2",                // $46M TVL, multi-chain isolated lending (ETH, ARB, AVAX)
   ```

   **Tier 3 additions** (add after `"stables-labs-usdx",`):
   ```typescript
   "benqi-lending",     // $133M total TVL, $8M stablecoin; USDC/USDT on Avalanche
   ```

3. **Placement:** Add Tier 2 entries after the existing Tier 2 comment block. Add Tier 3 entries after the existing Tier 3 comment block. Maintain alphabetical order within each tier if the existing entries follow that pattern.

## Acceptance Criteria

- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `npm run build` exits 0
- `LENDING_PROTOCOL_ALLOWLIST` contains more entries than before
