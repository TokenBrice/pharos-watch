# LUSD Live Redemption Telemetry Plan

Date: 2026-04-15

## Scope

Target only `lusd-liquity`.

## Assumptions

- The existing `liquity-v1` live reserve adapter is the right source for LUSD.
- Liquity v1 `TroveManager.getEntireSystemDebt()` is a direct same-run on-chain upper bound for protocol-redemption capacity, denominated in 18-decimal LUSD debt.
- If the live on-chain snapshot is unavailable, the redemption backstop should fail closed to `missing-capacity` rather than falling back to a full-supply immediate-capacity estimate.
- LUSD reserve composition remains a one-slice `ETH` view; this work only adds redemption-capacity telemetry and switches the backstop to consume it.

## Success Criteria

1. `liquity-v1` snapshots include nested `metadata.redemption.capacityUsd`, `capacityKind = "live-direct-bounded"`, and `freshnessKind = "same-run-onchain"`.
2. The adapter definition explicitly permits direct capacity telemetry.
3. `lusd-liquity` redemption backstop capacity resolves from fresh reserve-sync metadata.
4. Missing or stale live metadata leaves LUSD visible but unrated for redemption capacity.
5. Docs and methodology version metadata describe the LUSD-specific dynamic-capacity promotion.
6. Focused adapter, redemption source, and stablecoin data tests pass.

## Implementation Steps

1. Extend `worker/src/cron/reserve-adapters/liquity-v1.ts`.
   - Convert `totalDebtRaw` to USD capacity using 18 decimals.
   - Emit nested redemption telemetry with route status `open`, holder eligibility `any-holder`, and the existing live fee when available.
   - Keep existing raw collateral/debt metadata for auditability.

2. Update adapter metadata.
   - Change `shared/lib/live-reserve-adapters-definitions.ts` for `liquity-v1` from capacity `none` to `direct`.

3. Update LUSD redemption config.
   - Change `lusd-liquity` from `supply-full` documented capacity to `reserve-sync-metadata`.
   - Keep existing docs and formula fee model.
   - Do not add a fallback ratio.

4. Add tests.
   - Adapter test asserts capacity telemetry and fee telemetry are both emitted.
   - Redemption source test asserts LUSD consumes fresh `liquity-v1` metadata as `live-direct` immediate-bounded capacity.
   - Config test asserts LUSD uses `reserve-sync-metadata`.

5. Update docs/version metadata.
   - Bump redemption-backstop methodology from `v3.9` to `v3.91`.
   - Update `docs/redemption-backstops.md` and `docs/live-reserves.md`.
   - Leave Safety Score version unchanged because the Safety Score eligibility rule is unchanged; only LUSD evidence has been upgraded.

## Verification

- `npm test -- worker/src/cron/reserve-adapters/__tests__/liquity-v1.test.ts worker/src/lib/__tests__/redemption-backstop-sources.test.ts shared/lib/__tests__/redemption-backstops.test.ts`
- `npm run check:stablecoin-data`
- `npm run check:doc-sync`
- `cd worker && npx tsc --noEmit`

## Plan Review Loop

### Review 1

Findings:

- Minor: The plan initially did not state fallback behavior. Fixed by explicitly requiring no fallback ratio and fail-closed `missing-capacity`.
- Minor: The plan initially omitted docs/version scope. Fixed by adding a `v3.91` redemption-backstop metadata update and docs targets.

Status: fixed; rerun review.

### Review 2

Findings: none.

Status: less than one minor issue; proceed.
