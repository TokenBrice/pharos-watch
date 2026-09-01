import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "lusd-flight-to-safety-2023",
  eyebrow: "Flight to safety",
  title: "LUSD: the peg that held during the SVB weekend",
  subtitle:
    "While USDC, Dai, and FRAX broke below $0.90 in March 2023, LUSD, backed only by on-chain ETH and an arbitrage-enforced redemption floor, traded at a premium and repegged in under 15 hours.",
  lead: [
    "On the weekend of March 10-13, 2023, the largest fiat-backed dollar stablecoins lost their pegs. USDC fell to roughly $0.87 after Circle disclosed $3.3 billion of reserves trapped at the failed Silicon Valley Bank; Dai inherited the shock through its USDC-heavy Peg Stability Module and traded near $0.85; FRAX, which valued its USDC collateral leg at a hardcoded dollar, slid to about $0.88. The common thread was a redemption path that ran through commercial banks closed for the weekend.",
    "LUSD shared none of that exposure. Liquity's stablecoin is minted only against on-chain ETH at a 110% minimum collateral ratio, holds no cash and no Treasuries, and its contracts are immutable and governance-free. With no banking leg to impair, LUSD did not break downward. It did the opposite. Capital fleeing the impaired fiat-backed cluster bid LUSD to a premium, with prints as high as roughly $1.05-1.08 on some venues over the weekend. Its only downside dislocation was a brief dip to about $0.985, an order of magnitude shallower than its peers' lows.",
    "The recovery was as asymmetric as the move. By Liquity's own Q1 accounting, LUSD returned to peg in under 15 hours, while USDC, FRAX, and Dai took over 35 hours on average. The episode is the direct mirror of the USDC case study: resilience by subtraction, where the absence of off-chain dependencies, not any active defense, is what kept the peg intact. That resilience carries its own costs, which the design surfaced again in 2025.",
  ],
  primaryCoinId: "lusd-liquity",
  relatedCoins: [
    {
      coinId: "usdc-circle",
      note: "The mirror image of this study. USDC fell to roughly $0.87 on March 11, 2023 when about $3.3 billion of Circle's cash reserves were trapped at the failed Silicon Valley Bank, a banking-channel shock that LUSD, holding no cash leg, was structurally immune to. USDC repegged within about two days once a federal deposit backstop was announced.",
    },
    {
      coinId: "dai-makerdao",
      note: "Dai held roughly half of its collateral in USDC through MakerDAO's Peg Stability Module, so it inherited the depeg almost one-for-one, falling to about $0.85 as the PSM turned from a stabilizer into an exit ramp. Where Dai's peg leaned on centralized collateral it could not throttle in time, LUSD's leaned only on ETH it never had to defend.",
    },
    {
      coinId: "frax-frax",
      note: "FRAX was partially backed by USDC and valued each collateral asset at a hardcoded $1 for redemption, so an impaired USDC leg dragged it to roughly $0.88. The contrast is the cleanest in the cluster: FRAX assumed its backing was worth a dollar, while LUSD let arbitrageurs redeem LUSD for a dollar of ETH at the contract level, an enforced floor rather than an assumed one.",
    },
  ],
  archetype: "cdp",
  outcome: "survived",
  eventDateLabel: "March 2023",
  eventWindow: {
    startISO: "2023-03-10",
    endISO: "2023-03-13",
    peakDeviationBps: 800,
    lowPrice: 0.985,
  },
  timeline: [
    {
      dateISO: "2020-03-12",
      headline: "The failure Liquity was built against",
      body: "On Black Thursday, a market-wide crash collapsed ETH prices faster than MakerDAO's liquidation engine could clear undercollateralized vaults, letting some be seized for zero-bid Dai. Liquity was designed from the start to make that failure mode impossible, with instant Stability Pool liquidations and a hard 110% floor.",
      severity: "low",
      href: "https://www.liquity.org/blog/the-premium-of-resiliency",
    },
    {
      dateISO: "2021-04-05",
      headline: "Liquity launches: ETH-only, immutable, 110% MCR",
      body: "Liquity went live on Ethereum mainnet, issuing LUSD as a 0%-interest loan against ETH at a minimum 110% collateral ratio. The contracts have no admin keys, no governance, and no upgrade path; stability rests on a Stability Pool, debt redistribution, and direct LUSD-for-ETH redemption at face value, with redemptions enabled after the initial two-week bootstrap period.",
      severity: "low",
      href: "https://www.liquity.org/blog/liquity-goes-live-on-ethereum-mainnet",
    },
    {
      dateISO: "2023-03-10",
      headline: "SVB enters receivership; the fiat-backed cluster cracks",
      body: "Silicon Valley Bank was placed into FDIC receivership on Friday, March 10. Circle disclosed about $3.3 billion of USDC reserves held at the bank, and over the weekend USDC, Dai, and FRAX all broke below par as their banking-dependent redemption paths stalled.",
      severity: "med",
    },
    {
      dateISO: "2023-03-11",
      headline: "LUSD bids to a premium as fiat coins break",
      body: "Capital fleeing the impaired stablecoins rotated into assets with no banking exposure. LUSD traded to a premium of roughly $1.05-1.08 on some venues, and Aave borrow rates for LUSD spiked toward 75% as users pulled it to exit USDC- and Dai-heavy positions. Its only downside move was a brief dip to about $0.985.",
      severity: "med",
      href: "https://www.liquity.org/blog/liquity-q1-report",
    },
    {
      dateISO: "2023-03-13",
      headline: "Repeg in under 15 hours; supply surges",
      body: "LUSD returned to peg in under 15 hours, against an average of over 35 hours for USDC, FRAX, and Dai. The flight to safety left a durable mark: LUSD supply grew about 50% over Q1 2023 (from roughly $178.5M to $267.8M) while Dai's contracted about 8% over the same period.",
      severity: "low",
      href: "https://www.liquity.org/blog/liquity-q1-report",
    },
  ],
  sections: [
    {
      heading: "The failure it was built against",
      paragraphs: [
        "Liquity was conceived as a response to two distinct failures. The first was Black Thursday in March 2020, when a market-wide crash overwhelmed MakerDAO's liquidation auctions and let some vaults be seized for zero-bid Dai. The episode demonstrated that a CDP system is only as safe as the speed of its liquidations. The second, broader failure was dependency itself: every dollar stablecoin that leaned on off-chain reserves inherited the fragility of the institutions that held them.",
        "The design answer was subtraction. LUSD is minted only against ETH at a 110% minimum collateral ratio, with liquidations absorbed instantly by a Stability Pool rather than auctioned over hours. The contracts are immutable and governance-free: no admin keys, no upgrade path, no parameter anyone can change after deployment. There is no reserve account, no banking relationship, and no issuer that can be sanctioned, frozen, or run on.",
        "That posture is exactly what made the SVB weekend a clean experiment. When the banking channel that USDC, Dai, and FRAX all depended on closed for the weekend, LUSD had no equivalent channel to lose. Its resilience was the absence of the thing that was breaking everywhere else, not a defense mounted under stress.",
      ],
    },
    {
      heading: "The redemption floor and the $1.00-$1.10 corridor",
      paragraphs: [
        "LUSD does not target an exact dollar; it trades inside a corridor enforced at both ends by arbitrage. The floor is the load-bearing one. At any time, anyone can redeem LUSD against the protocol for a dollar's worth of the underlying ETH collateral. If LUSD trades below $1.00, an arbitrageur buys the discounted token and redeems it for a full dollar of ETH, pocketing the gap and removing LUSD from supply until the price climbs back. This is an enforced floor, not an assumed one: it runs at the contract level and needs no banking hours.",
        "The ceiling sits near $1.10 and works in reverse. Because the minimum collateral ratio is 110%, a new borrower can post $1.10 of ETH, mint LUSD, and sell it; whenever LUSD trades above that level, minting-and-selling is immediately profitable and the resulting supply caps the price. Between the two hard pegs, softer forces (a Schelling point at parity, shrinking arbitrage margins near the ceiling, and leverage that grows as LUSD rises) nudge the price around inside the band.",
        "The corridor is deliberately asymmetric. The floor is a strict redemption guarantee in ETH; the ceiling is a softer minting incentive. That asymmetry means LUSD is far more willing to trade above par than below it, which is precisely the behavior the March 2023 weekend put on display.",
      ],
    },
    {
      heading: "March 2023: contagion inverted",
      paragraphs: [
        "When SVB failed, the contagion that swept the fiat-backed cluster ran straight past LUSD. USDC fell to about $0.87, Dai to roughly $0.85 through its USDC-backed PSM, and FRAX to about $0.88 on its hardcoded-dollar collateral leg. LUSD's only downward move was a brief dip to roughly $0.985, shallow enough to be read as a momentary liquidity opening rather than a depeg, and immediately closed by the redemption floor.",
        "The dominant move was upward. Holders exiting the impaired stablecoins rotated into assets with no banking exposure, and LUSD was a natural destination. The buying pressure pushed it to a premium of roughly $1.05-1.08 on some venues, and demand spilled into lending markets: Aave borrow rates for LUSD spiked toward 75% as users pulled the token to escape USDC- and Dai-heavy positions. The premium itself created the corrective arbitrage (above-par LUSD invites new borrowers to mint and sell), but with so much capital seeking the exit at once, the premium persisted across the weekend before the corridor pulled it back.",
        "The recovery numbers are the cleanest evidence. LUSD returned to peg in under 15 hours, against an average of over 35 hours for USDC, FRAX, and Dai, and it ended Q1 2023 with supply up about 50% (roughly $178.5M to $267.8M) while Dai's float contracted about 8%. The same weekend that cost the fiat-backed coins their pegs grew the purely-crypto-collateralized one.",
      ],
    },
    {
      heading: "Resilience by subtraction and its costs",
      paragraphs: [
        "Reading the premium as an unalloyed win misses the design's tradeoffs. The upward bias is structural: the hard ETH-redemption floor defends the downside far more aggressively than the softer minting ceiling defends the upside, so in a flight to safety LUSD will tend to overshoot par rather than hold it. A premium is a feature for holders during a crisis, but it is also a real cost for anyone who needs to acquire LUSD at exactly that moment, and it is why LUSD spends much of its life slightly above a dollar rather than on it.",
        "The redemption mechanism that enforces the floor also redistributes risk inside the system. Redemptions are filled against the riskiest Troves first (those with the lowest collateral ratios), so a borrower running close to the 110% minimum can have their ETH collateral redeemed away and their position effectively closed at the worst possible time. The peg's robustness is partly subsidized by the least-collateralized borrowers, who bear the redemption pressure on behalf of the whole system.",
        "Immutability is the deepest tradeoff of all, and 2025 made it concrete. When Liquity disclosed a vulnerability in the V2 (BOLD) Stability Pool in February 2025, there was no way to patch the live contracts; the only remedy was to advise users to withdraw and redeploy the entire protocol, which happened on May 19, 2025 after an extended audit. No funds were lost and BOLD stayed fully backed, but the episode showed the other face of governance-free design: the same property that makes the protocol untamperable also makes it un-fixable in place. Resilience by subtraction removes attack surface and removes the off-switch in the same stroke.",
      ],
    },
    {
      heading: "Lessons",
      paragraphs: [
        "Dependencies are the depeg vector, not collateral quality alone. The fiat-backed coins that broke in March 2023 were not undercollateralized; they were dependent on a banking channel that closed for a weekend. LUSD held because it had nothing equivalent to lose. Monitoring should weight where a coin's redemption path runs, and how exposed that path is to actors a holder cannot see, at least as heavily as the headline quality of the backing.",
        "A premium is a signal, not just a victory lap. LUSD's upward dislocation was the visible footprint of contagion inverting: capital fleeing somewhere else. Pharos surfaces the deviation history on the LUSD page, but daily snapshots smooth a premium spike that lasted hours, so the durable signal is the supply growth and the structural absence of off-chain exposure rather than any single high print. The discarded $1.77 thin-print from the same window is exactly the kind of illiquid outlier that the smoothed series correctly ignores.",
        "Immutability and patchability are mutually exclusive, and that is a choice with a price. LUSD's governance-free design is what makes it impossible to freeze or quietly rewrite, and what made the 2025 V2 issue a full redeploy rather than a hotfix. A resilient stablecoin is one whose failure modes are visible, bounded, and accepted up front, not one with no failure modes.",
      ],
    },
  ],
  dataWidgets: [
    {
      kind: "peg-deviation",
      coinId: "lusd-liquity",
      caption:
        "LUSD's daily peg history on Pharos. The March 2023 SVB weekend shows as an upward move, not a break: LUSD bid to a premium while fiat-backed coins fell. Daily snapshots smooth the brief ~$1.05-1.08 spike, which lasted hours rather than days.",
    },
  ],
  watchpoints: [
    "Redemption-path dependencies versus collateral quality: a coin can be conservatively backed and still depeg if its redemption runs through a counterparty (a bank, a PSM, a single issuer) that can stall; that is the exposure Pharos maps in the dependency view.",
    "Upward dislocations as a contagion tell: a flight-to-safety premium on a crypto-collateralized coin is the mirror image of a break elsewhere; read premiums on the deviation chart as a signal of stress in correlated assets, not just strength.",
    "Lowest-collateral Troves as the redemption sink: in Liquity's design, redemptions hit the riskiest positions first, so a borrower near the 110% floor can be redeemed against and closed out precisely when ETH is falling.",
    "Immutability as a double-edged property: governance-free contracts cannot be frozen or rewritten, but they also cannot be patched: a disclosed bug forces a full redeploy, as the V2 Stability Pool issue did in 2025.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/cdp/", label: "How CDP stablecoins work" },
    { href: "/learn/case-studies/usdc-svb-2023/", label: "Case study: the same weekend, from the side that broke" },
    { href: "/learn/case-studies/dai-black-thursday/", label: "Case study: Dai and Black Thursday, the failure Liquity answered" },
    { href: "/stablecoin/lusd-liquity/", label: "LUSD (Liquity) overview" },
    { href: "/stablecoin/bold-liquity/", label: "BOLD (Liquity V2)" },
  ],
  sources: [
    {
      label: "Liquity: Q1 2023 report (LUSD premium, <15h repeg, +50% supply)",
      href: "https://www.liquity.org/blog/liquity-q1-report",
    },
    {
      label: "Liquity: The premium of resiliency (peg corridor and redemption mechanics)",
      href: "https://www.liquity.org/blog/the-premium-of-resiliency",
    },
    {
      label: "Liquity: Goes live on Ethereum mainnet (April 5, 2021 launch)",
      href: "https://www.liquity.org/blog/liquity-goes-live-on-ethereum-mainnet",
    },
    {
      label: "Liquity: V2 redeployment updates (Stability Pool issue, May 19, 2025 relaunch)",
      href: "https://www.liquity.org/blog/liquity-v2-redeployment",
    },
    {
      label: "The Defiant: Liquity outflows after disclosing V2 bug",
      href: "https://thedefiant.io/news/defi/liquity-protocol-suffers-usd30-million-of-outflows-after-disclosing-v2-bug",
    },
  ],
  metaDescription:
    "While USDC, Dai, and FRAX broke below $0.90 in the March 2023 SVB weekend, ETH-only LUSD traded at a premium and repegged in under 15 hours.",
  datePublished: "2026-06-15",
};
