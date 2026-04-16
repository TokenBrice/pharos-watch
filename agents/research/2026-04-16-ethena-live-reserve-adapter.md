# Ethena Live Reserve Adapter Check

Date: 2026-04-16

## Findings

Production `reserve_sync_attempt_history` showed hourly `usde-ethena` failures from 2026-04-16 00:11:58 UTC through 08:11:08 UTC:

- failure category: `parse-failure`
- configured URL: `https://app.ethena.fi/api/positions/current/collateral`
- response content type in Worker: `text/html; charset=utf-8`
- body began with the Ethena dashboard HTML shell

The same endpoint returned valid JSON from local checks during investigation. The current payload still matches the adapter contract:

- 77 collateral rows
- known assets only: `Liquid Cash`, `BTC`, `ETH`, `WBETH`, `mETH`, `stETH`, `BNB`, `XRP`, `SOL`, `HYPE`, `LsETH`
- summed `usdAmount` exactly equals `totalBackingAssetsInUsd`
- material rows share one source timestamp

The alternate same-provider URL `https://ethena.fi/api/positions/current/collateral` also returns the same JSON payload.

## Change Made

Added `https://ethena.fi/api/positions/current/collateral` as a fallback input for USDe's Ethena live reserve config, keeping the existing `app.ethena.fi` URL as primary.

Updated the Ethena adapter so redemption telemetry records the actual URL that produced the snapshot instead of always hardcoding the primary URL.

## Verification

```bash
npm test -- worker/src/cron/reserve-adapters/__tests__/ethena.test.ts
npm run check:stablecoin-data
npm run typecheck
```

All passed.
