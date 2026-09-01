import type { CaseStudy } from "./types";

/**
 * January 2025 — Usual unilaterally rewrites USD0++ redemption terms, introducing
 * a $0.87 early-exit floor against an implied 1:1 expectation. The repricing
 * cascades through Morpho lending markets that had hardcoded USD0++ at parity.
 * A governance/terms change, not an asset-quality failure. Annotations: see
 * shared/data/annotations/coins/usd0-usual.json (2025-01-10, 2025-01-13).
 */
export const content: CaseStudy = {
  slug: "usd0pp-usual-2025",
  eyebrow: "Redemption-terms shock",
  title: "USD0++ depeg: when Usual changed the redemption floor",
  subtitle:
    "A governance decision, not a backing failure, repriced Usual's locked USD0++ to roughly 89 cents and set off a deleveraging cascade across Morpho.",
  lead: [
    "USD0 is Usual's reserve-backed dollar, collateralized by tokenized U.S. Treasury exposure such as Hashnote USYC, M by M^0, and BlackRock's BUIDL. USD0++ is its locked, bond-like sibling: depositors stake USD0 for a four-year term in exchange for USUAL token rewards. Through the second half of 2024, much of the market treated USD0++ as if it were a freely redeemable dollar that simply paid extra yield.",
    "In the second week of January 2025 that assumption broke. Usual unilaterally rewrote the USD0++ exit mechanism, introducing an early-redemption floor of $0.87 against the 1:1 redemption many holders had assumed was permanent. The token repriced to roughly $0.89 within days. Nothing about the underlying Treasury collateral had changed; the cash flows behind USD0 were intact. What changed was the contractual promise of how, and at what price, holders could leave early.",
    "The repricing did not stay contained. Several Morpho lending markets had configured oracles that valued USD0++ at a hardcoded 1:1 to USD0, so leveraged positions built on that assumption faced liquidation pressure as the real exit value fell below parity. The episode is a clean study in redemption-terms risk: a locked yield instrument marketed alongside a stablecoin, a soft peg that depended on a redemption promise the issuer could revise, and DeFi collateral plumbing that had priced away the gap.",
  ],
  takeaways: [
    "This was a governance/terms change, not a backing failure: Usual unilaterally added a $0.87 early-exit floor, repricing USD0++ to ~$0.89 while the underlying Treasury collateral was untouched.",
    "Redemption terms are part of the peg: a soft peg resting on an issuer's revisable promise is only as firm as that issuer's discretion, and can reprice overnight without a holder vote.",
    "A multi-year locked claim that pays par only at maturity is a bond, not a dollar: at a few percent yearly yield its fair present value sits in the high-80-cent range, so the floor codified a discount rather than a loss.",
    "Hardcoded 1:1 oracles in Morpho markets turned the contractual repricing into forced deleveraging; collateral plumbing that pins a derivative to its base removes the very price signal that would warn of this.",
  ],
  primaryCoinId: "usd0-usual",
  archetype: "rwa-credit-fund",
  outcome: "wounded",
  eventDateLabel: "January 2025",
  eventWindow: {
    startISO: "2025-01-09",
    endISO: "2025-01-16",
    peakDeviationBps: -1100,
    lowPrice: 0.89,
  },
  timeline: [
    {
      dateISO: "2024-07-10",
      headline: "USD0 and USD0++ enter their public phase",
      body: "Usual's USD0 reserve-backed dollar and its locked USD0++ variant go live to the public. USD0++ pays USUAL token rewards in exchange for a multi-year lock on deposited USD0, framed as a liquid staked position rather than a freely redeemable dollar.",
      severity: "med",
    },
    {
      dateISO: "2025-01-10",
      headline: "Usual sets a $0.87 early-exit floor for USD0++",
      body: "Usual announces a revised redemption model. Early exits can take a floor price starting at $0.87 that accretes toward $1 over the four-year term, or a conditional 1:1 unstake that requires forfeiting USUAL rewards. The previously assumed unconditional 1:1 redemption is gone, and the change arrives without a holder vote.",
      severity: "high",
      href: "https://blockworks.co/news/usual-depeg-spurs-defi-instability",
    },
    {
      dateISO: "2025-01-13",
      headline: "USD0++ trades near $0.89 as Morpho positions deleverage",
      body: "USD0++ slides to roughly $0.89 as the market reprices it as a discounted four-year claim rather than a dollar. Morpho lending markets that had valued USD0++ at a fixed 1:1 oracle face liquidation pressure, Curve pools skew heavily toward USD0++, and the USUAL governance token sells off sharply alongside.",
      severity: "high",
    },
  ],
  sections: [
    {
      id: "what-usual-changed",
      heading: "What Usual changed",
      paragraphs: [
        "Before the announcement, the market's working model was that one USD0++ could be redeemed for one USD0 at will. Usual replaced that with a two-path exit. Holders could leave immediately at a floor that began at $0.87 and was scheduled to rise toward $1 across the asset's four-year term, or they could take a conditional 1:1 unstake that required surrendering accrued USUAL rewards. Either path made the true cost of leaving early explicit for the first time.",
        "The decision was made by the issuer and rolled out directly, not ratified through a holder vote ahead of time. That is the defining feature of this event. The reserve assets behind USD0 were unchanged and the protocol was not insolvent. The break was contractual rather than financial: the terms governing early exit were rewritten, and a price holders had treated as guaranteed turned out to be revisable.",
      ],
    },
    {
      id: "stablecoin-or-bond",
      heading: "Stablecoin or bond?",
      paragraphs: [
        "USD0++ was always closer to a fixed-term instrument than a dollar. Locking USD0 for roughly four years in exchange for token rewards is the economic shape of a zero-coupon-style claim, and a claim that pays out at par only at maturity should trade at a discount before then. At a few percent of annual yield over four years, a fair present value sits in the high-80-cent range rather than at $1. Viewed that way, the $0.87 floor was not a loss of backing; it was the issuer codifying the discounted value of an early exit.",
        "The damage came from the gap between that mechanism and how the asset had been used. Marketed beside USD0 and quoted near parity, USD0++ had been treated by much of the market as a slightly higher-yielding dollar. When the floor made the bond-like nature explicit, the soft peg holders had assumed simply was not there to defend. The lesson is not that the design was unsound but that a locked yield instrument should not be relied upon as a $1 stablecoin.",
      ],
    },
    {
      id: "morpho-collateral-cascade",
      heading: "The Morpho collateral cascade",
      paragraphs: [
        "The repricing propagated through DeFi because lending markets had priced away the very risk the floor exposed. Several Morpho markets accepting USD0++ as collateral used oracles that valued it at a fixed 1:1 to USD0 rather than tracking a floating market rate. While USD0++ held near parity, leveraged and looped positions built on that assumption looked safe.",
        "Once the early-exit value fell below $1, those positions were suddenly worth less than the oracle implied, and unwinding pressure followed. Curve pools holding USD0++ tilted heavily to the discounted side as holders rushed for the deepest available exit, and the USUAL governance token fell sharply in sympathy. The cascade was a plumbing failure layered on top of the terms change: hardcoded parity oracles turned a contractual repricing into forced deleveraging.",
      ],
    },
    {
      id: "lessons",
      heading: "Lessons",
      paragraphs: [
        "Redemption terms are part of the peg. A soft peg that rests on an issuer's redemption promise is only as firm as the issuer's discretion to revise it, and a change made without prior holder consent can reprice an asset overnight even when its backing is untouched. Track who controls exit terms and how those terms can change.",
        "Locked yield instruments are not dollars. A multi-year claim that pays par only at maturity behaves like a bond and should be expected to trade at a discount before then; treating it as a $1 stablecoin imports duration and terms risk that a true stablecoin would not carry. The cascade is the second lesson: collateral systems that hardcode a derivative asset at parity to its base remove the price signal that would otherwise warn of exactly this kind of repricing.",
      ],
    },
  ],
  dataWidgets: [
    {
      kind: "peg-deviation",
      coinId: "usd0-usual",
      caption:
        "Pharos peg-deviation series around the January 2025 floor-exit repricing, when Usual's $0.87 early-redemption floor pulled USD0++ to roughly 89 cents.",
    },
  ],
  watchpoints: [
    "Governance over exit terms: whether USD0++ early-redemption parameters can be changed unilaterally again, or now require a holder vote and notice period.",
    "Oracle pricing for locked variants: whether Morpho, Curve, and other venues value USD0++ at a market rate rather than a hardcoded 1:1 to USD0.",
    "Marketing-versus-mechanism clarity: whether USD0++ continues to be presented in ways that invite holders to treat a four-year locked claim as a $1 stablecoin.",
    "USD0 reserve composition: the Treasury-backed collateral behind USD0 itself, which was not the cause of this event but remains the asset-quality anchor to monitor.",
  ],
  crossLinks: [
    {
      href: "/learn/mechanisms/rwa-credit-fund/",
      label: "Mechanism: tokenized credit and RWA-backed dollars",
    },
    {
      href: "/stablecoin/usd0-usual/",
      label: "USD0 (Usual) coin page",
    },
    {
      href: "/dependency-map/",
      label: "Dependency map: where USD0 collateral and DeFi exposure connect",
    },
    {
      href: "/learn/case-studies/pmusd-precious-metals/",
      label: "Case study: pmUSD's gold-RWA fragility",
    },
  ],
  sources: [
    {
      label: "Blockworks: Usual protocol's depeg spurs instability in DeFi markets",
      href: "https://blockworks.co/news/usual-depeg-spurs-defi-instability",
    },
    {
      label: "The Block: Usual Money protocol update as USD0++ drops below 92 cents",
      href: "https://www.theblock.co/post/333995/usual-money-protocol-update",
    },
    {
      label: "Coinspeaker: Usual Labs' USD0++ falls as ecosystem questions new redemption model",
      href: "https://www.coinspeaker.com/usual-labs-usd0-falls-ecosystem-questions-new-redemption-model/",
    },
    {
      label: "Usual: USD0++ upgrade: early unstaking, vaults, liquidity",
      href: "https://usual.money/blog/usd0-upgrade-early-unstaking-vaults-liquidity",
    },
    {
      label: "Gate Learn: Usual explained: USD0++ depegging and circular-loan liquidations",
      href: "https://www.gate.com/learn/articles/usual-explained-the-hidden-issues-behind-usd0-depegging-and-circular-loans-liquidation/6030",
    },
  ],
  metaDescription:
    "How Usual's January 2025 USD0++ $0.87 floor change repriced a locked yield token and cascaded through Morpho lending markets without any failure of backing.",
  datePublished: "2026-05-23",
};
