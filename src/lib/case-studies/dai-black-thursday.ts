import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "dai-black-thursday",
  eyebrow: "CDP under stress",
  title: "Dai: Black Thursday and the PSM dependency",
  subtitle:
    "A crypto-collateralized stablecoin that survived two very different shocks (broken liquidations in 2020 and inherited reserve risk in 2023) and was reshaped by each.",
  lead: [
    "Dai is the canonical crypto-collateralized CDP stablecoin: dollars are minted against overcollateralized vaults, and the system stays solvent only if undercollateralized positions can be liquidated cleanly. Two episodes, three years apart, tested different parts of that promise. The first attacked the liquidation machinery itself. The second attacked the quality of the reserves Dai had quietly come to lean on.",
    "On 2020-03-12, Black Thursday, a roughly 50% intraday ETH crash collided with Ethereum gas congestion. Maker's price oracle stalled and then dropped more than 20% in a single update, mass-liquidating vaults at the same moment the network was too congested for liquidators to bid. Collateral auctions cleared at near-zero prices, leaving the protocol with millions in bad debt. Maker minted and auctioned MKR to recapitalize, and Dai then traded above peg for weeks as demand outran the contracted supply.",
    "On 2023-03-11 the threat came from the opposite direction. Dai had grown heavily backed by USDC routed through its Peg Stability Module. When Silicon Valley Bank's collapse stranded part of Circle's reserves and USDC depegged, that weakness passed straight through the PSM into Dai, which fell to roughly $0.85. The throughline across both events: a CDP's resilience is only as good as its liquidation infrastructure and the quality of whatever sits behind its peg-stability rails. Dai survived both, but neither left it unchanged.",
  ],
  takeaways: [
    "Two different shocks, one mechanism: Black Thursday 2020 attacked Dai's liquidation machinery (endogenous), while 2023 inherited USDC's SVB reserve risk through the PSM (transmitted).",
    "In 2020, gas congestion stalled the oracle and froze keeper bots, so collateral auctions cleared at near-zero bids: ~$8.3M of ETH lost across ~1,461 auctions, ~5.67M Dai undercollateralized.",
    "The MKR debt-auction backstop recapitalized the protocol without an emergency shutdown. Resilience came from a willingness to dilute MKR and restructure, not from a flawless original design.",
    "By 2023 roughly half of Dai's backing was USDC via the PSM, which inverted from stabilizer to transmission line and pulled Dai to ~$0.85; a nominally decentralized coin's largest risk was a bank.",
  ],
  primaryCoinId: "dai-makerdao",
  relatedCoins: [
    {
      coinId: "usdc-circle",
      note: "The PSM collateral whose 2023 SVB shock passed directly through to Dai's peg.",
    },
  ],
  archetype: "cdp",
  outcome: "survived",
  eventDateLabel: "March 2020 & March 2023",
  eventWindow: {
    startISO: "2020-03-12",
    endISO: "2023-03-13",
    peakDeviationBps: -1500,
    lowPrice: 0.85,
  },
  timeline: [
    {
      dateISO: "2020-03-12",
      headline: "Black Thursday: ETH crashes ~50%, oracles stall, liquidations fire",
      body: "A market-wide crash cut ETH roughly in half intraday. Ethereum gas spiked by an order of magnitude, freezing Maker's Medianizer oracle; when it finally updated, the reported price dropped over 20% at once and pushed a wave of vaults below their liquidation thresholds simultaneously.",
      severity: "high",
    },
    {
      dateISO: "2020-03-13",
      headline: "Collateral auctions clear at near-zero bids",
      body: "Most liquidator bots ran the same Maker-provided script that could not adapt to the gas spike, so almost no one competed in the auctions. Single bidders won roughly 62,800 ETH across about 1,461 auctions for essentially zero Dai, draining over $8M of collateral and leaving the system around 5.67M Dai undercollateralized.",
      severity: "high",
      href: "https://medium.com/@whiterabbit_hq/black-thursday-for-makerdao-8-32-million-was-liquidated-for-0-dai-36b83cac56b6",
    },
    {
      dateISO: "2020-03-19",
      headline: "MKR debt auction recapitalizes the protocol",
      body: "With the buffer exhausted, Maker triggered debt auctions: newly minted MKR sold for Dai, diluting MKR holders to cover the shortfall. Lots opened at 250 MKR per 50,000 Dai (~200 Dai/MKR); the auctions raised about 4.3M Dai across roughly 86 auctions, with Paradigm winning roughly 68% of the MKR sold.",
      severity: "med",
    },
    {
      dateISO: "2020-04-01",
      headline: "Dai trades above peg as demand spikes",
      body: "In the aftermath, contracting collateral and surging stablecoin demand pushed Dai persistently above $1. Maker's response, eventually adding the USDC-backed PSM, was designed to give the peg a one-to-one stablecoin release valve in both directions.",
      severity: "low",
    },
    {
      dateISO: "2023-03-11",
      headline: "USDC contagion reaches Dai through the PSM",
      body: "SVB's failure stranded part of Circle's USDC reserves; USDC depegged toward ~$0.87. With USDC making up roughly half of Dai's backing via the PSM, arbitrageurs dumped USDC into the module to mint Dai, exhausting capacity. Dai fell to about $0.85.",
      severity: "high",
      href: "https://www.circle.com/blog/an-update-on-usdc-and-silicon-valley-bank",
    },
    {
      dateISO: "2023-03-13",
      headline: "Federal backstop confirmed; both pegs recover",
      body: "Emergency Maker governance changes to cap and price the USDC PSM passed in hours but were gated by a 48-hour timelock and arrived too late to matter. The peg recovered once US authorities guaranteed SVB depositors. Maker initially voted to keep USDC as primary reserve, then diversified across stablecoins and real-world assets over the following year.",
      severity: "med",
    },
  ],
  sections: [
    {
      id: "black-thursday-2020",
      heading: "Black Thursday 2020",
      paragraphs: [
        "Maker's design assumes that when a vault falls below its minimum collateralization ratio, anyone can liquidate it: the collateral is auctioned for Dai, the debt is repaid, and a penalty is applied. The assumption that quietly underpins all of this is that the auction will attract competing bids. On 2020-03-12 that assumption broke.",
        "Two failures stacked on top of each other. First, the oracle: gas prices climbed so high that Maker's Medianizer could not afford to push fresh prices on-chain, so it stalled and then jumped down more than 20% in a single update, liquidating a large cohort of vaults at the same instant. Second, the auction: the keeper bots that liquidators relied on used a shared Maker reference script that had no logic for paying competitive gas, so they simply stopped bidding. Into that vacuum, a handful of participants who were willing to pay gas won auctions for zero Dai.",
        "The numbers most cited from the post-mortems are roughly $8.32M of ETH walking out the door across about 1,461 zero-bid auctions, and a resulting system shortfall around 5.67M Dai (some accounts tally net losses between roughly $4M and $6.65M, depending on timing and method). Vault owners whose collateral was sold for nothing lost everything; MKR holders later voted, controversially, against compensating them.",
      ],
    },
    {
      id: "how-the-cdp-design-recovered",
      heading: "How the CDP design recovered",
      paragraphs: [
        "Crucially, Maker did not need an emergency shutdown. The protocol already had a recapitalization path written into its mechanism: when collateral auctions fail to cover a vault's debt and the Dai buffer is empty, the system triggers a debt auction. Debt auctions mint new MKR and sell it for Dai, deliberately diluting MKR holders: the governance token absorbs losses that the stablecoin holders should not.",
        "Starting 2020-03-19, those auctions opened at 250 MKR per 50,000 Dai and raised about 4.3M Dai across roughly 86 auctions, with Paradigm taking roughly 68% of the MKR sold. The MKR-as-backstop design did exactly what it was meant to do: it kept Dai whole at the cost of MKR dilution.",
        "The structural fixes that followed were as important as the recapitalization. Maker overhauled its collateral-auction system (eventually replacing the old Flip English auctions with the instant-settling Clip Dutch-auction model), lengthened oracle update windows, added circuit breakers, and broadened the keeper ecosystem. The lesson was specific: a CDP can be perfectly overcollateralized on paper and still fail if its liquidation venue cannot function under congestion.",
      ],
    },
    {
      id: "2023-the-psm-and-the-usdc-dependency",
      heading: "2023: the PSM and the USDC dependency",
      paragraphs: [
        "By 2023 Dai looked very different. To hold the peg tightly and scale supply, Maker had introduced the Peg Stability Module, a contract that swaps Dai for USDC (and similar stablecoins) one-to-one. The PSM made the peg far more robust in normal conditions, but it also meant that a large share of Dai's backing was simply USDC. By the time SVB failed, USDC made up roughly half of the collateral behind circulating Dai, over $2 billion sitting in the PSM.",
        "When USDC depegged on 2023-03-11, the PSM inverted from a stabilizer into a transmission line. Arbitrageurs deposited cheap USDC to mint Dai and exit, draining PSM capacity; USDC deposits in the module nearly doubled while Dai supply ballooned. Dai followed USDC down to about $0.85. Maker governance approved emergency parameter changes (lowering the USDC PSM cap and raising its fee) within hours, but the changes sat behind a 48-hour timelock and only executed on 2023-03-13, after the federal backstop had already restored the peg.",
        "The episode crystallized the dependency-map view of Dai: a nominally decentralized, crypto-collateralized stablecoin whose actual single largest risk was a centralized issuer's banking relationship. Maker initially voted to keep USDC as its primary reserve, then spent the following year diversifying across multiple stablecoins and real-world assets, the same direction the current collateral mix reflects.",
      ],
    },
    {
      id: "lessons",
      heading: "Lessons",
      paragraphs: [
        "Two failure modes, one mechanism. In 2020 the danger was endogenous: the liquidation system that defines a CDP could not execute under congestion. In 2023 the danger was inherited: the PSM collateral chosen to stabilize the peg carried someone else's reserve risk. A CDP stablecoin has to be evaluated on both axes at once: can it liquidate, and what is actually behind the peg-stability rails.",
        "Survival is not the same as being unchanged. Dai recovered both times and never required an emergency shutdown, which is the strongest possible evidence the backstop design works. But each event rewrote the protocol: auction and oracle redesigns after 2020, reserve diversification and the eventual Sky restructuring after 2023. Resilience here came from a willingness to absorb losses (MKR dilution) and to restructure, not from the original design being flawless.",
      ],
    },
  ],
  dataWidgets: [
    {
      kind: "peg-deviation",
      coinId: "dai-makerdao",
      caption:
        "Dai's daily peg history on Pharos spans both events, Black Thursday (March 2020) and the March 2023 USDC/SVB pass-through. Daily snapshots understate the intraday lows the timeline cites.",
    },
  ],
  watchpoints: [
    "PSM collateral concentration: when a single counterparty's stablecoin dominates a CDP's backing, that issuer's banking and reserve risk becomes the CDP's risk. Watch the current collateral mix and the share routed through peg-stability swaps.",
    "Liquidation infrastructure under stress: keeper participation, oracle update cadence, and circuit breakers matter more than the headline collateralization ratio during fast crashes and gas spikes.",
    "Governance timelocks: emergency parameter changes that arrive after a 48-hour delay can be the right policy and still be useless mid-crisis. Note how fast the protocol can actually act.",
    "Backstop capacity: the MKR debt-auction mechanism only works while the governance token retains enough market value to recapitalize meaningful bad debt without runaway dilution.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/cdp/", label: "How CDP stablecoins work" },
    { href: "/stablecoin/dai-makerdao/", label: "Dai (DAI) live profile" },
    { href: "/depeg/usdc-2023-03-11/", label: "USDC depeg, March 2023" },
    { href: "/learn/case-studies/usdc-svb-2023/", label: "Case study: the USDC/SVB shock behind Dai's 2023 leg" },
    { href: "/dependency-map/", label: "Stablecoin dependency map" },
  ],
  sources: [
    {
      label: "Whiterabbit: Black Thursday for MakerDAO: $8.32M liquidated for 0 DAI",
      href: "https://medium.com/@whiterabbit_hq/black-thursday-for-makerdao-8-32-million-was-liquidated-for-0-dai-36b83cac56b6",
    },
    {
      label: "Modern Consensus: MakerDAO debt auction raises about 4.3M Dai",
      href: "https://modernconsensus.com/cryptocurrencies/makerdao-debt-auction-achieves-its-goal-late-bidders-reap-reward/",
    },
    {
      label: "Cointelegraph: Maker debt-crisis post-mortem recommends new safeguards",
      href: "https://cointelegraph.com/news/maker-debt-crisis-post-mortem-recommends-new-safeguards",
    },
    {
      label: "Circle: An update on USDC and Silicon Valley Bank",
      href: "https://www.circle.com/blog/an-update-on-usdc-and-silicon-valley-bank",
    },
    {
      label: "CoinDesk: MakerDAO votes to retain USDC as primary reserve after depeg",
      href: "https://www.coindesk.com/business/2023/03/23/stablecoin-issuer-makerdao-votes-to-retain-usdc-as-primary-reserve-even-after-depeg",
    },
    {
      label: "Federal Reserve: Lessons from the SVB failure and its impact on stablecoins",
      href: "https://www.federalreserve.gov/econres/notes/feds-notes/in-the-shadow-of-bank-run-lessons-from-the-silicon-valley-bank-failure-and-its-impact-on-stablecoins-20251217.html",
    },
  ],
  metaDescription:
    "How Dai survived Black Thursday 2020's failed collateral auctions and the 2023 USDC/SVB shock that passed through its PSM, and how each reshaped the CDP.",
  datePublished: "2026-05-23",
};
