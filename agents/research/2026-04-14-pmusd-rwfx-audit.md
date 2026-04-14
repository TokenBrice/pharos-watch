# pmUSD RWf(x) Metadata Audit

Date: 2026-04-14

Scope: review of `pmusd-precious-metals`; production metadata changes were applied after user approval.

## Sources Checked

- RAAC RWf(x) docs: https://docs.raac.io/rw-fx
- RAAC RWf(x) deployments: https://docs.raac.io/deployment-rwfx/
- RAAC pmUSD app/collateral pages: https://pmusd.raac.io/ and https://pmusd.raac.io/collateral
- RAAC RWf(x) audits: https://docs.raac.io/audits-rwfx/
- I-ON Digital official site: https://iondigitalcorp.com/
- DefiLlama stablecoin page/API for asset `332`: https://defillama.com/stablecoin/pmusd and `https://stablecoins.llama.fi/stablecoin/332`
- CoinGecko PMUSD page/API: https://www.coingecko.com/en/coins/precious-metals-usd and `https://api.coingecko.com/api/v3/coins/precious-metals-usd`
- Etherscan token pages for pmUSD, TB, and ION.au:
  - https://etherscan.io/token/0xc0c17dd08263c16f6b64e772fb9b723bf1344ddf
  - https://etherscan.io/token/0x7a7f847fb60b0000e24cce07298dc73df8b8e56a
  - https://etherscan.io/token/0xd051c326c9aef673428e6f01eb65d2c52de95d30

## Verified Facts

- RAAC describes RWf(x) as a stablecoin minting system and an f(x) fork. Mainnet pmUSD deployment lists:
  - BaseToken: `0x7a7f847fb60b0000e24cce07298dc73df8b8e56a` (`TB Token`)
  - FractionalToken / pmUSD: `0xc0c17dd08263c16f6b64e772fb9b723bf1344ddf`
  - LeverageToken / xPM: `0x75939ceb9fba27a545fe27d1cbd228c29123687c`
  - Treasury: `0x51c4348af0c6066a2fd31bd968bc0c039fe27342`
- Public RPC checks:
  - pmUSD: `name = Precious Metals USD`, `symbol = pmUSD`, `decimals = 18`, `totalSupply = 100201203.622222222222222208`
  - TB: `name = TokenBlender`, `symbol = TB`, `decimals = 18`, `totalSupply = 26531.98`, Treasury TB balance = `26528.794649492399075576`
  - ION.au: `name = Ion Digital`, `symbol = ION.au`, `decimals = 18`, `totalSupply = 59549.0398`
- CoinGecko confirms `geckoId = precious-metals-usd`, Ethereum contract `0xc0c17dd08263c16f6b64e772fb9b723bf1344ddf`, 18 decimals, and categories including Stablecoins and RWA.
- DefiLlama asset `332` confirms `gecko_id = precious-metals-usd`, Ethereum-only, price source `defillama`, and description as an overcollateralized stablecoin backed by tokenized precious metals.
- RAAC docs say all Market actions are manager-only, managers are multisigs with RAAC as a necessary signatory, fees/incentives are disabled, and no liquidation/self-liquidation mechanisms are enabled.
- RAAC docs describe Chainlink as part of the gold price-feed path through Instruxi. The pmUSD app displays a Chainlink PoR panel and links the trigger/address to the ION.au token address, but I did not verify a separate Chainlink PoR feed address suitable for the existing `chainlink-por` adapter.
- I also probed `latestRoundData()` on the dashboard-linked ION.au address `0xd051c326c9aef673428e6f01eb65d2c52de95d30` and the TB base-token address; both reverted, so neither can be used directly as a Chainlink aggregator feed for `chainlink-por`.

## Implemented Changes

1. Rewrite `collateral` to name the actual on-chain base asset:
   `TokenBlender (TB) base token in the RAAC RWf(x) Treasury, backed by I-ON Digital's ION.au gold-backed digital security / in-situ gold claims`.

2. Rewrite `pegMechanism` away from generic CDP language:
   `RWf(x), an f(x) protocol fork, mints pmUSD as the fToken against TB / ION.au-linked collateral; xPM absorbs collateral-price volatility while pmUSD is configured with beta = 0 / stable fNAV; minting and system operations are manager-only via authorized silo multisigs`.

3. Change reserve naming from pure ION.au to:
   `TokenBlender (TB) base token backed by ION.au / in-situ gold claims`.

4. Change reserve risk from `medium` to `high`. It is not allocated vaulted physical gold like PAXG/XAUT; it is a tokenized security / balance-sheet / claim structure over in-situ gold reserves with legal, issuer, valuation, and extraction-enforcement risk.

5. Remove the current `liveReservesConfig` as suspect. The generic `single-asset` EVM adapter probes pmUSD totalSupply, not TB in the Treasury or ION.au reserve value. It should stay absent unless we implement a real RAAC/Instruxi/Chainlink source or a Treasury-TB balance adapter with defensible pricing.

6. Keep Ethereum contract metadata, `llamaId`, and `geckoId` as-is.

7. Keep `custodyModel: "institutional-unregulated"` unless we find a specific regulated custodian or license. I-ON is public/filing-visible, but I did not verify a custodian/regulator license matching the repo's `institutional-regulated` tier.

8. Do not add an `fxUSD`-style redemption backstop yet. RAAC's fork disables fees/incentives/liquidations and makes Market actions manager-only; the docs only describe pro-rata fToken redemption in an under-collateralized state, not normal permissionless collateral redemption.

9. Set `flags.rwa` to `true` so the detail-page RWA badge reflects this tokenized-RWA-backed structure. This is a display/tagging fix, not a scoring fix.
