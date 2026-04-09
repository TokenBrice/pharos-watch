# Live Reserve Incident Investigation — 2026-04-09

## Scope

Investigated the open circuit breakers shown for:

- `live-reserves:lista`
- `live-reserves:mim-abracadabra`
- `live-reserves:kau-kinesis`
- `live-reserves:ethena`
- `live-reserves:ylds-figure`
- `live-reserves:cash-phantom`
- `live-reserves:hyusd-hylo`
- `live-reserves:reservoir`

## What Was Verified

### Production health state

Public `GET https://api.pharos.watch/api/health` currently reports:

- `live-reserves:lista` open, `13` consecutive failures, last failure `2026-04-09T07:15:17Z`
- `live-reserves:mim-abracadabra` open, `13` consecutive failures, last failure `2026-04-09T07:15:23Z`
- `live-reserves:kau-kinesis` open, `13` consecutive failures, last failure `2026-04-09T07:15:37Z`
- `live-reserves:ethena` open, `3` consecutive failures, last failure `2026-04-09T09:15:23Z`, last success `2026-04-09T06:12:05Z`
- `live-reserves:ylds-figure` open, `15` consecutive failures, last failure `2026-04-09T09:15:30Z`
- `live-reserves:cash-phantom` open, `15` consecutive failures, last failure `2026-04-09T09:15:35Z`
- `live-reserves:hyusd-hylo` open, `15` consecutive failures, last failure `2026-04-09T09:15:41Z`
- `live-reserves:reservoir` open, `3` consecutive failures, last failure `2026-04-09T09:15:52Z`, last success `2026-04-09T06:12:09Z`

### Current `main` behavior

Current `main` locally succeeds for:

- `usde-ethena`
- `wsrusd-reservoir`
- `ylds-figure`
- `cash-phantom`
- `hyusd-hylo`

Adapter tests also pass locally:

- `curated-validated`
- `lista`
- `abracadabra`
- `ethena`
- `reservoir`

Command run:

```bash
npm test -- worker/src/cron/reserve-adapters/__tests__/curated-validated.test.ts \
  worker/src/cron/reserve-adapters/__tests__/lista.test.ts \
  worker/src/cron/reserve-adapters/__tests__/abracadabra.test.ts \
  worker/src/cron/reserve-adapters/__tests__/ethena.test.ts \
  worker/src/cron/reserve-adapters/__tests__/reservoir.test.ts
```

## Root Cause Summary

### 1. `main` was deployed; the misleading part was stale operational state

Direct D1 inspection showed recent `sync-live-reserves` runs at `133` configured coins, versus older runs at `136`. That matches the removal of these three live-reserve configs from current `main`:

- `lisusd-lista`
- `mim-abracadabra`
- `kau-kinesis`

Recent `cron_runs.metadata.coinsWithErrors` also no longer includes those three IDs. The worker is therefore running the new config, but stale `reserve_sync_state` rows and stale `circuit:live-reserves:*` cache keys were still surfacing in `/api/health`.

### 2. The active production failures are runtime fetch issues on the current config

Remote D1 `reserve_sync_state` rows for the currently live-enabled failing coins show:

- `ylds-figure`: `POST fetch failed for https://api.mainnet-beta.solana.com`
- `cash-phantom`: `POST fetch failed for https://api.mainnet-beta.solana.com`
- `hyusd-hylo`: `POST fetch failed for https://api.mainnet-beta.solana.com`
- `usde-ethena`: `JSON parse failed ... (text/html; charset=utf-8) ... body starts with: <!DOCTYPE html>`
- `wsrusd-reservoir`: `Fetch failed for https://app.reservoir.xyz/api/reserves/raw`

That is not the old invalid config problem. It is a current runtime reliability problem inside the Worker environment:

- single-endpoint Solana RPC dependency for three `onchain-solana` reserve probes
- upstream request-shape sensitivity for Ethena
- upstream network reachability / request-shape sensitivity for Reservoir

### 3. The removed `lista`, `mim-abracadabra`, and `kau-kinesis` incidents were historical, not active

These rows are still useful as incident history, but they are no longer part of the active 133-coin sync loop.

- `kau-kinesis` was correctly removed because its old `curated-validated` website config was never a valid machine-readable reserve probe
- `lista` still had zero balances on the configured branch targets when replayed locally
- `mim-abracadabra` still had reverting / null cauldron reads on the configured `totalCollateralShare()` path when replayed locally

## Remediation Applied

### Implemented in code

1. Filter stale removed live-reserve breaker keys out of `/api/health`.
2. Clean up stale `reserve_sync_state` rows and stale `circuit:live-reserves:*` cache keys at the end of each live-reserve sync run.
3. Add a secondary Solana public RPC fallback for `onchain-solana` supply probes:
   - primary: `https://api.mainnet-beta.solana.com`
   - fallback: `https://api.mainnet.solana.com`
4. Add browser-style request headers for:
   - Ethena
   - Reservoir

### Validation completed locally

- Focused tests: `68` passed
- `npm run lint`: passed
- `cd worker && npx tsc --noEmit`: passed

## Remaining Follow-Up

### Runtime monitoring after deploy

1. Watch the next `sync-live-reserves` run and confirm:
   - stale `kau-kinesis` / `lista` / `mim-abracadabra` breaker entries no longer appear in `/api/health`
   - `ylds-figure`, `cash-phantom`, and `hyusd-hylo` close if the Solana fallback works in production
   - `usde-ethena` and `wsrusd-reservoir` stop failing under the new request headers
2. If Ethena or Reservoir still fail, inspect the next `reserve_sync_state.last_error` and `reserve_sync_attempt_history.metadata.failureCategory` before changing parsing logic again.

### Longer-lived data/config work

3. Keep `lisusd-lista` out of live coverage until holder addresses are re-derived from actual protocol state and verified by direct `balanceOf` reads.
4. Keep `mim-abracadabra` out of live coverage until the cauldron read path is re-audited and every configured source has a non-reverting production-safe probe.
