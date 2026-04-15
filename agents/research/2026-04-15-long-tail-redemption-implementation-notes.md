# Long-Tail Redemption Adapter Implementation Notes

Date: 2026-04-15

## Implemented In This Pass

### Liquity V2 Branch Debt Adapter

Implemented `liquity-v2-branches` for:

- `bold-liquity`
- `feusd-felix`
- `usnd-nerite`
- `usdq-quill`

Confirmed sources:

- Felix docs publish feUSD collateral registry, ActivePool, collateral token, and read-function selectors.
- Nerite GitHub deployment artifacts publish Arbitrum `CollateralRegistry`, ActivePool, and token addresses.
- Quill docs publish Scroll `CollateralRegistry`, ActivePool, and collateral token addresses.

Adapter behavior:

- reserve slices: branch ActivePool collateral balances valued through DefiLlama token prices
- redemption capacity: aggregate ActivePool stablecoin debt
- fee: optional `getRedemptionRateWithDecay()` probe
- route status: optional branch shutdown probe
- freshness: same-run onchain

Live smoke results during implementation:

- `bold-liquity`: capacity about `$32.2M`, route open
- `feusd-felix`: capacity about `$15.1M`, route open
- `usnd-nerite`: capacity about `$1.31M`, route open
- `usdq-quill`: capacity about `$27k`, route degraded because the SCR branch reports shutdown

### Protocol/API Telemetry Upgrades

Implemented current telemetry for:

- `fxusd-f-x-protocol`: f(x) API debt balances as live proxy capacity
- `usdaf-asymmetry`: timestamped Asymmetry protocol supply as live direct capacity
- `jupusd-jupiter`: JupUSD public transparency API holdings plus oracle route status

Confirmed sources:

- f(x): `https://api.aladdin.club/api1/get_fx_tvl`
- Asymmetry: `https://app.asymmetry.finance/api/stats`
- JupUSD OpenAPI and data endpoints:
  - `https://api.jupusd.money/openapi.json`
  - `https://api.jupusd.money/api/data`
  - `https://api.jupusd.money/api/snapshots`
  - `https://api.jupusd.money/api/oracle`

Live smoke results during implementation:

- `fxusd-f-x-protocol`: about `$20.0M` proxy capacity from f(x) debt balances
- `usdaf-asymmetry`: about `$2.32M` direct capacity from protocol supply
- `jupusd-jupiter`: about `$75.1M` USDC/USDtb holdings, route open, whitelisted-primary eligibility

## Deferred After Research

Still blocked by missing public current-state mapping or larger ABI work:

- `meusd-mezo`: docs describe MUSD redemptions, but exact trove manager/system contracts were not confirmed in current public metadata.
- `nect-beraborrow`: tracked metadata has collateral categories only; official current branch contract mapping was not confirmed.
- `reusd-resupply`: contracts and redemption handler are public, but a safe adapter should model pair-level max redeemable debt and per-pair collateral returns; this is implementable but larger than a simple extension.
- `usbd-bima`: docs expose fee formula, but exact active branch contracts and debt selectors were not confirmed.
- `usdp-parallel`: docs expose `quoteRedemptionCurve`, `redeem`, collateral lists, pause/whitelist functions, and deployment addresses; a safe adapter still needs dynamic-array decoding and collateral balance/capacity semantics before scoring.
- `dusd-dtrinity`: contracts are public, but safe capacity requires mapping the current redeemer/collateral-vault set across deployed networks.
- `usda-avalon`: audit/docs mention conversion-vault functions, but the current public vault address/state mapping was not confirmed.
- `usx-solstice`: quote/status endpoint remains undiscovered and direct access is KYC/whitelist-gated.

These routes remain visible through their static redemption configuration, but the Safety Score path should not treat them as live current capacity until a protocol-specific adapter proves bounded route state.
