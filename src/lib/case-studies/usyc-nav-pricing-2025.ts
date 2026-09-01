import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "usyc-nav-pricing-2025",
  eyebrow: "NAV pricing wound",
  title: "USYC: when a T-bill fund became DeFi collateral",
  subtitle:
    "USYC's Treasury portfolio did not fail. The wound was downstream: protocols treated a permissioned NAV fund share like instantly liquid stablecoin collateral, then learned that NAV, market price, and redemption access are different things.",
  lead: [
    "USYC is not a bank-dollar stablecoin. It is the tokenized representation of Hashnote's short-duration fund, now Circle USYC: a yield-bearing share backed by short-term U.S. Treasury bills and repo activity, with token price calculated from fund NAV divided by shares outstanding. That design is conservative at the asset layer, but it creates a pricing problem when DeFi wants to use the token as collateral.",
    "The problem surfaced around the January 2025 Usual shock. Usual's USD0 used tokenized Treasury exposure including USYC as reserve collateral, while USD0++ was treated by many markets as a dollar-like asset until Usual introduced a discounted early-exit floor. The underlying USYC portfolio was not the impaired leg, but the episode showed how quickly a NAV asset can become part of a liquidation graph once protocols wrap it, oracle it, and reuse it as stablecoin backing.",
    "That is the USYC lesson: a T-bill fund can be money-market safe and still be DeFi-fragile. Holders who can subscribe and redeem through the issuer care about NAV and settlement. Lending markets, AMMs, and derivatives venues care about executable secondary liquidity and oracle freshness. If those two prices diverge under stress, the fund share is wounded as collateral even when the T-bills themselves are fine.",
  ],
  takeaways: [
    "USYC is a NAV-priced tokenized fund share, not a fixed $1 payment stablecoin; its price accretes with Treasury/repo yield and is calculated from fund NAV.",
    "The January 2025 Usual episode did not mean USYC's T-bill collateral failed. It exposed how USD0/USD0++ and lending markets depended on pricing a fund share correctly under stress.",
    "Tokenized T-bills need redemption-anchored collateral pricing. Thin secondary liquidity or stale/aggressive oracles can turn a conservative asset into risky DeFi collateral.",
    "The right mental model is basis risk: NAV for qualified fund users, secondary price for market exits, and protocol oracle value for liquidations are three different numbers.",
  ],
  primaryCoinId: "usyc-hashnote",
  relatedCoins: [
    {
      coinId: "usd0-usual",
      note: "USD0 and USD0++ are the downstream case. USD0 was collateralized by tokenized Treasury assets including USYC, while USD0++ repriced when Usual changed early-redemption terms. USYC's portfolio was not the broken asset; it was the reserve leg DeFi needed to price correctly.",
    },
  ],
  archetype: "tbill",
  outcome: "wounded",
  eventDateLabel: "January 2025",
  eventWindow: {
    startISO: "2025-01-09",
    endISO: "2025-01-21",
  },
  timeline: [
    {
      dateISO: "2024-06-01",
      headline: "USYC becomes core tokenized-Treasury collateral",
      body: "Usual's USD0 architecture accepts tokenized RWA collateral such as USYC, turning a permissioned fund share into backing for a more widely used DeFi dollar. The structure makes USYC's NAV and redemption process relevant to users who never subscribe directly to the fund.",
      severity: "med",
      href: "https://www.llamarisk.com/research/pegkeeper-onboarding-usd0",
    },
    {
      dateISO: "2025-01-10",
      headline: "USD0++ terms shock puts the collateral stack under stress",
      body: "Usual introduced a discounted early-exit floor for USD0++, repricing the locked claim to the high-80-cent range. The reserve assets behind USD0, including USYC, were not the failure; the stress was in how markets had treated a layered Treasury-backed claim as immediately dollar-like.",
      severity: "high",
      href: "https://blockworks.co/news/usual-depeg-spurs-defi-instability",
    },
    {
      dateISO: "2025-01-21",
      headline: "Circle acquires Hashnote and USYC",
      body: "Circle announced the acquisition of Hashnote and USYC, pairing the tokenized money-market fund with planned USDC convertibility. The move strengthened the institutional distribution story while reinforcing the core design: USYC is a NAV fund share with controlled access, not an ungated retail dollar.",
      severity: "low",
      href: "https://www.circle.com/pressroom/circle-announces-acquisition-of-hashnote-and-usyc-tokenized-money-market-fund-alongside-strategic-partnership-with-global-trading-firm-drw",
    },
    {
      dateISO: "2025-08-01",
      headline: "USYC moves deeper into collateral use",
      body: "Circle later announced USYC support as yield-bearing off-exchange collateral for Binance institutional clients. That is the same tradeoff at larger scale: Treasury NAV assets can improve capital efficiency, but only if venues price redemption, transfer restrictions, and secondary liquidity explicitly.",
      severity: "med",
      href: "https://www.circle.com/pressroom/circles-usyc-now-supported-as-yield-bearing-off-exchange-collateral-for-binances-institutional-clients",
    },
  ],
  sections: [
    {
      id: "what-usyc-is",
      heading: "What USYC is",
      paragraphs: [
        "USYC represents shares of the Hashnote International Short Duration Yield Fund. The fund invests in short-term U.S. Treasury bills and performs repo and reverse-repo activity; the token's price is calculated from the fund's NAV divided by the total USYC outstanding. In other words, the asset is designed to accrete yield rather than sit mechanically at $1.",
        "That distinction matters. A holder with access to the issuer's subscription and redemption rails experiences USYC as a fund share: buy at current NAV, redeem at current NAV, and earn the fund return through price appreciation. A lending market or AMM that accepts USYC as collateral experiences something different: a token that may have limited secondary liquidity, transfer controls, and an oracle value that can diverge from what a qualified redeemer could get through primary settlement.",
      ],
    },
    {
      id: "january-2025-wound",
      heading: "The January 2025 wound",
      paragraphs: [
        "The January 2025 Usual episode was not a USYC portfolio failure. Usual changed the early-redemption terms for USD0++, a locked claim built on top of USD0, and the market repriced that claim below par. But USD0's reserve stack included tokenized Treasury exposure such as USYC, so the episode pulled USYC into a wider lesson about how DeFi treats NAV assets.",
        "The market had layered a dollar-like instrument on top of fund shares, then lent against and traded the derivative as though every layer were immediately redeemable at a dollar. When the top layer repriced, the system had to distinguish three values that had been casually collapsed into one: USYC NAV, USD0 reserve value, and USD0++ early-exit value. The wound was the realization that those are not the same surface.",
      ],
    },
    {
      id: "nav-is-not-an-oracle",
      heading: "NAV is not an oracle",
      paragraphs: [
        "A fund NAV is a valuation process; a DeFi oracle is a liquidation input. NAV can be perfectly reasonable for subscriptions and redemptions while still being too slow, gated, or inaccessible for a lending market that needs to liquidate collateral now. Conversely, a secondary-market price can be executable but too thin to represent the fund's actual asset value.",
        "Tokenized T-bill collateral therefore needs an explicit pricing hierarchy. Primary NAV should anchor solvency; secondary liquidity should anchor emergency exits; protocol oracles should encode haircuts, access restrictions, and staleness. Treating any one of those as a universal dollar price creates the same failure mode that appeared in USD0++ and many hardcoded-stablecoin markets: the liquidation engine sees a clean number while the market sees a different exit.",
      ],
    },
    {
      id: "lessons",
      heading: "Lessons",
      paragraphs: [
        "The lesson is not that tokenized Treasuries are unsafe. USYC is backed by high-quality short-duration assets and became more institutionally integrated after Circle acquired Hashnote. The lesson is that asset quality does not eliminate market-structure risk. A permissioned fund share can be excellent collateral for the right user and fragile collateral for an ungated protocol that assumes instant liquidity.",
        "For Pharos, this is why the `tbill` archetype is scored separately from fiat-cash stablecoins. A T-bill token's core risk is less about whether the collateral exists and more about how quickly the holder can turn a NAV claim into spendable dollars, who has redemption access, and what downstream protocols do when the oracle value and the executable exit value disagree.",
      ],
    },
  ],
  dataWidgets: [
    {
      kind: "peg-deviation",
      coinId: "usyc-hashnote",
      caption:
        "USYC on Pharos: a NAV-priced tokenized fund share. The chart is useful less as a classic dollar-peg tape and more as evidence of how slowly and institutionally NAV assets move compared with DeFi liquidation clocks.",
    },
  ],
  watchpoints: [
    "Oracle design for protocols that accept USYC or USYC-backed assets as collateral: NAV feeds, secondary liquidity, and haircuts should be explicit rather than assumed equivalent.",
    "Redemption access and timing: who can redeem USYC at NAV, whether redemption is same-day or delayed, and how USDC convertibility is implemented in stress.",
    "Secondary-market liquidity depth for holders who cannot use primary rails, especially when USYC is posted as collateral on venues that can liquidate quickly.",
    "Collateral reuse: how many downstream dollars or lending positions are built on top of USYC, and whether those layers preserve or hide the fund-share nature of the asset.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/tbill/", label: "Mechanism: tokenized T-bill stablecoins" },
    { href: "/stablecoin/usyc-hashnote/", label: "USYC live data and risk" },
    {
      href: "/learn/case-studies/usd0pp-usual-2025/",
      label: "Case study: USD0++ and the redemption-terms shock",
    },
    {
      href: "/learn/case-studies/buidl-tokenized-tbill-2025/",
      label: "Case study: BUIDL, the positive T-bill control",
    },
  ],
  sources: [
    {
      label: "USYC docs: Introduction",
      href: "https://usyc.docs.hashnote.com/",
    },
    {
      label: "USYC docs: Token price calculation",
      href: "https://usyc.docs.hashnote.com/overview/token-price",
    },
    {
      label: "LlamaRisk: PegKeeper onboarding review: Usual USD0",
      href: "https://www.llamarisk.com/research/pegkeeper-onboarding-usd0",
    },
    {
      label: "Blockworks: Usual depeg spurs instability in DeFi markets",
      href: "https://blockworks.co/news/usual-depeg-spurs-defi-instability",
    },
    {
      label: "Circle: Acquisition of Hashnote and USYC",
      href: "https://www.circle.com/pressroom/circle-announces-acquisition-of-hashnote-and-usyc-tokenized-money-market-fund-alongside-strategic-partnership-with-global-trading-firm-drw",
    },
    {
      label: "Circle: USYC supported as yield-bearing off-exchange collateral",
      href: "https://www.circle.com/pressroom/circles-usyc-now-supported-as-yield-bearing-off-exchange-collateral-for-binances-institutional-clients",
    },
  ],
  metaDescription:
    "USYC's T-bill portfolio held, but DeFi collateral use exposed NAV, oracle, liquidity, and redemption-access basis risk around the January 2025 Usual shock.",
  datePublished: "2026-06-18",
};
