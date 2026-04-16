# sync-dex-liquidity CPU Recovery

Date: 2026-04-16

## Summary

`sync-dex-liquidity` had two linked production failures:

1. A source-incomplete run persisted an inflated DEX liquidity baseline.
2. The remediated Worker then started hard-terminating before cron finalization because the liquidity run exceeded Cloudflare's CPU limit.

## Production Evidence

- 2026-04-16 06:40:04 UTC: `sync-dex-liquidity` completed `ok` with source-complete global TVL around $7.025B.
- 2026-04-16 07:10:04 UTC: `sync-dex-liquidity` completed `degraded` with `defillama-protocols` unavailable and persisted a capless global TVL around $12.703B.
- 2026-04-16 07:40:04 UTC and 08:10:04 UTC: `sync-dex-liquidity` failed the value guard while comparing recovered normal TVL against the inflated $12.703B baseline.
- 2026-04-16 08:40 UTC, 09:10 UTC, and 09:40 UTC: the half-hourly slot entered `sync-dex-liquidity` but did not write a final `cron_runs` row.
- `wrangler tail` during the 09:40 UTC slot reported `"10,40 * * * *" ... Exceeded CPU Limit`.
- The same tail showed repeated EVM RPC failures from liquidity direct-API enrichment:
  `json: cannot unmarshal hex number with leading zero digits into Go struct field TransactionArgs.gas of type hexutil.Uint64`.

## Root Cause

The baseline poisoning root cause was the 07:10 degraded run persisting uncapped secondary-source liquidity while DeFiLlama Protocols was unavailable. The existing remediation skips persistence for that source state and selects the last source-complete metadata baseline.

The no-reporting root cause was Cloudflare CPU termination. The Fluid direct-API enrichment path sent `eth_call` with `gas: "0x0F4240"`. JSON-RPC quantities must not contain leading zero digits. Alchemy and fallback RPCs rejected those calls repeatedly during the DEX liquidity run, which burned CPU/logging budget inside the already-heavy direct-API/staged-pool phase. Because the platform killed the isolate, `logCronRun()` could not catch the failure or insert an error row.

## Fix

Normalize optional `eth_call` gas values in `worker/src/lib/evm-rpc.ts` before sending JSON-RPC requests. `0x0F4240` now becomes `0xF4240`, matching JSON-RPC quantity encoding.

## Validation

- `npm test -- worker/src/lib/__tests__/evm-rpc.test.ts`
- `npm test -- worker/src/cron/__tests__/sync-dex-liquidity.test.ts worker/src/cron/dex-liquidity/__tests__/orchestrator-metadata.test.ts worker/src/cron/dex-liquidity/__tests__/fetch-fluid.test.ts`
- `cd worker && npx tsc --noEmit`

## Production Watch Plan

After deployment, monitor `cron_runs`, `cron_run_progress`, `cron_slot_executions`, and `wrangler tail` through two consecutive `sync-dex-liquidity` runs. Stop only after both runs finish without `error`, `skipped_locked`, stale progress, or slot hard termination.
