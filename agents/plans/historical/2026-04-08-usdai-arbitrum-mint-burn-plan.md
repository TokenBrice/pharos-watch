# USDai Arbitrum Mint/Burn Tracking Plan

Date: 2026-04-08

## Goal

Track real USDai issuance and redemption on Arbitrum while keeping bridge transfers and same-tx routing noise out of counted mint/burn flow.

## Research Summary

### Official protocol semantics

- USD.AI documents Arbitrum USDai at `0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF` and the Arbitrum USDai OAdapter at `0xffA10065Ce1d1C42FABc46e06B84Ed8FfEb4baE5`.
- The technical overview describes native user minting via `deposit(...)` and native burning via `withdraw(...)`.
- The same overview separately describes omnichain support as `burn()/mint()`-style LayerZero token transfers.

Sources:
- https://docs.usd.ai/technical-overview/contract-addresses
- https://docs.usd.ai/technical-protocol-overview

### Repo readiness

- Shared stablecoin metadata already contains the Arbitrum USDai deployment, so no metadata asset addition is required.
- The D1 schema already stores `chain_id` on `mint_burn_events`, `mint_burn_hourly`, and `block_timestamp_cache`, so no schema migration is required just to ingest Arbitrum rows.
- Alchemy chain support already includes Arbitrum in `worker/src/lib/chain-registry.ts`.

### Current repo blockers

- The mint/burn cron is hardcoded to Ethereum in `worker/src/cron/sync-mint-burn.ts`.
- The config runner skips any non-Ethereum config in `worker/src/cron/mint-burn/run-configs.ts`.
- Admin backfill is Ethereum-only in `worker/src/api/backfill-mint-burn.ts`.
- Public flows and events APIs are Ethereum-only in `worker/src/api/mint-burn-flows.ts`, `worker/src/api/mint-burn-events.ts`, and `worker/src/api/mint-burn-flows-shared.ts`.
- Coverage math assumes one Ethereum head and Ethereum block-time windows.
- Status reconciliation compares mint/burn only against Ethereum `chainCirculating` deltas in `worker/src/lib/status/derived-data.ts`.
- Tests and docs explicitly assert Ethereum-only scope.

## On-Chain Findings

### Confirmed native Arbitrum burn

- Tx `0x00f0d2fb4243fa7310f486582e14870ae01bc9ce70acda220257627d0b0b13ae`
- Direct call to the USDai token contract
- Arbiscan labels it as `Withdraw 99,995.3 USDai for 99,995.3 PYUSD on USD.AI`
- This emits a zero-address USDai burn and is economic redemption, not bridging

### Confirmed native Arbitrum mint

- Tx `0x62340a372b3f60b46e42b00ebccb871e89aa329270d7632519a22ee2da0334b3`
- Arbiscan labels it as `Deposit 7.41 USDC for 7.49 PT-USDai-18JUN2026 on Pendle`
- The receipt contains a USDai zero-address mint without LayerZero endpoint or OAdapter signals
- This means real USDai minting can happen inside composed DeFi transactions, not only through direct top-level calls to the USDai contract

### Confirmed Arbitrum bridge burns

- Tx `0xcf70cd0f5f9adc72fb0323410383b9f7a5d8d0a0c3920560a2bb61aac5011b85`
- `to = 0xffA10065Ce1d1C42FABc46e06B84Ed8FfEb4baE5`
- selector `0xc7c7f5b3`
- Receipt includes LayerZero `PacketSent`
- This is bridge noise and should stay excluded

### Confirmed Arbitrum bridge mints

- Tx `0x93248c1cc8a293ae96fcbe038f5e0eaf7dae639c07e5c76aa81e334f51f67b9a`
- `to = 0x31CAe3B7fB82d847621859fb1585353c5720660D` (LayerZero executor)
- Receipt includes USDai mint, USDai OAdapter log, and LayerZero `PacketDelivered`
- This is a destination-side bridge mint

- Tx `0x475e9c9b1dd0412cb5b192945f2b7c7d87c78d01c41a6aaef7fa53d2f04122da`
- Arbiscan labels it as a call by `LayerZero: Executor`
- Receipt includes USDai mint and LayerZero endpoint delivery signals, but no USDai OAdapter log
- By inspection of the current classifier, this pattern would likely be missed because LayerZero mint classification currently requires the tx to touch the known bridge contract address set

### Confirmed atomic roundtrip / route noise

- Tx `0xe78651aac00bce089f6ecbb00b8c455b06de4ac05cc04fb886a48271c0fb1dfe`
- Arbiscan labels it as a Jumper cross-chain deposit
- The receipt contains both USDai mint and USDai burn in the same transaction
- This belongs in `atomic_roundtrip`, not counted economic flow

## Recommended Product Scope

Recommend making Arbitrum the canonical mint/burn source for USDai rather than trying to treat Ethereum USDai as the primary signal.

Reasoning:

- USDai is Arbitrum-native.
- Confirmed economic issuance/redemption happens on Arbitrum.
- Ethereum USDai zero-address activity is dominated by omnichain bridge behavior.
- Tracking the canonical issuance chain is easier to explain methodologically than presenting bridge-heavy secondary-chain activity as if it were primary supply creation/redemption.

Operational caveat:

- If the USDai config is moved from Ethereum to Arbitrum, old USDai Ethereum rows must not remain implicitly eligible in public queries.
- That can be handled either by a targeted USDai cleanup/rebuild or by making API aggregation honor the currently active `(stablecoin_id, chain_id)` config set instead of scanning historical rows blindly.

## Implementation Plan

### 1. Harden bridge detection first

- Add real Arbitrum classifier fixtures for:
  - native withdraw burn
  - native composed mint
  - OAdapter bridge burn
  - bridge mint with OAdapter + `PacketDelivered`
  - bridge mint via LayerZero executor without OAdapter log
  - atomic roundtrip bridge/routing tx
- Extend `MintBurnTxContext` and LayerZero classification logic as needed so executor-side destination mints are not left as `standard`.
- Do this before adding Arbitrum ingestion, otherwise the tracker will import bridge mints as economic flow.

Likely files:
- `worker/src/lib/mint-burn-bridge-classifier.ts`
- `worker/src/lib/mint-burn-pipeline/classification.ts`
- `worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts`

### 2. Add Arbitrum USDai config as the tracked issuance source

- Add the reviewed Arbitrum USDai config in `worker/src/lib/mint-burn-contracts.ts`.
- Reuse the existing shared stablecoin metadata deployment.
- Carry over LayerZero bridge detection, but after the classifier hardening above.
- Pick a reviewed `startBlock` from validated Arbitrum economic activity, not a blanket floor if avoidable.

Decision point:

- Preferred: replace the current Ethereum USDai config with Arbitrum.
- Acceptable fallback: temporarily keep both during validation, but only if public queries become config-aware enough to avoid stale or double-counted interpretation.

### 3. Generalize ingestion from one chain to configured chains

- Group enabled configs by `chain.chainId`.
- Build one Alchemy URL and one chain head per chain.
- Keep timestamp caches per chain.
- Carry per-chain head metadata through cron completion so API coverage math can use the right head for each config.
- Remove the `non-ethereum-config` skip path.

Likely files:
- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/cron/mint-burn/run-configs.ts`
- `worker/src/cron/mint-burn/run-completion.ts`

### 4. Make admin backfill chain-aware

- Let backfill select any configured chain, not just Ethereum.
- Build the RPC URL from the selected config chain.
- Keep chunk size logic chain-agnostic unless RPC behavior forces a per-chain override.

Likely files:
- `worker/src/api/backfill-mint-burn.ts`

### 5. Make API aggregation follow configured chain reality

- Stop hardcoding Ethereum in aggregate and per-coin queries.
- Coverage should be calculated from each config's own chain head, not a single Ethereum head.
- The API scope surface must stop claiming `Ethereum-only` once USDai Arbitrum is live.
- Event API should accept explicit `chain=arbitrum` and reject only truly unsupported chains.

Likely files:
- `worker/src/api/mint-burn-flows.ts`
- `worker/src/api/mint-burn-events.ts`
- `worker/src/api/mint-burn-flows-shared.ts`

### 6. Rework status reconciliation to use the tracked chain

- Reconciliation for a coin should compare flow against `chainCirculating[config.chain.chainId]`, not always `chainCirculating.ethereum`.
- For USDai that means comparing against Arbitrum supply deltas.
- If future coins move off Ethereum, the same logic will already work.

Likely files:
- `worker/src/lib/status/derived-data.ts`

### 7. Clean up tests and public methodology surfaces

- Remove the Ethereum-only config test expectation.
- Update docs, API reference, methodology copy, and timeline/changelog entries.
- Update any UI copy that currently states the feature is Ethereum-only.

Likely files:
- `worker/src/lib/__tests__/mint-burn-contracts.test.ts`
- `docs/mint-burn-flows.md`
- `docs/api-reference.md`
- `docs/mint-burn-flows-timeline.md`
- `shared/lib/mint-burn-flow-version.ts`
- `src/app/flows/page.tsx`
- `src/lib/methodology-context.ts`

### 8. Rollout sequence

1. Ship classifier hardening and chain-aware ingestion.
2. Backfill USDai Arbitrum from the reviewed start block.
3. Remove or isolate stale USDai Ethereum rows if USDai is moved to Arbitrum as its canonical config.
4. Recompute affected USDai hourly buckets.
5. Validate the public USDai event feed against known Arbitrum tx samples.

## Validation Checklist For The Future Implementation

- `npm run typecheck`
- `cd worker && npx tsc --noEmit`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run check:doc-sync`
- `npm run test:merge-gate`

## Open Questions

- Whether the safest rollout is immediate canonical-chain switch for USDai or a short shadow period with both configs active internally.
- Whether the LayerZero executor/local-compose mint family can be recognized generically enough to avoid token-specific special casing.
- Whether public aggregate `/flows` should become "configured issuance chains" immediately, or whether only per-coin surfaces should widen first.

## Recommendation

Proceed, but do it in two gates:

- Gate 1: classifier hardening with real Arbitrum fixtures
- Gate 2: Arbitrum USDai ingestion plus API/status/doc widening

The main technical risk is no longer "can we parse Arbitrum USDai mints and burns?" That part is straightforward. The real risk is letting destination-side LayerZero mint receipts leak through as `standard` flow once Arbitrum ingestion is enabled.
