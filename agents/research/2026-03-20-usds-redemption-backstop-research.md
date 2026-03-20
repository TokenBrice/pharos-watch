# USDS Redemption Backstop Research

## Scope

Research the missing `usds-sky` Redemption Backstop entry and identify other tracked coins where the feed could be populated with existing route families. This note now also records the candidate rollout decisions that were implemented in `shared/lib/redemption-backstops.ts`.

## USDS Conclusion

- Sky's official token-routes docs expose a direct `USDS <-> USDC` path through `LitePSMWrapper-USDS-USDC`.
- The same docs state `USDS` and `DAI` share the same issuance source, and the `DAI <-> USDS` converter works at `1:1` with no liquidity restrictions.
- Sky's docs also state `DAI <-> USDC` conversions are handled by LitePSM.

Implementation implication:

- Model `usds-sky` as `psm-swap`.
- Reuse the same `supply-ratio` capacity assumption as `dai-makerdao` (`0.33`) because the USDS route ultimately shares the same LitePSM liquidity path.
- Treat the modeled fee as `0 bps`.
  - This is an inference from official docs: the `DAI <-> USDS` converter is unrestricted and the underlying `DAI <-> USDC` LitePSM leg is documented as fee-free.

Primary sources:

- `https://developers.skyeco.com/quick-start/protocol-token-routes/`
- `https://developers.skyeco.com/guides/peg-stability-modules/litepsm/`

## Implemented Expansion

### Source-checked route additions

| Asset | Why it looks modelable | Likely route family | Primary source(s) | Notes |
| --- | --- | --- | --- | --- |
| `lisusd-lista` | Lista docs describe a Peg Stability Module with `1:1` minting from `USDT` / `USDC`, `0%` mint fee, `2%` redeem fee, and a `500,000` lisUSD daily redemption limit | `psm-swap` | `https://docs.bsc.lista.org/introduction/collateral-debt-position-lisusd/lisusd/stable-pool-price-stability-module-psm` | Implemented with the existing `0.15` PSM reserve share from tracked metadata plus a note preserving the daily limit |
| `honey-berachain` | Berachain docs describe direct mint / redeem against whitelisted stablecoin collateral (`USDC`, `BYUSD`, `USDT0`, `USDe`), plus basket-mode behavior under depeg conditions and published redeem fees | `stablecoin-redeem` | `https://docs.berachain.com/general/tokens/honey` | Implemented as the normal single-stable redeem path, with Basket Mode captured in notes |
| `ousd-origin-protocol` | Origin docs say OUSD remains approximately `$1`, is currently `100%` backed by `USDC`, and OTokens can be redeemed for underlying collateral at any time | `stablecoin-redeem` | `https://docs.originprotocol.com/yield-bearing-tokens/origin-dollar-ousd`, `https://docs.originprotocol.com/yield-bearing-tokens/core-concepts/elastic-supply`, `https://docs.originprotocol.com/guides/integration-guide-for-exchanges` | Implemented with a `25 bps` redemption fee and a note that current collateral is USDC-only despite legacy basket semantics |
| `usdd-tron-dao-reserve` | USDD's current whitepaper says the PSM exchanges `USDT` / `USDC` / `TUSD` and `USDD` at a fixed `1:1` rate in both directions | `psm-swap` | `https://legacy.usdd.io/USDD-en.pdf` | Implemented with the tracked `16%` PSM reserve share as the immediate-capacity proxy |
| `eusd-electronic-usd` | Reserve docs state the `mint()` / `redeem()` functions are permissionless and DTFs are instantly exchangeable for a pro-rata share of underlying assets | `basket-redeem` | `https://docs.reserve.org/reserve-index/mint-redeem` | Implemented as deterministic basket redemption with conservative fee treatment because docs do not publish a separate redeem fee |

### Conservative offchain-issuer rollout

These candidates were added on the shared `offchain-issuer` base because the tracked metadata already documents direct issuer redemption and includes official issuer, reserve, or proof-of-reserve links:

- `usdcv-societe-generale-forge`
- `eurcv-societe-generale-forge`
- `aeur-anchored-coins`
- `eure-monerium`
- `usdr-stablr`
- `eurr-stablr`
- `europ-schuman`
- `eurau-allunity`
- `usdh-native-markets`
- `fidd-fidelity`
- `usdgo-osl`
- `wusd-worldwide`
- `sbc-brale`
- `usda-anzens`

Modeling decision:

- Use the shared `offchain-issuer` template (`issuer-api`, `same-day`, `rules-based-nav`, `supply-full`).
- Keep fee treatment conservative as `Public docs reviewed do not publish a numeric redemption fee.` unless the issuer already had a more specific override.
