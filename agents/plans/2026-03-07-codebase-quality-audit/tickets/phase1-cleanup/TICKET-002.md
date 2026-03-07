---
title: "Remove dead code and unused exports from worker"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "medium"
done: false
---

## Goal

Remove confirmed dead code, unused parameters, duplicate metadata keys, and dead exports from `worker/src/` to reduce LOC without affecting features.

## Context

A codebase audit confirmed these items are never used. Each has been verified via import analysis across the entire `worker/src/` tree.

## Task

### 1. Remove unused function parameters in cron files

- **`worker/src/cron/sync-usds-status.ts`** (~line 49): Remove unused parameter `implAddress` from `probeFreeze` function. Update all call sites to not pass it.

- **`worker/src/cron/sync-blacklist.ts`** (~lines 423, 426, 513, 516): Remove unused parameters `trongridApiKey` and `tronLimiter` from helper function signatures. Update call sites to not pass them.

### 2. Remove duplicate metadata keys

- **`worker/src/cron/sync-stablecoins.ts`** (~lines 664-665): `depegErrors` and `depegErrorReasons` are both assigned the same array. Remove `depegErrorReasons` and keep only `depegErrors`.

- **`worker/src/cron/sync-mint-burn.ts`** (~lines 628-629): `rowsWritten` and `rowsInserted` both map to `rowsInserted`. Remove `rowsWritten` and keep only `rowsInserted`.

### 3. Inline trivial one-line wrappers in mint-burn cron

- **`worker/src/cron/sync-mint-burn.ts`** (~lines 84, 88): `getMaxScanRange` and `evmSafetyMarginBlocks` are constant-return wrappers. Replace with inline constants:
  ```ts
  const MAX_SCAN_RANGE = 2000;
  const EVM_SAFETY_MARGIN_BLOCKS = 5;
  ```
  Then replace all call sites `getMaxScanRange()` with `MAX_SCAN_RANGE` and `evmSafetyMarginBlocks()` with `EVM_SAFETY_MARGIN_BLOCKS`. Verify the actual constant values by reading the function bodies first.

### 4. Remove dead exports from worker/src/lib/

For each of these, remove the `export` keyword (de-export) if the symbol is used internally, or delete the declaration entirely if it has no internal uses either:

- **`worker/src/lib/constants.ts`** (~line 46): `TRON_BURN_ADDRESS` — never imported.
- **`worker/src/lib/chain-registry.ts`** (~line 12): `CHAIN_REGISTRY` — never imported.
- **`worker/src/lib/chain-rpcs.ts`** (~line 50): `buildChainRpcs` — never imported.
- **`worker/src/lib/cron-schedule.ts`** (~line 16): `CRON_JOB_DEFINITIONS` — never imported.
- **`worker/src/lib/db.ts`** (~line 163): `CronTimeoutError` — never imported.
- **`worker/src/lib/dex-constants.ts`** (~line 37): `USD_REFERENCE_SYMBOLS` — never imported.
- **`worker/src/lib/mint-burn-scoring.ts`** (~line 63): `GAUGE_BANDS` — never imported.
- **`worker/src/lib/mint-burn-health-config.ts`** (~lines 1, 12-14): `MINT_BURN_MAJOR_SYMBOLS`, `MINT_BURN_STALE_WARN_SEC`, `MINT_BURN_STALE_CRIT_SEC`, `MINT_BURN_ALERT_COOLDOWN_SEC` — none imported.
- **`worker/src/lib/status-reliability.ts`** (~lines 12, 14, 26): `STATUS_SCOPE`, `STATUS_HYSTERESIS`, `STATUS_DISCREPANCY_MAX_PROBE_AGE_SEC` — none imported.
- **`worker/src/lib/api-utils.ts`** (~line 17): `buildFreshnessMeta` — never imported.
- **`worker/src/lib/telegram.ts`** (~line 15): `buildTelegramMessage` — never imported.

### 5. Remove duplicate cache read in FX cron

- **`worker/src/cron/sync-fx-rates.ts`** (~lines 92, 182): The function re-reads the cache for RUB fallback at line ~182 when it was already loaded at ~92 into `prevRates`. Reuse `prevRates` instead of re-reading.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -c 'implAddress' worker/src/cron/sync-usds-status.ts` returns 0
- `grep -c 'depegErrorReasons' worker/src/cron/sync-stablecoins.ts` returns 0
- `grep -c 'rowsWritten' worker/src/cron/sync-mint-burn.ts` returns 0
- `grep -c 'getMaxScanRange\|evmSafetyMarginBlocks' worker/src/cron/sync-mint-burn.ts` returns 0
