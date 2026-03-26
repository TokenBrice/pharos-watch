# Non-USD Yield Coverage Expansion

Date: 2026-03-26

## Scope

Review the current Yield Intelligence coverage for non-USD and commodity-pegged assets, then identify:

1. what is already live
2. which additions are real quick wins
3. which ideas need new guardrails instead of just another allowlist entry

All market observations below were checked against live Pharos and DeFiLlama data on 2026-03-26.

## Current Live Coverage

Current non-USD rows in `/api/yield-rankings`:

| Peg | Coin | Source | APY | Source TVL |
| --- | --- | --- | ---: | ---: |
| EUR | EURCV | Morpho | 4.04% | $21.9M |
| EUR | EURE | Aave v3 | 3.05% | $4.86M |
| EUR | EURC | Aave v3 | 1.66% | $32.7M |
| CHF | ZCHF | Frankencoin Savings | 3.75% | $9.0M |
| CHF | VCHF | Morpho | 0.33% | $290K |
| SGD | XSGD | Morpho | 0.56% | $1.08M |
| MXN | CETES | Mexican government CETES bonds | -11.83% | n/a |

What this means:

- Non-USD coverage is no longer just EUR plus ZCHF. It already includes CHF, SGD, and MXN.
- EUR coverage is materially better than the repo metadata alone suggests, because auto-discovered lending rows already pick up `EURC`, `EURCV`, and `EURE`.
- Commodity coverage is still zero in the live rankings.

## EUR Reality Check

Top live EUR coins by current circulating amount on 2026-03-26:

| Coin | Circulating | Yield covered? | Notes |
| --- | ---: | --- | --- |
| EURC | 415.2M | yes | Aave v3 |
| EURCV | 77.6M | yes | Morpho |
| EURI | 58.9M | no | no live DeFiLlama yield pool found |
| AEUR | 53.7M | no | only tiny unsupported Harbor `haEUR` pool (~$12K TVL) |
| EURE | 30.0M | yes | Aave v3 on Gnosis |
| EURS | 8.38M | no | Aave v3 exists, but APY is only ~0.012%, below the repo's 0.1% floor |

Conclusion:

- The user's premise is directionally right, but not fully true as of 2026-03-26.
- The largest EUR assets with live yield are `EURC`, `EURCV`, and `EURE`.
- `EURI` and `AEUR` are still not real live additions today.
- `EURS` is technically discoverable, but the live APY is so close to zero that lowering the floor would make the product noisier, not better.

## Quick Wins Beyond EUR And CHF

### Already done

- `XSGD` is already live through a Base Morpho market (`STEAKXSGD`).
- `CETES` is already live through price-derived NAV tracking.

### The only clear next fiat candidate: `tGBP`

DeFiLlama currently shows a live single-asset `TGBP` market on Loopscale (Solana):

- protocol: `loopscale`
- APY: ~7.85%
- TVL: ~$208K
- pool id: `61a6a976-f70f-4f38-b4a4-a5d3fda6832c`

Why it is not a straight add:

- `loopscale` is not in `LENDING_PROTOCOL_ALLOWLIST`
- repo metadata for `tgbp-tokenised` only tracks Ethereum/Base/BSC/Polygon/Avalanche
- I could not directly verify a Solana deployment from the issuer site during this review because the public site is JS-only to the crawler, so the asset identity should be validated before wiring a Solana lending row to the tracked coin

Practical read:

- this is a plausible medium-effort win, not a same-hour config tweak
- if validated, it likely needs both a protocol review and a metadata update

### No comparable current wins found for the rest

I did not find meaningful live lending opportunities in the current DeFiLlama pool set for:

- `CADC`
- `AUDD`
- `BRZ`
- `MXNB`
- `JPYC`
- `GYEN`
- `IDRX`
- `PHT`
- `VGBP`
- `GBPm`

So beyond the already-covered `XSGD`, the non-EUR/CHF fiat opportunity set is thin right now.

## Commodity Expansion

### Current blocker in the repo

`worker/src/cron/yield-sync/resolve.ts` explicitly excludes `GOLD` and `SILVER` from auto-discovery.

That exclusion is justified today, because dropping it blindly would produce bad matches.

### Why a naive commodity rollout would be wrong

If the current address-first discovery logic is reused unchanged, both `PAXG` and `XAUT` would match the same Multipli pool:

- protocol: `multipli.fi`
- symbol: `RWAUSDI`
- TVL: ~$125.0M
- APY: ~3.89%
- pool metadata: `Institutional only`
- underlying tokens include both PAXG and XAUT

That is not a per-asset lending market for one commodity token. It is a shared collateral basket. Treating it as the best yield source for both assets would be a methodology mistake.

### What is actually usable in commodities

There are real commodity yield venues, but they mostly sit outside the stablecoin-only discovery assumptions:

#### XAUT

Live exact-address / exact-symbol markets include:

- `yo-protocol` `XAUT` on Ethereum, ~$3.16M TVL, ~11.38% APY
- `fusion-by-ipor` `XAUT` on Ethereum, ~$3.01M TVL, ~1.02% APY

There are also Aave / Morpho / Compound rows for `XAUT`, but the current APY is effectively `0`, so they are low-value coverage.

#### XAUm

Matrixdock has now launched XAUm on Sui and explicitly lists Navi as a lending partner. DeFiLlama shows:

- `navi-lending` `XAUM` on Sui, ~$2.14M TVL, ~2.45% APY

This is promising, but the repo currently only tracks Ethereum and BSC contracts for `xaum-matrixdock`, so a safe rollout would need the Sui deployment added to metadata first.

#### PAXG

I did not find a clean positive-yield single-asset allowlisted market for PAXG comparable to the XAUT and XAUm cases. The strongest address match is still the shared Multipli basket, which should not be used as direct PAXG yield coverage.

### Recommended commodity approach

If commodities are worth doing, use a separate discovery mode instead of lifting the gold/silver ban:

1. allow non-`stablecoin=true` pools for commodity assets only
2. require exact address or exact symbol matches
3. require exactly one underlying token for auto-selection
4. explicitly reject basket / multi-collateral matches like Multipli `RWAUSDI`
5. start with a curated short list rather than opening every commodity asset to generic discovery

Best first candidates if Pharos wants commodity yield:

- `XAUT`
- `XAUm`

Not a good first candidate:

- `PAXG`

## Recommended Priority Order

### 1. Keep the current EUR path as-is

The high-signal EUR assets are already live. There is no obvious missing top-tier EUR pool worth adding immediately.

### 2. Validate `tGBP` before adding anything

Questions to settle:

- is the Loopscale Solana asset definitively the same issuer-backed `tGBP` tracked by Pharos?
- do we want `loopscale` in the lending allowlist?
- do we want to track the Solana deployment in `shared/data/stablecoins/non-usd.json`?

If all three answers are yes, `tGBP` is the best fiat quick win outside EUR and CHF.

### 3. Treat commodity yield as a separate expansion wave

Do not ship commodities by deleting the current `GOLD` / `SILVER` exclusion.

Instead:

- add commodity-specific matching rules
- start with `XAUT` and `XAUm`
- leave `PAXG` out until there is a clean per-asset source

## Files To Touch If We Implement This

- `worker/src/cron/yield-sync/resolve.ts`
- `worker/src/cron/yield-config.ts`
- `shared/data/stablecoins/non-usd.json` if `tGBP` Solana metadata is confirmed
- `shared/data/stablecoins/commodity.json` if `XAUm` Sui metadata is confirmed
- `docs/yield-intelligence.md`
- `docs/yield-intelligence-timeline.md`
- `src/app/methodology/sections/monitoring-sections.tsx`

## Sources

- Pharos live stablecoins API: https://api.pharos.watch/api/stablecoins
- Pharos live yield rankings API: https://api.pharos.watch/api/yield-rankings
- Pharos live report cards API: https://api.pharos.watch/api/report-cards
- DeFiLlama yield pools API: https://yields.llama.fi/pools
- tGBP issuer site: https://www.tgbp.io/
- Loopscale docs: https://docs.loopscale.com/protocol-concepts/loopscale-vaults
- Matrixdock XAUm on Sui announcement: https://matrixdock.gitbook.io/matrixdock-docs/english/announcements/xaum-launches-on-sui
- Multipli rwaUSD system model: https://docs.multipli.fi/technical-architecture/rwausd-system-model
