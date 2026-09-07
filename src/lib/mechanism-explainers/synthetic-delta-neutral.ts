import { ARCHETYPE_VISUALS, type ArchetypeContent } from "./types";

export const content: ArchetypeContent = {
  archetype: "synthetic-delta-neutral",
  headline: "Offsetting exposures, strategy-dependent carry",
  subtitle:
    "Delta neutrality can pair spot crypto with short perpetuals or pair borrowed native assets with matched staked exposure; the yield and failure modes depend on the variant.",
  lead: [
    "A synthetic delta-neutral stablecoin targets low directional exposure by offsetting economic legs. The familiar variant pairs volatile spot collateral with an equal short perpetual position. An on-chain borrow-and-stake variant instead supplies stablecoin collateral, borrows a native asset, and stakes that borrowed exposure so the asset owed and the asset held move together.",
    "The risk surface follows the implementation. Perp-short books depend on exchange custody, margin, and funding rates. Borrow-and-stake books depend on lending-market oracles, liquidation thresholds, borrow costs, staking yield, validator and liquid-staking contracts, and withdrawal liquidity. In either case the base token and the yield wrapper may be separate claims.",
  ],
  howItWorks: [
    {
      id: "fund-collateral-leg",
      title: "Fund the collateral leg",
      body: "A user or whitelisted minter deposits stablecoins or crypto. Perp-short systems may custody volatile spot assets with off-exchange settlement providers. Borrow-and-stake systems supply stablecoins to on-chain lending markets as collateral.",
    },
    {
      id: "offsetting-exposure",
      title: "Create the offsetting exposure",
      body: "A perp-short implementation opens a short derivative matching its volatile spot notional. A borrow-and-stake implementation borrows the native asset against stablecoin collateral and stakes the borrowed exposure. Both target matched economic legs, but only the first relies on perpetual funding and exchange margin.",
    },
    {
      id: "base-claim-route-carry",
      title: "Mint the base claim and route carry",
      body: "The protocol mints a stablecoin against the combined reserve strategy. Carry can come from perpetual funding, lending spreads, staking rewards, or several sources together. It may accrue to the base token, a separate staking wrapper such as sUSDe or sftUSD, a reserve fund, or the protocol treasury.",
    },
  ],
  riskProfile: [
    {
      headline: "Carry turns negative",
      body: "Perp-short books can lose money when funding inverts. Borrow-and-stake books can lose carry when native borrow costs exceed staking and lending yield. A strategy can remain directionally matched while its recurring financing cost erodes reserves.",
    },
    {
      headline: "Custody, oracle, and liquidation failure",
      body: "Perp-short books can lose access to a hedge when an exchange or settlement provider fails. Borrow-and-stake books can be liquidated when lending-market oracle prices or collateral thresholds move against the position, even if the stablecoin's own mint contract does not use an oracle.",
    },
    {
      headline: "Mint authority and operator privileges",
      body: "USR (Resolv Labs) was frozen on Pharos in April 2026 after an attacker exploited a single privileged EOA-minter on 22 March 2026: depositing ~100K USDC, receiving 50M USR, and iterating until ~80M unbacked USR existed for roughly $25M of extracted ETH. The delta-neutral collateral book itself worked as designed; an operator-level privilege failure with no oracle, no amount cap, and no max-mint guard did not. The synthetic mechanism is no defense against a minter-key compromise.",
    },
    {
      headline: "Redemption queue under stress",
      body: "Most synthetic-delta-neutral tokens enforce a multi-day redemption cooldown so the protocol can unwind hedges in order. Ethena's sUSDe runs on a 1-to-7-day cooldown that adjusts to the share of backing held in liquid stablecoins versus perpetual positions. In a panic this is precisely when holders want instant exit, and the cooldown is what forces the redemption queue to clear in the order positions can be sold rather than in the order claims arrive.",
    },
  ],
  representativeCoins: [
    {
      coinId: "usde-ethena",
      note: "The dominant synthetic-delta-neutral dollar. Most backing now sits in liquid stablecoins (mostly USDtb plus USDC/USDT/PYUSD in lending vaults), with a minority in BTC and ETH/LST hedged on Binance, Bybit, and OKX through off-exchange custody at Copper, Ceffu, and Coinbase. The Live Reserve panel shows the current mix.",
    },
    {
      coinId: "susde-ethena",
      note: "The staked wrapper around USDe. Holders receive funding-rate-derived yield; NAV appreciates against USDe rather than holding parity. Tracked separately on Pharos because unstaked USDe does not receive yield, and because the wrapper inherits its peg reference from USDe.",
    },
    {
      coinId: "usdf-falcon",
      note: "Overcollateralized synthetic dollar from Falcon Finance. Stablecoin deposits mint USDf 1:1; volatile-asset deposits mint at a dynamic overcollateralization ratio. The sUSDf wrapper routes a delta-neutral strategy book to depositors.",
    },
    {
      coinId: "ftusd-flying-tulip",
      note: "Borrow-and-stake example. Stablecoin collateral is lent on Ethereum and Sonic, native assets are borrowed and staked into matched exposure, ftUSD remains non-yielding, and sftUSD is the opt-in yield wrapper. Flying Tulip indexes the feed, while the underlying reserve balances are publicly verifiable on-chain.",
    },
    {
      coinId: "usr-resolv",
      note: "Frozen on Pharos since 27 April 2026 after the March 2026 EOA-minter exploit that produced ~80M unbacked USR. Listed here as the named recent failure example for this archetype; the live status on the detail page is frozen.",
    },
  ],
  variations: [
    {
      id: "on-chain-borrow-stake",
      title: "On-chain borrow and stake",
      body: "ftUSD supplies stablecoin collateral to lending markets, borrows native assets, and stakes the borrowed exposure. Carry comes from lending and staking yield net of borrow costs; the critical risks are venue oracles, liquidation thresholds, smart contracts, and withdrawal buffers rather than CEX funding rates.",
    },
    {
      id: "liquid-stable-heavy-basis-trade",
      title: "Liquid-stable-heavy basis trade",
      body: "Modern Ethena. The non-hedged portion of backing is held in liquid stablecoins rather than volatile spot, and only a minority of the book carries a delta-neutral structure. Reduces negative-funding sensitivity at the cost of importing the underlying stablecoins' risk through the lending vaults that hold them.",
    },
    {
      id: "pure-delta-neutral",
      title: "Pure delta-neutral",
      body: "Older or smaller implementations keep most backing in volatile spot plus a matched short. Yield is higher when funding is positive; negative-funding sensitivity is correspondingly higher, and exchange-venue concentration matters more because there is less stablecoin float to absorb a venue outage.",
    },
    {
      id: "nav-accruing-yield-variants",
      title: "Wrapped / NAV-accruing yield variants",
      body: "sUSDe, sUSDf, and similar staked variants are the actual yield-bearing claim. The underlying stablecoin tracks parity with the dollar; the wrapper is where the funding rate accumulates as NAV. Pharos treats the wrapper as a separate coin with peg reference to its parent.",
    },
  ],
  whatToWatch: [
    "DEWS on /depeg. Synthetic-delta-neutral tokens have full Depeg Early Warning System coverage; Pool Balance Drift, Liquidity Erosion, and Mint/Burn Flow signals fire early when an unwind begins.",
    "Live Reserve panel on /stablecoin/usde-ethena/ and equivalents. It shows the live mix of stablecoins, BTC, ETH/LST, and the CEX venue distribution of the short legs.",
    "Custody and venue posture on the report card. CEX-based strategies and fully on-chain lending strategies have different control, oracle, and failure domains.",
    "Redemption Backstop cooldown and holder eligibility. Most synthetic dollars enforce a multi-day cooldown; the backstop card surfaces the settlement delay and the verified-customer holder eligibility tier.",
    "Mint/Burn Bank Run Gauge on /flows. A sustained burn surge against zero mints during a market-down move is the on-chain footprint of an active redemption queue against the delta-neutral book.",
    "Wrapper peg reference. sUSDe inherits its peg reference from USDe, so a severe downside depeg on the parent propagates as output-asset impairment on the wrapper's Redemption Backstop card.",
  ],
  crossLinks: [
    {
      href: "/methodology/#pegscore-dews-methodology",
      label: "Depeg methodology and DEWS",
    },
    {
      href: "/methodology/#safety-scores-methodology",
      label: "Safety Score methodology (cex custody, exotic collateral)",
    },
    {
      href: "/methodology/#yield-intelligence-methodology",
      label: "Yield intelligence and funding-rate source risk",
    },
    {
      href: "/freezewatch/",
      label: "FreezeWatch: freeze and upstream intervention coverage",
    },
    {
      href: "/learn/mechanisms/cdp/",
      label: "CDP: crypto-collateralized designs that liquidate instead of hedge",
    },
    {
      href: "/learn/case-studies/usde-oracle-2025/",
      label: "Case study: USDe's Binance oracle print",
    },
    {
      href: "/learn/case-studies/usr-resolv-2026/",
      label: "Case study: Resolv USD's privileged-mint failure",
    },
    {
      href: "/cemetery/",
      label: "Cemetery: historical synthetic delta-neutral failures",
    },
  ],
  visuals: ARCHETYPE_VISUALS["synthetic-delta-neutral"],
  decommissioned: [
    {
      name: "UXD Stablecoin",
      date: "2024-08",
      obituary:
        "Solana-native delta-neutral dollar that survived the Mango Markets exploit but never attracted users. The team admitted the model \"isn't exciting enough for DeFi users\" and the DAO voted to sunset. Mechanism-correct, market-irrelevant.",
      coinId: "uxd-uxd-stablecoin-2024-08",
    },
    {
      name: "Elixir deUSD",
      date: "2025-11",
      obituary:
        "Synthetic dollar that lost 97% of value overnight when counterparty Stream Finance disclosed a $93M loss; Stream held roughly 65% of deUSD's collateral. The delta-neutral book itself worked; the choice of counterparty did not.",
      coinId: "deusd-elixir-deusd-2025-11",
    },
    {
      name: "Stream Finance xUSD",
      date: "2025-11",
      obituary:
        "Yield-bearing synthetic dollar that collapsed when an external fund manager disclosed a $93M loss. xUSD plunged from $1 to $0.26, freezing ~$160M in user deposits, and the same loss propagated to deUSD and Stables Labs USDX. A single off-chain counterparty took three coins down at once.",
      coinId: "xusd-stream-finance-xusd-2025-11",
    },
    {
      name: "Stables Labs USDX",
      date: "2025-11",
      obituary:
        "Synthetic USD backed by delta-neutral positions across exchanges. A Balancer V2 security flaw drained $1M; contagion from Stream Finance's $93M loss accelerated a full collapse to $0.35. Founder Flex Yang's wallet was later linked to addresses draining liquidity; the Discord was shut down.",
      coinId: "usdx-stables-labs-usdx-2025-11",
    },
  ],
};
