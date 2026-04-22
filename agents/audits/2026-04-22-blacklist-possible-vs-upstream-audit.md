# Blacklist `Possible` vs `Upstream` Audit — 2026-04-22

Goal: reserve `Possible` for direct holder-facing token/vault controls and move collateral-, reserve-, custody-, and parent-driven freeze risk to `Upstream`.

## Kept as `Possible`

- `usds-sky`
- `susds-sky`
- `stusds-sky`
- `busd0-usual`
- `dusd-standx`
- `usn-noon`
- `usdnr-nerona`
- `uty-xsy`
- `yusd-yieldfi`

Notes:

- Sky family kept as `Possible` per user clarification: the freeze path exists in-contract but is currently disabled and can be enabled by governance.
- `uty-xsy` is the only medium-confidence keep. Research found pause-related selectors and a live `paused()` surface on the proxy bytecode, but the implementation is not source-verified on SnowScan.

## Moved to `Upstream`

- `buck-bucket-protocol`
- `ceur-celo`
- `cusd-celo`
- `dai-makerdao`
- `dola-inverse-finance`
- `dusd-alto`
- `gho-aave`
- `hollar-hydrated`
- `isc-international-stable-currency`
- `lisusd-lista`
- `mim-abracadabra`
- `satusd-river`
- `sdai-sky`
- `susd-synthetix`
- `stkgho-umbrella-aave`
- `stcusd-cap`
- `usbd-bima`
- `usdaf-asymmetry`
- `usdd-tron-dao-reserve`
- `usdf-falcon`
- `usr-resolv`
- `uusd-youves`
- `yzusd-yuzu`

## Implementation Summary

- Shared blacklist resolution now treats any reserve/backing/custody/parent-asset freeze path as computed `inherited` / `Upstream`.
- Direct `Possible` cases are now curated explicitly in metadata via `canBeBlacklisted: "possible"`.
- Resulting active-registry bucket counts after the change:
  - `yes`: 118
  - `possible`: 9
  - `upstream`: 64
  - `no`: 12
