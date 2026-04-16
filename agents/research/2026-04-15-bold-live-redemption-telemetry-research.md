# BOLD Live Redemption Telemetry Research

Date: 2026-04-15

## Scope

Target only `bold-liquity`.

## Current State

- BOLD reserve sync was configured with `evm-branch-balances`, which reads the three Liquity v2 collateral branch ActivePool token balances and optional redemption fee.
- BOLD redemption backstop used `supply-full` with `documented-bound`, which is now `eventual-only` and excluded from Safety Score Liquidity / Exit uplift.
- A tracked generic `liquity-v2-branches` adapter is available. It extends branch-balance reads with same-run ActivePool BOLD debt and shutdown-status probes, then emits nested direct redemption telemetry.

## Primary Sources

- Liquity v2 redemption docs: `https://docs.liquity.org/v2-faq/redemptions-and-delegation`
- Liquity v2 repository / system summary: `https://github.com/liquity/bold`

Relevant source findings:

- BOLD redemptions are performed through `CollateralRegistry.redeemCollateral`.
- A redemption can route across several collateral branches.
- Branch routing is proportional to outside debt: `bold_debt_i - bold_in_SP_i`.
- At branch level, redeemed BOLD cancels Trove debt and removes the corresponding collateral.
- The repository documents the branch aggregate debt invariant around ActivePool aggregate debt, pending aggregate interest, batch fees, and DefaultPool BOLD debt.

## On-Chain Verification

Verified against public Ethereum RPC on 2026-04-15:

| Branch | ActivePool | `getBoldDebt()` selector | Debt readable | `hasBeenShutDown()` |
| --- | --- | --- | --- | --- |
| wstETH | `0x531a8f99c70d6a56a7cee02d6b4281650d7919a0` | `0x45507998` | yes | false |
| WETH | `0xeb5a8c825582965f1d84606e078620a84ab16afe` | `0x45507998` | yes | false |
| rETH | `0x9074d72cc82dad1e13e454755aa8f144c479532f` | `0x45507998` | yes | false |

The live debt values are volatile; the important implementation evidence is that each configured ActivePool supports the adapter's debt and shutdown selectors.

## Implementation Decision

Use `liquity-v2-branches` for BOLD instead of adding a BOLD-only adapter.

Rationale:

- The source is direct same-run on-chain state.
- BOLD is a branch-collateral Liquity v2 system; the adapter preserves reserve composition by branch while publishing direct redemption capacity from branch debt.
- The route should fail closed if the live branch-debt snapshot is missing or stale. No static full-supply fallback is used.

## Success Criteria

- `bold-liquity.liveReservesConfig.adapter = "liquity-v2-branches"` and version increments.
- `bold-liquity` redemption capacity uses `reserve-sync-metadata`.
- Fresh clean reserve metadata resolves to `sourceMode = "dynamic"`, `capacityConfidence = "live-direct"`, and `capacitySemantics = "immediate-bounded"`.
- Stale, missing, or degraded live metadata leaves the route visible but unrated for redemption capacity.

## Plan Review

### Review 1

Findings:

- Minor: The adapter count in `docs/live-reserves.md` needed to reflect the existing registered `liquity-v2-branches` adapter once BOLD uses it. Fixed by updating the coverage line and adapter table.
- Minor: The BOLD route docs needed a current-state source beyond narrative redemption docs. Fixed by adding the official Liquity v2 repository source.

Status: fixed; rerun review.

### Review 2

Findings: none.

Status: less than one minor issue; proceed.
