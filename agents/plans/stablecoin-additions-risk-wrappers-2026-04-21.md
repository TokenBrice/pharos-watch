# Risk Wrapper Stablecoin Additions

Date: 2026-04-21

## Added

Active tracked entries added as first-class wrapper/NAV assets:

- `busd0-usual` — Bond USD0 / legacy USD0++
- `stusds-sky` — Sky stUSDS risk-capital token
- `stkgho-umbrella-aave` — Aave Umbrella slashable stkGHO
- `stcusd-cap` — Staked Cap USD
- `said-gaib` — GAIB sAID
- `msy-main-street` — Main Street Yield
- `yusd-yieldfi` — YieldFi yUSD
- `sbold-k3-capital` — K3 sBOLD

The following requested assets were already tracked and were not duplicated:

- `usdn-noble`
- `wsrusd-reservoir`
- `syrupusdc-maple`
- `syrupusdt-maple`
- `yousd-yield-optimizer`

`srUSD` was intentionally skipped because `wsrUSD` already represents the non-rebasing public wrapper over the same Reservoir savings exposure. Adding both would double count the same product without wrapper/base de-duplication rules.

## Runtime Coverage Decisions

- CoinGecko contract verification passed for `busd0-usual`, `stcusd-cap`, `said-gaib`, `msy-main-street`, `yusd-yieldfi`, and `sbold-k3-capital`.
- `stusds-sky` and `stkgho-umbrella-aave` use the existing on-chain supply fallback because no suitable CoinGecko market row exists.
- ERC-4626 live reserve coverage reuses `erc4626-single-asset` for `stUSDS`, `stcUSD`, `sAID`, `msY`, YieldFi `yUSD`, `sBOLD`, and Umbrella `stkGHO`.
- `bUSD0` keeps static curated reserves because it is a fixed-maturity ERC-20 bond, not an ERC-4626 vault.
- No redemption-backstop configs were added. Wrapper exits are either queue/cooldown/maturity-bound or inherit the base asset's redemption after unstaking; adding strong direct exit scores would overstate liquidity.
- Mint/burn coverage was added as extended transfer-based wrapper activity, separate from base stablecoin issuance.

## Yield Routing

- `stcUSD`, `sAID`, `msY`, and K3 `sBOLD` now own their yield rows directly.
- Base `cUSD`, `AID`, and `msUSD` no longer carry wrapper yield configs.
- Base `GHO` keeps the current `sGHO` savings source. The newly added `stkgho-umbrella-aave` is an intentional runtime-yield gap until reward APY telemetry is available.
- `stUSDS` uses the generic on-chain ERC-4626 reader.

