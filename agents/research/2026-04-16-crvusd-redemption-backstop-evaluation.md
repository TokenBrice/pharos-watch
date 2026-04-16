# crvUSD Redemption Backstop Evaluation

**Date:** 2026-04-16
**Context:** Final review of the v3.98 redemption-backstop remediation flagged `crvusd-curve` as a potentially viable coverage addition via its PegKeeper mechanism. This note records the investigation outcome.

## Question

Can we model a redemption backstop for crvUSD given that PegKeepers mint/burn crvUSD into Curve pools?

## Finding — crvUSD has no holder-exercisable redemption rail

PegKeepers are Algorithmic Market Operations (AMO) controllers, not a holder redemption route. The mechanism is:

- **When crvUSD > $1:** PegKeeper mints uncollateralized crvUSD and deposits it into the paired Curve stableswap pool (USDC, USDT, PYUSD, or frxUSD) as single-sided liquidity. Increases supply → pushes price down.
- **When crvUSD < $1:** PegKeeper withdraws its own LP position and burns the crvUSD share. Decreases supply → supports price.
- **Profit to callers:** Anyone can call the public `update()` function; a portion of accumulated LP-token profit is returned as a caller incentive.

**A secondary-market holder who wants to exit crvUSD still has to sell into the Curve pool.** PegKeepers do not hold redeemable stablecoin reserves earmarked for holders — their stablecoin balance sits inside the Curve pool as LP. The trading counterparty on the pool swap is other pool LPs; the PegKeeper subsequently burns the crvUSD it withdraws, but that's an asymmetric balance-sheet operation, not a redemption payout.

## Why this does not fit any existing route family

| Family | Fit? | Why |
| --- | --- | --- |
| `stablecoin-redeem` | No | No direct 1:1 mint/redeem against USDC for holders. The only mint/burn authority rests with CDP owners (their own debt) or PegKeepers (internal AMO). |
| `psm-swap` | No | The PSM pattern requires a protocol-owned swap floor that a holder can exercise. PegKeeper-sourced liquidity in a Curve pool is secondary market DEX liquidity, not a PSM — it is already captured by the DEX liquidity score. |
| `collateral-redeem` | No | crvUSD has no Liquity-style redemption against the riskiest position. Only the CDP owner can repay their own debt to reclaim collateral. |
| `basket-redeem` | No | No proportional basket withdrawal exists. |
| `queue-redeem` | No | No queued redemption protocol exists. |
| `offchain-issuer` | No | crvUSD is not issuer-redeemable; it is a permissionless CDP. |

## Comparison with covered peers

- **DAI / USDS (`psm-swap`):** LitePSM lets any holder swap DAI ↔ USDC at par within the PSM's USDC reserves. *Direct holder swap.* That's why we model it.
- **GHO (`psm-swap` with live GSM capacity):** GSMs hold USDC/USDT reserves that holders can directly swap against.
- **LUSD / BOLD (`collateral-redeem`):** Any holder can call `redeemCollateral(...)` to exchange LUSD for ETH at the oracle-discounted price from the riskiest Trove. *Direct holder exercise against protocol contract.*
- **crvUSD:** PegKeepers are the closest analog to a GSM/PSM, but the holder's exit path is a Curve pool swap — there is no crvUSD-native redemption contract a holder can call to exchange crvUSD for USDC at par.

## Secondary-market liquidity is already captured

crvUSD's practical exit quality is dominated by the depth of the Curve crvUSD/USDC, crvUSD/USDT, crvUSD/PYUSD, and crvUSD/frxUSD pools. The DEX liquidity score ingests these pools' depth and reflects the PegKeeper-augmented liquidity automatically. Adding a synthetic "redemption" entry that references the same pool depth would double-count without adding new evidence.

## Verdict

**Do not add a redemption backstop config for `crvusd-curve`.** The plan's exclusion was correct. Revisit only if Curve governance ships an explicit holder-redeemable contract (e.g., a deliberate PSM-style rail or a protocol-level redemption function analogous to Liquity's).

## Open question for the future

If we later want to credit coins whose DEX-pool liquidity is partly protocol-supplied via AMO (crvUSD is the canonical example), that would be a **DEX liquidity score enrichment**, not a redemption backstop addition. Tracking AMO-deployed liquidity as a distinct sub-component of pool depth could be a valuable v7+ liquidity-score iteration, but it does not belong in the redemption backstop system.

## Sources

- [Curve Stablecoin: Overview (Curve docs)](https://docs.curve.finance/crvUSD/overview/)
- [Curve Finance Security Architecture, StableSwap, crvUSD, and Audit Risks — Zealynx](https://www.zealynx.io/blogs/curve-finance-core-mechanics)
- [Curve Finance's crvUSD: Unveiling Soft Liquidation — ts.finance blog](https://blog.ts.finance/curve-finances-crvusd-unveiling-soft-liquidation-for-stable-defi-growth/)
- [What Is Curve's Decentralized Stablecoin — CrvUSD (CoinMarketCap Academy)](https://coinmarketcap.com/academy/article/what-is-curve-s-decentralized-stablecoin-crvusd)
- [Curve Resources FAQ](https://resources.curve.finance/crvusd/faq/)
- [Galaxy Research — crvUSD: a novel stablecoin by Curve (whitepaper PDF)](https://assets.ctfassets.net/h62aj7eo1csj/5IZTgGnzlE6j2s85kQtnLw/04ec7c2e7a5eff1990e0677da680558b/GLXY_2023_Whitepaper_crvUSD_v01.pdf)
