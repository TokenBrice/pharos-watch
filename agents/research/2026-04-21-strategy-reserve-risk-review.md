# Strategy Reserve Risk Review

Date: 2026-04-21

Trigger: avUSD reserve-composition display showed the 0xPartners-managed reserve as `Medium Risk` even though the slice is not idle USDC. The user flagged the combination of delta-neutral strategy deployment plus non-top-tier custody/management risk.

## Assumptions

- Reserve risk should classify the economic reserve slice, not only the nominal base asset.
- Custody model remains a separate resilience sub-factor, but it does not excuse a strategy-deployed slice from carrying strategy risk.
- This pass should not silently re-tier every delta-neutral asset without source review. It should fix the directly reviewed avUSD case and clarify the tiering rule for future curation.

## Evidence Reviewed

- `shared/data/stablecoins/usd-minor.json` currently described avUSD as `USDC (1:1 backing, deployed into delta-neutral strategies via 0xPartners)` plus a `Loss-absorption reserve (0xPartners managed)`.
- Avant docs describe yield generation as a dynamic, actively managed multi-strategy framework across basis trades, lending-rate arbitrage, yield trading, lending markets, liquidity provisioning, private liquidity deals, and stablecoin peg arbitrage: https://docs.avantprotocol.com/yield-strategies-and-revenue/yield-generation
- Avant docs state individual strategies are actively managed by expert trading partners: https://docs.avantprotocol.com/yield-strategies-and-revenue/yield-generation
- Avant docs describe reserve funds as productive assets held in the relevant base token and representing diversified yield-generating, market-neutral assets: https://docs.avantprotocol.com/security/reserve-fund
- Avant docs describe reserve fund, planned governance backstop, and junior tranche as loss-protection layers rather than evidence that the underlying strategy reserve is cash-equivalent: https://docs.avantprotocol.com/security/risk-management

## Current Data Pattern

Comparable strategy reserve slices are not treated consistently:

| Pattern | Examples | Current handling before this pass |
| --- | --- | --- |
| Actively managed strategy book over deposited stablecoins | avUSD 0xPartners reserve | `medium` |
| CEX/off-exchange perp or basis books | Astherus, StandX, Hermetica, Unitas, Neutrl residual OTC | mostly `high` |
| Indirect USDe/sUSDe exposure | Honey/Alto/Re `high`; DOLA/ebUSD/Parallel `medium` | mixed |
| Older large delta-neutral books with transparent spot/perp slices | Ethena, Falcon, Resolv | `medium` |

## Decision

For v7.08, clarify the reserve-risk rule:

- `medium`: transparent spot or wrapped market exposure, where the slice is mainly asset exposure and custody/counterparty is already handled by the custody model.
- `high`: externally managed market-neutral, basis, perp, LP, private-deal, or custody-dependent strategy reserves unless a stronger granular source shows the slice is only an idle stablecoin or cash-equivalent buffer.

Applied now:

- `avusd-avant` main reserve slice: `medium` -> `high`
- `avusd-avant` loss-absorption reserve: `medium` -> `high`

Rationale: the evidence describes active strategy deployment and a managed productive reserve, not idle USDC. The existing `custodyModel: "institutional-unregulated"` remains appropriate and still applies separately in Resilience.

## Follow-Up Candidates

These need dedicated source review before broad re-tiering:

- `usde-ethena`: BTC/ETH delta-neutral sleeves are `medium`; custody model already penalizes CEX/off-exchange custody.
- `usdf-falcon`: BTC/ETH delta-neutral sleeves are `medium`; verify current live reserve structure and custody.
- `usr-resolv`: ETH/BTC/RLP strategy sleeves are `medium`; review Fireblocks Off-Exchange custody and RLP junior-risk treatment.
- `dola-inverse-finance`, `ebusd-ebisu`, `usdp-parallel`: USDe/sUSDe exposure is mixed across the registry (`medium` here, `high` in Honey/Alto/Re). Decide whether upstream USDe reserve slices should be canonical high, or whether dependency-risk inheritance is enough.

## Validation Target

- `npm run check:stablecoin-data`
- `npm run check:doc-sync`
- `npm test -- src/app/methodology/scoring-changelog/content.test.tsx src/lib/__tests__/report-cards.test.ts shared/lib/__tests__/reserve-risk-consistency.test.ts`
