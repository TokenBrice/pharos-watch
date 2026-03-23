# Redemption Backstop Semantics Follow-Up

Date: 2026-03-24

## Scope

Reviewed the harder non-top-100 follow-up assets that still looked like possible backlog candidates after the medium-confidence cleanup tranches:

- `hollar-hydrated`
- `crvusd-curve`
- `susd-synthetix`
- `mim-abracadabra`
- `usdu-usdu-finance`

Goal:

- determine whether any of these now have a credible primary redemption rail that fits the current Redemption Backstop route families and evidence bar

## Conclusions

### `hollar-hydrated`

Decision:

- remove the existing modeled route

Why:

- Hydration docs describe the HOLLAR Stability Module as **asymmetric**
- users can always buy HOLLAR from the facility near par
- but selling HOLLAR back is discretionary and market-condition-aware rather than a deterministic holder right

Implication:

- this is not a `psm-swap` rail
- keeping it modeled as a deterministic stablecoin exit would overstate redemption quality

Source checked:

- `https://docs.hydration.net/quick_start/hollar/`

### `crvusd-curve`

Decision:

- keep uncovered

Why:

- reserve and collateral telemetry are available
- but current public materials still do not establish a holder redemption rail comparable to issuer redemption, queue withdrawal, PSM swap, or Liquity-style direct collateral redemption
- the current public peg-defense story is PegKeepers and market/liquidation mechanics, not a clear direct holder redemption path

### `susd-synthetix`

Decision:

- keep uncovered

Why:

- current Synthetix materials still describe a transitional, treasury-and-vault-supported peg regime rather than a clean direct holder redemption rail
- V3 collateral visibility is not the blocker; redemption semantics are

### `mim-abracadabra`

Decision:

- keep uncovered

Why:

- per-cauldron collateral data exists
- but that does not automatically imply a holder-facing global redemption backstop comparable to the current collateral-redeem family
- current public materials are still much closer to CDP borrowing and liquidation semantics than explicit outstanding-supply redemption mechanics

### `usdu-usdu-finance`

Decision:

- keep uncovered

Why:

- current metadata and docs suggest convertibility via Curve pool liquidity and adapter-driven system mechanics
- that is not enough to treat the route as a protocol-native redemption backstop

## Net Result

- `0` new medium-confidence additions from the semantics-heavy tranche
- `1` misleading low-confidence route removed (`hollar-hydrated`)

This is the correct outcome under the current methodology. The remaining blocked assets need better route semantics, not more aggressive config work.
