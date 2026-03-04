# CCIP Mint/Burn Processing Tasklist (Streamlined Autonomous Runbook)

> Status: Execution-ready
> Date: March 4, 2026
> Scope: Configure and roll out CCIP bridge-burn classification for Ethereum Burn/Mint pool tokens already identified from Chainlink CCIP Directory.

## Why This Version Is Streamlined

Phase 1 (candidate inventory) and Phase 2 (evidence acquisition) are removed. They are already completed as of **2026-03-04 17:59:30 UTC** via registry scan output in `/tmp/ccip_mintburn_registry_scan.json`.

Execution now starts from a locked input set.

## Discovery Source (Critical Reference)

1. Main CCIP registry entrypoint: `https://docs.chain.link/ccip/directory/mainnet`.
2. This page was user-provided and unlocked deterministic discovery after earlier autonomous attempts did not locate an equivalent complete index.
3. Token eligibility decisions in this runbook are derived from this directory and its per-token pages.

## Locked Input Set

### Eligible (Burn/Mint on Ethereum, address-matched)

1. `2` `USDC`
   1. Token: `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`
   2. Pool: `0x03d19033ada17750d5bc2d8e325337d0748f9fef`
   3. Directory: `https://docs.chain.link/ccip/directory/mainnet/token/USDC`
2. `241` `USDO`
   1. Token: `0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe`
   2. Pool: `0x500d4882938020e939a5666c1b4200873da7efd3`
   3. Directory: `https://docs.chain.link/ccip/directory/mainnet/token/USDO`
3. `262` `USD1`
   1. Token: `0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d`
   2. Pool: `0x36a72ed0096b414521c45e3ddc9ed657d1d9c141`
   3. Directory: `https://docs.chain.link/ccip/directory/mainnet/token/USD1`
4. `271` `avUSD`
   1. Token: `0xf4c13d631450de6b12a19829e37c8e2826891dc4`
   2. Pool: `0x81b72171642fab457aa815c0b8412a22b63a6af8`
   3. Directory: `https://docs.chain.link/ccip/directory/mainnet/token/avUSD`

### Explicitly Excluded (Lock/Release on Ethereum)

1. `1` `USDT`
2. `118` `GHO`
3. `195` `USD0`
4. `246` `USDf`
5. `269` `BOLD`
6. `cg-syrupusdc` `syrupUSDC`
7. `cg-syrupusdt` `syrupUSDT`

### Notes

1. Address mismatches: none.
2. Not in registry: ignored for this rollout.
3. `226` `ZCHF` remains existing baseline CCIP handling.

## Autonomous Execution Defaults (No Human Decisions)

1. Ethereum CCIP signal constants for this rollout:
   1. `knownBridgeRouterAddresses`: `0x80226fc0ee2b096224eeac085bb9a8cba1146f7d`
   2. `bridgeSignalTopics`: `0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd` (`SendRequested`)
   3. `bridgeSignalSelectors`: `0x96f4e9f9` (`ccipSend`)
2. Apply the same router/topic/selector set to all 4 eligible coins; only pool address differs by coin.
3. Deterministic backfill order:
   1. canary: `241` (`USDO`)
   2. expansion: `2` (`USDC`), `262` (`USD1`), `271` (`avUSD`)
4. Deterministic `configKey` mapping for backfill:
   1. `2` (`USDC`): `ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`
   2. `241` (`USDO`): `ethereum-0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe`
   3. `262` (`USD1`): `ethereum-0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d`
   4. `271` (`avUSD`): `ethereum-0xf4c13d631450de6b12a19829e37c8e2826891dc4`
5. If any runtime prerequisite is missing (`X-Admin-Key`, deploy access, Alchemy key), execution stops with a logged blocker and no partial rollout.

## In Scope

1. `worker/src/lib/mint-burn-contracts.ts`
2. `worker/src/lib/mint-burn-bridge-classifier.ts`
3. `worker/src/cron/sync-mint-burn.ts`
4. `worker/src/api/backfill-mint-burn.ts`
5. `worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts`
6. `worker/src/cron/__tests__/sync-mint-burn.test.ts`
7. `worker/src/api/__tests__/backfill-mint-burn.test.ts`
8. `worker/src/api/__tests__/mint-burn-events.test.ts`
9. `docs/runbooks/mint-burn-ingestion.md`

## Out of Scope

1. Stargate/OFT support.
2. Re-running discovery for this rollout.
3. Non-Ethereum bridge models.

---

## Step 0: Preconditions and Baseline

### Tasks

1. Verify branch and create rollout log file:
   1. Branch: `feat/ccip-mint-burn-coverage`
   2. Log: `docs/research/ccip-mint-burn-rollout-log.md`
2. Run baseline checks:
   1. `(cd worker && npx tsc --noEmit)`
   2. targeted tests for current mint-burn path
3. Snapshot baseline metrics from API/DB:
   1. `burn_type` distribution for `USDC`, `USDO`, `USD1`, `avUSD`, `ZCHF`
   2. cron run health and error counts
4. Verify runtime prerequisites:
   1. deploy credentials available
   2. `ALCHEMY_API_KEY` available to worker runtime
   3. `X-Admin-Key` available for `POST /api/backfill-mint-burn`

### Deliverables

1. Preflight section in rollout log with timestamped command results.
2. Baseline metrics snapshot in rollout log.

### Validation

1. Typecheck passes.
2. Baseline tests pass.
3. Rollout log exists and includes preflight and baseline sections.

---

## Step 1: Config Implementation

### Tasks

1. Add `bridgeDetection` for new eligible coins only (`USDC`, `USDO`, `USD1`, `avUSD`) in `mint-burn-contracts.ts`.
2. Keep schema consistent with existing ZCHF pattern:
   1. `protocol: "ccip"`
   2. `knownBridgePoolAddresses`
   3. `knownBridgeRouterAddresses`
   4. `bridgeSignalTopics`
   5. `bridgeSignalSelectors`
3. Set router/topic/selector exactly to the constants from **Autonomous Execution Defaults**.
4. Set pool addresses from the locked input set only.
5. Do not add config for any excluded Lock/Release coin.
6. If shared CCIP constants reduce duplication, extract them with no behavior change.

### Deliverables

1. Config diff for the 4 eligible coins.
2. Matrix in rollout log: `stablecoinId -> pools/routers/topics/selectors`.

### Validation

1. `rg -n "stablecoinId: \"(2|241|262|271)\"|bridgeDetection" worker/src/lib/mint-burn-contracts.ts` shows expected entries.
2. No `bridgeDetection` added for excluded IDs (`1`, `118`, `195`, `246`, `269`, `cg-syrupusdc`, `cg-syrupusdt`).
3. All 4 new entries include router `0x80226fc0ee2b096224eeac085bb9a8cba1146f7d`, topic `0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd`, selector `0x96f4e9f9`.
4. `(cd worker && npx tsc --noEmit)` passes.

---

## Step 2: Test Expansion

### Tasks

1. Add classifier tests for each newly configured coin:
   1. known pool + CCIP signal => `bridge_burn`
   2. standard burn => `effective_burn`
   3. known pool without signal => `review_required`
   4. signal without known pool => `review_required`
2. Extend sync/backfill/API tests to verify:
   1. `burn_type` propagation
   2. aggregate counters
   3. API `burnType` filters

### Deliverables

1. Updated test files with per-coin coverage.
2. Test run output recorded in rollout log.

### Validation

1. `npm test -- worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts` passes.
2. `npm test -- worker/src/cron/__tests__/sync-mint-burn.test.ts` passes.
3. `npm test -- worker/src/api/__tests__/backfill-mint-burn.test.ts worker/src/api/__tests__/mint-burn-events.test.ts` passes.
4. Existing ZCHF behavior remains unchanged.

---

## Step 3: Staging Deploy and Backfill

### Tasks

1. Deploy worker to staging.
2. Run backfill for the 4 newly configured coins from each config `startBlock` to current head, using deterministic `configKey` values from **Autonomous Execution Defaults**.
3. Capture before/after counts by `burn_type` and flow totals.
4. Validate hourly bucket regeneration for touched ranges.

### Backfill Invocation Template

```bash
curl -X POST "https://api.pharos.watch/api/backfill-mint-burn" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Idempotency-Key: mb-ccip-<symbol>-<date>-<chunk>" \
  -d '{
    "configKey": "<ethereum-0x...>",
    "chunkSize": 50000,
    "maxChunks": 24
  }'
```

### Deliverables

1. Backfill execution log per coin:
   1. block range
   2. chunks processed
   3. rows reclassified
2. Before/after metrics table in rollout log.

### Validation

1. Each eligible coin has non-zero `bridge_burn` after backfill where activity exists.
2. No mint-side regressions.
3. API checks for each coin return expected bridge-burn events and corrected flows.

---

## Step 4: Production Canary and Expansion

### Tasks

1. Canary coin order: `241` (`USDO`) first non-ZCHF eligible by ascending ID.
2. Observe at least 6 cron runs.
3. If canary passes, enable remaining (`2`, `262`, `271`) and run incremental backfills.
4. Keep disable controls ready (`MINT_BURN_DISABLED_IDS`, `MINT_BURN_DISABLED_SYMBOLS`).

### Deliverables

1. Canary report with run-by-run metrics.
2. Full expansion report with per-coin status.

### Validation

1. Canary pass thresholds:
   1. no 3-run consecutive classifier-attributable errors
   2. `review_required / (bridge_burn + effective_burn) <= 5%` over 7d
   3. if denominator < 20 burns, require `review_required <= 2`
2. Full expansion has no sustained error/degraded trend for 24h.

---

## Step 5: Final Audit and Handoff

### Tasks

1. Update runbook with:
   1. covered CCIP Burn/Mint coins
   2. exclusion rule (Lock/Release on Ethereum is not processed)
   3. procedure for future refreshes from CCIP directory
2. Create final audit document with live config + evidence references.
3. Record residual risks and confirm ops handoff.

### Deliverables

1. `docs/research/ccip-mint-burn-final-audit.md`
2. Updated `docs/runbooks/mint-burn-ingestion.md`
3. Final signoff section in rollout log.

### Validation

1. Reproducible chain for each coin: `config -> classification -> API output`.
2. Runbook and code are consistent.
3. Handoff timestamp and owner are recorded.

---

## Command Pack

```bash
(cd worker && npx tsc --noEmit)

npm test -- \
  worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts \
  worker/src/cron/__tests__/sync-mint-burn.test.ts \
  worker/src/api/__tests__/backfill-mint-burn.test.ts \
  worker/src/api/__tests__/mint-burn-events.test.ts
```

```sql
SELECT symbol, burn_type, COUNT(*) AS n
FROM mint_burn_events
WHERE stablecoin_id = ?
GROUP BY symbol, burn_type
ORDER BY n DESC;
```

---

## Definition of Done

1. Eligible Burn/Mint coins (`2`, `241`, `262`, `271`) are configured and validated.
2. Excluded Lock/Release coins remain unconfigured for bridge-burn processing.
3. Historical and live data reflect corrected burn classification.
4. Tests, rollout logs, and runbook updates are complete.
