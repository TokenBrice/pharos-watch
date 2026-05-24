import { ARCHETYPE_VISUALS, type ArchetypeContent } from "./types";

export const content: ArchetypeContent = {
  archetype: "synthetic-delta-neutral",
  headline: "Hedged crypto collateral, funding-rate yield",
  subtitle:
    "Spot crypto plus an equal short perpetual position adds up to a roughly dollar-stable claim; yield comes from funding rates.",
  lead: [
    "A synthetic delta-neutral stablecoin is backed by crypto, but the crypto is paired with an equal-size short perpetual futures position so the net dollar value of the collateral does not move with the spot price — that combination is what 'delta-neutral' means here. When the perpetual's funding rate — the periodic payment exchanged between long and short holders to keep perp price close to spot — is positive, the short side receives funding, which is routed to token holders or a staked wrapper as yield.",
    "The risk surface is unusual. The stablecoin is exposed to perpetual-exchange custody, to funding-rate inversions (when funding turns negative, the protocol pays the longs), and to the off-exchange settlement provider holding the spot collateral. Pharos classifies this archetype as crypto-backed but with Custody Model = cex and exotic collateral quality, which is honest about where the actual exposure lives.",
  ],
  howItWorks: [
    {
      title: "Crypto deposit",
      body: "A user (typically a whitelisted minter) deposits crypto — a liquid stablecoin, ETH, an LST, or BTC. For Ethena most of the backing now sits in liquid stablecoins (USDtb, USDC, USDT), with a minority in BTC and ETH/LST. The spot leg is custodied off-exchange — held with a tri-party settlement provider like Copper, Ceffu, or Coinbase Prime rather than inside an exchange's hot wallet — so it survives an exchange failure.",
    },
    {
      title: "Long spot + short perp",
      body: "For the volatile portion of the book, the protocol opens a short perpetual position on a CEX (Binance, Bybit, OKX) equal in notional to the spot. Long spot + short perp is approximately constant in dollar terms regardless of where price moves. Funding flows between the two sides every funding interval; when funding is positive, the short side collects.",
    },
    {
      title: "Stablecoin minted (funding-rate yield)",
      body: "The protocol mints stablecoin against the combined position. Yield is distributed through a staking wrapper (sUSDe, sUSDf) or a NAV-accruing variant. Unstaked holders do not receive yield by default — the wrapper is the yield-bearing claim, and Pharos tracks the wrapper as a separate coin with its own peg reference.",
    },
  ],
  riskProfile: [
    {
      headline: "Negative funding-rate regime",
      body: "The model works while funding is positive. In a sustained bear market, funding can turn negative for weeks — the short side pays the long side and collateral bleeds. The reference episode is the post-FTX collapse window of November 2022 through January 2023, when aggregated ETH and BTC perp funding ran negative for roughly seven weeks. No live synthetic-delta-neutral stablecoin operated at meaningful scale through that window, so there is no large-cap empirical test of how a multi-billion-dollar book unwinds under a deeply negative funding regime.",
    },
    {
      headline: "Exchange custody and counterparty failure",
      body: "Even with off-exchange spot settlement, the hedge legs sit on a CEX. An FTX-tier exchange failure freezes the short, leaves the spot unhedged, and the asset is suddenly net long crypto until positions can be reopened elsewhere. Ethena spreads its hedges across Binance, Bybit, and OKX so that one venue going down does not break the whole book.",
    },
    {
      headline: "Mint authority and operator privileges",
      body: "USR (Resolv Labs) was frozen on Pharos in April 2026 after an attacker exploited a single privileged EOA-minter on 22 March 2026 — depositing ~100K USDC, receiving 50M USR, and iterating until ~80M unbacked USR existed for roughly $25M of extracted ETH. The delta-neutral collateral book itself worked as designed; an operator-level privilege failure with no oracle, no amount cap, and no max-mint guard did not. The synthetic mechanism is no defense against a minter-key compromise.",
    },
    {
      headline: "Redemption queue under stress",
      body: "Most synthetic-delta-neutral tokens enforce a multi-day redemption cooldown so the protocol can unwind hedges in order — Ethena's sUSDe runs on a 1-to-7-day cooldown that adjusts to the share of backing held in liquid stablecoins versus perpetual positions. In a panic this is precisely when holders want instant exit, and the cooldown is what forces the redemption queue to clear in the order positions can be sold rather than in the order claims arrive.",
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
      coinId: "usr-resolv",
      note: "Frozen on Pharos since 27 April 2026 after the March 2026 EOA-minter exploit that produced ~80M unbacked USR. Listed here as the named recent failure example for this archetype; the live status on the detail page is frozen.",
    },
  ],
  variations: [
    {
      title: "Liquid-stable-heavy basis trade",
      body: "Modern Ethena. The non-hedged portion of backing is held in liquid stablecoins rather than volatile spot, and only a minority of the book carries a delta-neutral structure. Reduces negative-funding sensitivity at the cost of importing the underlying stablecoins' risk through the lending vaults that hold them.",
    },
    {
      title: "Pure delta-neutral",
      body: "Older or smaller implementations keep most backing in volatile spot plus a matched short. Yield is higher when funding is positive; negative-funding sensitivity is correspondingly higher, and exchange-venue concentration matters more because there is less stablecoin float to absorb a venue outage.",
    },
    {
      title: "Wrapped / NAV-accruing yield variants",
      body: "sUSDe, sUSDf, and similar staked variants are the actual yield-bearing claim. The underlying stablecoin tracks parity with the dollar; the wrapper is where the funding rate accumulates as NAV. Pharos treats the wrapper as a separate coin with peg reference to its parent.",
    },
  ],
  whatToWatch: [
    "DEWS on /depeg — synthetic-delta-neutral tokens have full Depeg Early Warning System coverage; Pool Balance Drift, Liquidity Erosion, and Mint/Burn Flow signals fire early when an unwind begins.",
    "Live Reserve panel on /stablecoin/usde-ethena/ and equivalents — shows the live mix of stablecoins, BTC, ETH/LST, and the CEX venue distribution of the short legs.",
    "Resilience score → Custody Model = cex on the report card. By design, not a flaw; the report card scores cex custody as zero on the institutional-custody scale.",
    "Redemption Backstop cooldown and holder eligibility — most synthetic dollars enforce a multi-day cooldown; the backstop card surfaces the settlement delay and the verified-customer holder eligibility tier.",
    "Mint/Burn Bank Run Gauge on /flows — a sustained burn surge against zero mints during a market-down move is the on-chain footprint of an active redemption queue against the delta-neutral book.",
    "Wrapper peg reference — sUSDe inherits its peg reference from USDe, so a severe downside depeg on the parent propagates as output-asset impairment on the wrapper's Redemption Backstop card.",
  ],
  crossLinks: [
    {
      href: "/methodology/#depeg-methodology",
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
      label: "FreezeWatch — freeze and upstream intervention coverage",
    },
    {
      href: "/learn/mechanisms/cdp/",
      label: "CDP — crypto-collateralized designs that liquidate instead of hedge",
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
      label: "Cemetery — historical synthetic delta-neutral failures",
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
        "Synthetic dollar that lost 97% of value overnight when counterparty Stream Finance disclosed a $93M loss — Stream held roughly 65% of deUSD's collateral. The delta-neutral book itself worked; the choice of counterparty did not.",
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
