import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "stream-elixir-contagion-2025",
  eyebrow: "Composability cascade",
  title: "Stream Finance: loss broke three stablecoins",
  subtitle:
    "A ~$93M off-chain trading loss at Stream Finance detonated a ~$285M cross-protocol cascade, because xUSD had been re-hypothecated as leveraged collateral across lending markets that priced it at a hardcoded $1.",
  lead: [
    "Stream Finance's xUSD was a yield-bearing synthetic dollar in the delta-neutral mold: deposits were handed to an external manager who ran hedged positions and recycled the proceeds back into an on-chain token holders could lend, borrow against, and re-deposit. The marketing leaned on DeFi's usual promises — transparency, composability, programmable yield — while the engine that produced the yield sat off-chain, inside a single manager's trading book with no multisig, no published custody, and no real-time attestation of what backed each xUSD.",
    "That gap mattered because xUSD was not held; it was levered. Across Morpho, Euler, and Silo, third-party curators built isolated vaults where users supplied USDC against xUSD collateral, and the borrowed USDC was looped back into more xUSD — a recursive structure that inflated the token's apparent footprint far beyond its real backing. The lending markets pricing this collateral did not mark xUSD to its traded value. They read a hardcoded $1, which meant that when the real price fell, the liquidation machinery that should have unwound the loans never fired.",
    "On 10 October 2025 an ETH crash liquidated the manager's leveraged positions, and on 4 November Stream disclosed roughly $93M in losses and froze withdrawals. xUSD initially fell about 77% toward a 24-hour low near $0.26, stranding around $160M of deposits. The hole then propagated outward through the collateral graph: Elixir's deUSD, which had lent roughly 65% of its backing to Stream, collapsed near 98% to about $0.015 and was wound down, and Stables Labs' USDX broke below $0.60 days later. Researchers traced roughly $285M of interconnected debt across the affected vaults; lenders froze markets and roughly $1B exited DeFi yield within a week. None of the three coins recovered.",
  ],
  takeaways: [
    "A ~$93M off-chain trading loss at Stream Finance broke three stablecoins — xUSD, deUSD, and USDX — and exposed ~$285M of interconnected DeFi debt.",
    "xUSD was re-hypothecated as leveraged collateral across Morpho, Euler, and Silo, so its footprint far exceeded its real backing and a single failure radiated outward.",
    "Lending vaults priced xUSD at a hardcoded $1, so liquidations never fired during the depeg; borrowers drained real USDC while lenders kept worthless collateral.",
    "Elixir's deUSD had ~65% of its backing (~$68M) lent to Stream, making it a claim on Stream's solvency in disguise — composability turned one fund's loss into a market run.",
  ],
  archetype: "synthetic-delta-neutral",
  outcome: "died",
  eventDateLabel: "November 2025",
  eventWindow: {
    startISO: "2025-11-04",
    endISO: "2025-11-08",
    peakDeviationBps: -7700,
    lowPrice: 0.26,
  },
  cemeteryId: "xusd-stream-finance-xusd-2025-11",
  timeline: [
    {
      dateISO: "2025-10-10",
      headline: "ETH crash liquidates the off-chain trading book",
      body: "A sharp ETH drawdown liquidated the leveraged positions run by the external manager handling Stream's deposits. The damage stayed invisible on-chain: xUSD kept reading $1 in the lending markets that held it as collateral, so nothing in the visible system reflected the loss for weeks.",
      severity: "med",
    },
    {
      dateISO: "2025-11-04",
      headline: "Stream discloses ~$93M loss and halts withdrawals",
      body: "Stream Finance announced roughly $93M of losses attributed to an external fund manager, suspended all deposits and redemptions, and engaged outside counsel for an investigation. xUSD fell about 77% from $1 toward a 24-hour low near $0.26, freezing on the order of $160M of user deposits.",
      severity: "high",
      href: "https://www.coindesk.com/markets/2025/11/04/stream-finance-faces-usd93-million-loss-launches-legal-investigation",
    },
    {
      dateISO: "2025-11-04",
      headline: "Hardcoded $1 oracles block liquidation",
      body: "On Morpho, Euler, and Silo, vaults priced xUSD at a fixed $1 rather than its collapsing market price. Liquidations that should have unwound the leveraged loans never triggered; borrowers drained the supplied USDC instead, leaving lenders holding bad debt denominated in a near-worthless token.",
      severity: "high",
    },
    {
      dateISO: "2025-11-06",
      headline: "Elixir's deUSD collapses to ~$0.015",
      body: "Elixir had lent roughly 65% of deUSD's backing — about $68M — to Stream through private Morpho vaults. With that collateral impaired, deUSD broke from its peg and fell near 98% to about $0.015. Elixir halted minting and redemption and moved to wind the asset down, pledging 1:1 redemption for pre-event holders via a claims process.",
      severity: "high",
      href: "https://financefeeds.com/stream-finance-collapse-forces-elixir-to-retire-deusd-stablecoin/",
    },
    {
      dateISO: "2025-11-06",
      headline: "Stables Labs' USDX breaks below $0.60",
      body: "USDX, a delta-neutral synthetic dollar with collateral overlapping the Stream complex, depegged below $0.60 as redemptions spiked on BNB Chain; it later slid toward $0.30 and lower. Lista DAO and PancakeSwap flagged abnormal, unrepaid borrowing in vaults holding USDX and sUSDX as collateral.",
      severity: "high",
      href: "https://www.theblock.co/post/377917/synthetic-stablecoin-usdx-depegs-pancakeswap-lista",
    },
    {
      dateISO: "2025-11-08",
      headline: "~$285M of interconnected debt mapped; ~$1B exits DeFi yield",
      body: "Independent analysis tallied roughly $285M of direct debt exposure across the affected vaults — TelosC the largest single creditor near $124M, Elixir at $68M, MEV Capital around $25M, Re7 Labs in the tens of millions. Compound suspended several markets, Euler froze pools carrying tens of millions in bad debt, and roughly $1B of capital left DeFi yield products inside a week.",
      severity: "high",
      href: "https://blockeden.xyz/blog/2025/11/08/m-defi-contagion/",
    },
    {
      dateISO: "2025-12-08",
      headline: "Lawsuit alleges misappropriation",
      body: "A subsequent lawsuit filed by Stream's entity alleged that named parties tied to the external manager and trader used protocol assets to cover personal trading losses after the October liquidation, rather than a market loss alone. The legal record remains contested; Pharos records xUSD as deceased under counterparty failure and does not adjudicate the alleged intent.",
      severity: "med",
    },
  ],
  sections: [
    {
      heading: "What happened",
      paragraphs: [
        "Stream Finance issued xUSD as a yield-bearing synthetic dollar. Deposits funded positions run by an external fund manager, and the returns were packaged into an on-chain token that could be lent, borrowed against, and re-deposited across DeFi. The hedge and the trading book lived off-chain, behind a single manager, with no multisig over the capital, no published custody arrangement, and no live attestation tying circulating xUSD to verifiable backing.",
        "On 10 October 2025 a sharp ETH decline liquidated that off-chain book. The loss was real immediately but invisible on-chain for weeks, because the lending markets holding xUSD priced it at a fixed $1. On 4 November Stream disclosed roughly $93M of losses, halted withdrawals, and opened an investigation; xUSD fell about 77% toward a 24-hour low near $0.26 and stranded on the order of $160M of deposits. A separate Balancer exploit the same week added noise, but the trigger was the trading loss, not a smart-contract hack.",
        "The failure did not stay inside Stream. Because xUSD had been re-hypothecated as collateral across protocols, the hole propagated through the collateral graph: Elixir's deUSD, roughly 65% backed by loans to Stream, collapsed near 98% to about $0.015 and was wound down, and Stables Labs' USDX broke below $0.60 within days. Analysts mapped roughly $285M of interconnected debt; lenders froze markets and roughly $1B left DeFi yield products in a week.",
      ],
    },
    {
      heading: "The re-hypothecation map",
      paragraphs: [
        "The mechanism that turned one fund's loss into a market-wide event was leverage built on top of leverage. xUSD was not simply deposited and held; on Morpho, Euler, and Silo, curators created isolated vaults where users supplied real stablecoins — USDC, USDT, USD1 — against xUSD collateral, and the borrowed stablecoins were looped back into more xUSD positions. Each turn of the loop manufactured more apparent xUSD footprint without adding any real backing behind it.",
        "Elixir sat one layer further out. Its deUSD was a synthetic dollar in its own right, but roughly 65% of deUSD's backing — about $68M — had been lent to Stream through private Morpho vaults. So deUSD was, in effect, a claim on Stream's solvency wearing a different ticker. When Stream's backing evaporated, deUSD's reserves evaporated with it, and Stream reportedly held around 90% of the remaining deUSD supply, leaving it unable to settle. USDX, sharing collateral and venues with the same complex, formed a third node on the same web.",
        "This is the structural hazard composability carries when collateral is recursive and opaque. A token that is sound in isolation can become a transmission line: pledged into one market, borrowed against, re-pledged into the next, until a single off-chain failure radiates through every protocol that accepted it. The dependency was always visible in the collateral graph; what was missing was anyone pricing it as a dependency rather than as a dollar.",
      ],
    },
    {
      heading: "The hardcoded-oracle trap",
      paragraphs: [
        "A lending market's safety rests on one mechanism: when collateral falls below a threshold, it is liquidated and the loan is made whole before the position goes underwater. That mechanism only works if the market can see the collateral's real price. The vaults holding xUSD did not — many priced it at a hardcoded $1, a fixed peg assumption rather than a live feed reflecting traded value.",
        "Hardcoding $1 is sometimes defended as protection against transient depegs and liquidation cascades on assets expected to mean-revert. Here it did the opposite. As xUSD's market price collapsed, the protocols still valued it at par, so no liquidation ever triggered. Borrowers, seeing collateral the protocol would not mark down, drained the supplied USDC against it; lenders were left holding bad debt denominated in a token worth a fraction of the assumed price. The oracle had not protected the market — it had disabled its only defense and converted a depeg into a withdrawal of real assets.",
        "Pharos treats this as a downstream-pricing risk distinct from the issuer's own mechanism. A coin can fail at the issuer while integrators that price it at a static $1 turn that failure into systemic bad debt before the depeg is reflected in their books. The fragility is not in the stablecoin alone; it is in every market that agreed to pretend it could never move.",
      ],
    },
    {
      heading: "Contagion through curated lending markets",
      paragraphs: [
        "The contagion ran along the curator model. Permissionless lending venues like Morpho and Euler let third-party risk managers spin up isolated vaults and allocate depositor capital to high-yield strategies. That allocation decision — which collateral to accept, at what loan-to-value, against which price feed — is where the risk was concentrated, and several curators had routed large sums into Stream-linked exposure. TelosC carried the single largest position near $124M; MEV Capital and Re7 Labs held tens of millions each.",
        "When xUSD broke, the curated vaults could not contain it. Compound suspended several stablecoin markets, Euler froze pools carrying tens of millions in bad debt, and the freeze spread to any venue holding the linked collateral. Roughly $1B of capital left DeFi yield products within a week — not all of it directly exposed, but withdrawing on the recognition that exposure was hard to see and harder to exit. The episode drew comparisons to Terra, and prominent builders warned publicly that the curator economy was carrying Terra-shaped risk.",
        "The lesson generalizes past these three coins. A curator earning yield by accepting an opaque, re-hypothecated token as collateral is underwriting a counterparty most depositors never see and cannot assess. When that counterparty is a single off-chain manager, the vault's headline APY is compensation for a tail risk the depositor was never shown — and composability ensures the tail, when it arrives, is not contained to one vault.",
      ],
    },
    {
      heading: "Lessons",
      paragraphs: [
        "Composability is a risk multiplier, not just a feature. A token that is re-hypothecated as collateral across protocols becomes a transmission line: one issuer's failure radiates through every market that accepted it, and recursive loops inflate the footprint far beyond the real backing. Assess a synthetic dollar not only on its own mechanism but on how widely and how deeply it has been pledged, looped, and re-pledged elsewhere.",
        "A hardcoded $1 oracle disarms a lending market. Pricing collateral at a fixed peg instead of a live feed does not prevent a depeg — it prevents liquidation during one, letting borrowers drain real assets while lenders accumulate bad debt in a worthless token. Static pricing of a volatile-backed asset is a maximum-severity integration flaw regardless of how stable the asset has looked.",
        "Off-chain backing without on-chain proof is unverifiable trust. xUSD's yield came from a single manager's book with no multisig, no disclosed custody, and no live attestation; the loss existed for weeks before anyone on-chain could see it. When the engine of a yield-bearing dollar is off-chain and opaque, the headline rate is payment for an unobservable counterparty risk, and the curators and integrators accepting it are passing that risk to depositors who were never shown it.",
      ],
    },
  ],
  watchpoints: [
    "A yield-bearing synthetic dollar whose returns come from an off-chain manager with no multisig over capital, no disclosed custody, and no live attestation — losses can exist for weeks before they surface on-chain.",
    "Collateral that is recursively looped or re-hypothecated across lending venues, so a token's on-chain footprint vastly exceeds its real backing and a single failure radiates through every market that accepted it.",
    "Lending vaults that price a volatile-backed stablecoin at a hardcoded $1 rather than a live feed — liquidation never fires during a depeg, and borrowers drain real assets while lenders accrue bad debt.",
    "Curator-managed permissionless vaults concentrating depositor capital into one opaque counterparty, where the headline APY is compensation for a tail risk that is never disclosed to the depositor.",
  ],
  crossLinks: [
    {
      href: "/learn/mechanisms/synthetic-delta-neutral/",
      label: "Mechanism: synthetic delta-neutral dollars",
    },
    {
      href: "/learn/case-studies/usr-resolv-2026/",
      label: "Case study: USR, another synthetic-dollar failure",
    },
    {
      href: "/dependency-map/",
      label: "Dependency map",
    },
    {
      href: "/cemetery/",
      label: "Stablecoin cemetery",
    },
  ],
  sources: [
    {
      label: "CoinDesk — Stream Finance faces ~$93M loss, launches legal investigation",
      href: "https://www.coindesk.com/markets/2025/11/04/stream-finance-faces-usd93-million-loss-launches-legal-investigation",
    },
    {
      label: "BlockEden — Anatomy of a $285M DeFi contagion: the Stream Finance xUSD collapse",
      href: "https://blockeden.xyz/blog/2025/11/08/m-defi-contagion/",
    },
    {
      label: "FinanceFeeds — Stream Finance collapse forces Elixir to retire deUSD",
      href: "https://financefeeds.com/stream-finance-collapse-forces-elixir-to-retire-deusd-stablecoin/",
    },
    {
      label: "The Block — Synthetic stablecoin USDX depegs below $0.60",
      href: "https://www.theblock.co/post/377917/synthetic-stablecoin-usdx-depegs-pancakeswap-lista",
    },
  ],
  metaDescription:
    "Stream Finance's ~$93M loss broke xUSD, deUSD, and USDX in Nov 2025: re-hypothecated collateral and hardcoded $1 oracles drove a ~$285M cascade.",
  datePublished: "2026-06-15",
};
