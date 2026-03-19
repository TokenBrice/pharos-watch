# Redemption Fee Source Survey

## Scope

Reviewed every stablecoin currently configured in `shared/lib/redemption-backstops.ts` and grouped each modeled route by the strongest fee conclusion available from official docs, issuer pages, or official legal / governance materials.

## Outcome Summary

- `17` routes now have docs-backed fixed `feeBps`
- `15` routes have documented variable, conditional, or method-dependent fee text
- `14` routes have public docs reviewed but still do not publish a numeric redemption-fee schedule

## Fixed Or Fee-Free Routes

| Asset | Fee conclusion | Primary source checked |
| --- | --- | --- |
| `pyusd-paypal` | `0 bps`; Paxos says it does not charge a PYUSD redemption fee | `https://developer.paypal.com/dev-center/pyusd/`, `https://paxos.com/pyusd` |
| `usdp-paxos` | `0 bps`; Paxos says it does not charge a USDP redemption fee | `https://docs.paxos.com/guides/stablecoin/usdp`, `https://paxos.com/usdp` |
| `gusd-gemini` | `0 bps`; Gemini markets GUSD conversion / redemption as fee-free | `https://www.gemini.com/dollar` |
| `usdg-paxos` | `0 bps`; Paxos says it does not charge a USDG redemption fee | `https://globaldollar.com/`, `https://paxos.com/` |
| `euri-banking-circle` | `0 bps`; issuer materials describe fee-free redemption at par | `https://www.eurite.com/` |
| `usdq-quantoz` | `0 bps`; issuer says redemption is free of charge, bank fees may still apply | `https://www.quantoz.com/resources`, `https://www.quantoz.com/products/eurq-usdq` |
| `eurq-quantoz` | `0 bps`; issuer says redemption is free of charge, bank fees may still apply | `https://www.quantoz.com/resources`, `https://www.quantoz.com/products/eurq-usdq` |
| `usdo-openeden` | `10 bps` redemption fee | `https://docs.openeden.com/usdo/introduction` |
| `dai-makerdao` | `0 bps`; LitePSM docs say fees are not activated for DAI `<->` USDC | `https://docs.makerdao.com/`, `https://docs.sky.money/` |
| `dola-inverse-finance` | `20 bps` DOLA `->` USDS exit fee | `https://docs.inverse.finance/`, `https://www.inverse.finance/whitepaper` |
| `buck-bucket-protocol` | modeled route uses PSM OUT at `30 bps` | `https://docs.bucketprotocol.io/` |
| `dusd-dtrinity` | up to `50 bps` redemption fee | `https://docs.dtrinity.org/` |
| `feusd-felix` | `0 bps`; Felix docs describe redemption as fee-free | `https://usefelix.gitbook.io/docs`, `https://usefelix.gitbook.io/felix-docs` |
| `fxusd-f-x-protocol` | `50 bps` redemption fee | `https://fxprotocol.gitbook.io/fx-docs` |
| `usp-pikudao` | `20 bps` redemption fee | `https://docs.piku.co/piku` |
| `aznd-mu-digital` | `0 bps`; docs describe minting and redemption as fee-free | `https://docs.mudigital.net` |
| `usdu-unitas` | `0 bps` redemption fee | `https://docs.unitas.so/` |

## Documented Variable / Conditional Routes

| Asset | Fee conclusion | Primary source checked |
| --- | --- | --- |
| `usdt-tether` | `0.10%` with a `$1,000` minimum, so effective bps vary by size | `https://tether.to/`, `https://tether.to/en/transparency` |
| `usdc-circle` | Circle redemption is `1:1`; EEA burn fee is `0 bps`, broader fee schedules still vary by region / service | `https://developers.circle.com/stablecoins/what-is-usdc`, `https://www.circle.com/usdc` |
| `eurc-circle` | EEA burn fee is `0 bps`; broader fee schedules still vary by region / service | `https://developers.circle.com/stablecoins/what-is-eurc`, `https://www.circle.com/eurc` |
| `xusd-straitsx` | no platform conversion fee, but bank / network fees may apply | `https://www.straitsx.com/xusd`, `https://support.straitsx.com/` |
| `xsgd-straitsx` | no platform conversion fee, but bank / network fees may apply | `https://www.straitsx.com/xsgd`, `https://support.straitsx.com/` |
| `ausd-agora` | fees may apply, but public docs do not publish one fixed redemption rate | `https://docs.agora.finance/`, `https://www.agora.finance/` |
| `gho-aave` | GSM exit fee is governance-set; recent official materials show roughly `8-10 bps` on redemption | `https://aave.com/docs/ecosystem/gho`, `https://governance.aave.com/` |
| `bold-liquity` | Liquity-style formula: minimum `50 bps + baseRate`, decaying over time | `https://docs.liquity.org/` |
| `lusd-liquity` | Liquity-style formula: minimum `50 bps + baseRate`, decaying over time | `https://docs.liquity.org/` |
| `meusd-mezo` | `75 bps`, or `0 bps` when redeeming against your own debt | `https://mezo.org/docs/users/musd` |
| `nect-beraborrow` | Liquity-style formula: minimum `50 bps + baseRate`, decaying over time | `https://beraborrow.gitbook.io/docs` |
| `usdaf-asymmetry` | Liquity-style formula: minimum `50 bps + baseRate`, decaying over time | `https://docs.asymmetry.finance/` |
| `usnd-nerite` | Liquity-style formula: minimum `50 bps + baseRate`, decaying over time | `https://docs.nerite.org/` |
| `alusd-alchemix` | Transmuter docs describe `1:1` conversion but do not disclose a separate redemption fee | `https://v2-docs.alchemix.fi/alchemix-ecosystem/transmuter` |
| `avusd-avant` | docs say the redemption fee is shown in-app before confirmation, but no fixed public rate is published | `https://docs.avantprotocol.com/` |

## Public Docs Reviewed, No Numeric Fee Schedule Published

| Asset | Fee conclusion | Primary source checked |
| --- | --- | --- |
| `fdusd-first-digital` | redeemable `1:1`, but no public fee schedule surfaced | `https://www.firstdigitallabs.com/fdusd` |
| `rlusd-ripple` | terms say redeemable `1:1` less fees, but no public fee schedule surfaced | `https://ripple.com/legal/stablecoin/` |
| `usdx-hex-trust` | approved-party redemption exists, but no public fee schedule surfaced | `https://www.htdigitalassets.com/` |
| `usd1-world-liberty-financial` | no public redemption-fee schedule surfaced in reviewed materials | `https://worldlibertyfinancial.com/usd1`, `https://static.worldlibertyfinancial.com/docs/gold-paper.pdf` |
| `usdm-moneta` | redeemable `1:1`, but no public fee schedule surfaced | `https://moneta.global/` |
| `cusd-cap` | docs describe a fixed redemption fee, but the current rate is not published publicly | `https://docs.cap.app/` |
| `hollar-hydrated` | public docs reviewed did not surface a HOLLAR redemption-fee schedule | `https://docs.hydration.net/quick_start/hollar/` |
| `ebusd-ebisu` | public site / published materials reviewed did not surface a stable redemption-fee schedule | `https://ebisu.money/` |
| `iusd-infinifi` | public docs reviewed did not surface a numeric redemption-fee schedule | `https://docs.infinifi.xyz/` |
| `reusd-re-protocol` | public docs reviewed did not surface a numeric redemption-fee schedule | `https://docs.re.xyz/` |
| `cgusd-cygnus-finance` | docs describe `1:1` redemption if fees are excluded, but the fee itself is not published | `https://wiki.cygnus.finance/whitepaper/` |
| `uty-xsy` | public docs reviewed did not surface a numeric redemption-fee schedule | `https://xsy-1.gitbook.io/xsy-main` |
| `yzusd-yuzu` | public docs reviewed did not surface a numeric redemption-fee schedule | `https://yuzu-money.gitbook.io/yuzu-money` |
| `nusd-neutrl` | public docs reviewed did not surface a numeric redemption-fee schedule | `https://docs.neutrl.fi/` |

## Modeling Notes

- Fixed `feeBps` was used only when the docs supported a bounded basis-point fee or an explicit fee-free route.
- Flat-minimum schedules, region-dependent issuer schedules, and governance-set fee ranges were kept descriptive via `feeDescription`.
- Existing unsupported fixed assumptions were removed where the current public docs only support a variable or undisclosed conclusion.
