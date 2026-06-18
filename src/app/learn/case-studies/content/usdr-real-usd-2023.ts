import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "usdr-real-usd-2023",
  eyebrow: "Illiquid RWA run",
  title: "USDR: tokenized houses cannot sell at 3 AM",
  subtitle:
    "Tangible's Real USD was backed by real assets, but not liquid ones. When the DAI cushion drained, holders discovered that on-chain redemptions move in seconds and real estate does not.",
  lead: [
    "USDR was Tangible's real-estate-backed stablecoin on Polygon. Its pitch was intuitive: combine liquid crypto reserves with tokenized, yield-producing real estate and let holders earn exposure to rental income while keeping a dollar target. At peak, Pharos records roughly $71M of market value. The flaw was not that the houses were fictional. It was that they were houses.",
    "In October 2023, redemptions drained the liquid DAI cushion that stood between USDR holders and the illiquid property portfolio. Once the stablecoin buffer was gone, the remaining backing could not be sold fast enough to meet on-chain exits. USDR fell toward $0.50, then lower, and never recovered as a functioning stablecoin. Tangible later acknowledged there were too many attack vectors in the design and pursued a recovery path instead of a repeg.",
    "USDR is the canonical `rwa-credit-fund` death case: real-world collateral can be real and still fail as stablecoin collateral if its liquidity horizon does not match redemption demand. A stablecoin promises money now. Rental property settles later. The gap between those clocks was the peg failure.",
  ],
  takeaways: [
    "USDR failed from liquidity mismatch, not from imaginary collateral: tokenized real estate could not be liquidated on the same timescale as on-chain redemptions.",
    "The design relied on a thin DAI cushion. Once holders drained roughly $6M of liquid assets, the remaining backing was mostly illiquid property exposure.",
    "RWA collateral quality must include time-to-cash. Appraisals and ownership claims do not defend a peg if the assets cannot be sold before the run finishes.",
    "USDR died as a stablecoin: the team shifted to salvage and recovery rather than restoring a durable dollar peg.",
  ],
  archetype: "rwa-credit-fund",
  outcome: "died",
  eventDateLabel: "October 2023",
  eventWindow: {
    startISO: "2023-10-10",
    endISO: "2023-10-12",
    peakDeviationBps: -5000,
    lowPrice: 0.5,
  },
  cemeteryId: "usdr-real-usd-2023-10",
  timeline: [
    {
      dateISO: "2022-10-01",
      headline: "Tangible builds a real-estate-backed dollar",
      body: "USDR launched around a hybrid reserve model: liquid stablecoin backing plus tokenized real-estate exposure intended to generate yield. The structure made the stablecoin dependent on a small cash buffer in front of slow, off-chain assets.",
      severity: "low",
    },
    {
      dateISO: "2023-10-10",
      headline: "The DAI cushion drains",
      body: "A wave of redemptions exhausted roughly $6M of liquid DAI reserves in a short span. Once that buffer was gone, the remaining collateral base was dominated by tokenized real estate that could not be converted into redemption liquidity on demand.",
      severity: "high",
      href: "https://www.coindesk.com/markets/2023/10/11/real-estate-backed-stablecoin-usdr-de-pegs-after-treasury-was-drained-of-liquid-assets",
    },
    {
      dateISO: "2023-10-11",
      headline: "USDR depegs toward $0.50",
      body: "USDR fell sharply below its dollar target, with reporting putting the token around the 50-cent range after the treasury's liquid assets were drained. The peg was not defended by the real-estate backing because that backing could not be sold quickly.",
      severity: "high",
      href: "https://blockworks.co/news/tangible-real-usd-illiquid-stablecoin-real-world-assets",
    },
    {
      dateISO: "2023-10-12",
      headline: "Tangible shifts to salvage",
      body: "The issuer moved from peg defense to asset recovery and user make-whole planning, acknowledging design flaws and the liquidity mismatch. USDR's stablecoin life was effectively over.",
      severity: "high",
      href: "https://www.coindesk.com/business/2023/10/12/usdr-issuer-to-salvage-failed-property-backed-stablecoins-assets-make-users-whole",
    },
    {
      dateISO: "2024-02-21",
      headline: "Recovery path replaces repeg path",
      body: "Months later, the project was still charting a recovery process for assets rather than restoring a live dollar instrument. The collapse had become an unwind, not a temporary deviation.",
      severity: "med",
      href: "https://www.coindesk.com/business/2024/02/21/collapsed-real-estate-backed-stablecoin-charts-path-to-recovery",
    },
  ],
  sections: [
    {
      heading: "What happened",
      paragraphs: [
        "USDR was built around a simple but dangerous maturity stack. The token itself was redeemable and tradable on-chain, where holders can exit in seconds. Part of the backing was liquid stablecoins, but a meaningful portion sat in tokenized real estate, an asset class whose liquidation process runs through brokers, buyers, financing, legal transfer, and settlement.",
        "That can work while redemptions are normal and the liquid buffer absorbs daily flow. It fails when everyone asks for cash at once. In October 2023, redemptions drained the DAI cushion, leaving USDR holders with a claim against property exposure that could not be turned into DAI quickly enough. The price broke because the redemption promise had become faster than the assets backing it.",
      ],
    },
    {
      heading: "RWA backing is not RWA liquidity",
      paragraphs: [
        "The usual defense of real-world-asset stablecoins is that the collateral is real. USDR shows why that is not enough. Real estate may have appraised value, rental income, and legal ownership documentation, but none of those properties make it a same-day liquidity source. A stablecoin run does not wait for a listing process.",
        "In a bank, this is a classic asset-liability mismatch: demand liabilities funded by long-duration or illiquid assets. USDR recreated the same mismatch on-chain. The liability traded like money; the asset sold like property. Once the small liquid reserve was gone, the mismatch was visible to every holder at once.",
      ],
    },
    {
      heading: "Why the peg could not be defended",
      paragraphs: [
        "A peg defense requires a buyer of last resort or a redemption path at par. USDR had neither once DAI was exhausted. Arbitrageurs could not buy discounted USDR and confidently redeem for $1 of liquid assets, because the remaining backing was not available in liquid form. The price therefore reflected the time, uncertainty, and haircut required to liquidate real estate.",
        "That is why this was not a temporary market panic. The mechanism itself had promised a liquidity profile the collateral could not support. Tangible's later recovery process could distribute value over time, but distributing value over time is not the same as maintaining a stablecoin.",
      ],
    },
    {
      heading: "Lessons",
      paragraphs: [
        "The key RWA question is not just 'does the asset exist?' It is 'can this asset become redemption liquidity before holders finish running?' For stablecoins, time-to-cash is collateral quality. A reserve that is valuable over months can still be worthless for defending a peg over hours.",
        "USDR also clarifies the boundary between an investment product and money. Tokenized property exposure can be a legitimate investment claim. It should not be wrapped in an instantly redeemable dollar unless the issuer holds enough liquid assets, enforceable gates, or notice periods to make the promise honest. Otherwise the first real run turns a valuation problem into a death event.",
      ],
    },
  ],
  watchpoints: [
    "Liquid buffer size relative to redeemable supply, especially when the remaining collateral is property, private credit, or any asset that cannot settle quickly.",
    "Redemption terms that promise instant or near-instant exits against assets whose actual sale process takes days, weeks, or months.",
    "RWA appraisals being used as if they were cash-equivalent collateral values in AMMs or lending protocols.",
    "Issuer language that shifts from peg defense to recovery planning; for a stablecoin, that usually marks the transition from wounded to dead.",
  ],
  crossLinks: [
    {
      href: "/learn/mechanisms/rwa-credit-fund/",
      label: "Mechanism: tokenized credit and RWA-backed dollars",
    },
    { href: "/cemetery/", label: "Stablecoin cemetery" },
    {
      href: "/learn/case-studies/mai-qidao-bridge-2023/",
      label: "Case study: MAI and the 2023 sub-peg cluster",
    },
    {
      href: "/learn/case-studies/buidl-tokenized-tbill-2025/",
      label: "Case study: BUIDL, the liquid T-bill contrast",
    },
  ],
  sources: [
    {
      label: "CoinDesk — Real-estate-backed USDR depegs after treasury drained",
      href: "https://www.coindesk.com/markets/2023/10/11/real-estate-backed-stablecoin-usdr-de-pegs-after-treasury-was-drained-of-liquid-assets",
    },
    {
      label: "CoinDesk — USDR issuer to salvage failed stablecoin assets",
      href: "https://www.coindesk.com/business/2023/10/12/usdr-issuer-to-salvage-failed-property-backed-stablecoins-assets-make-users-whole",
    },
    {
      label: "CoinDesk — Collapsed real-estate-backed stablecoin charts recovery path",
      href: "https://www.coindesk.com/business/2024/02/21/collapsed-real-estate-backed-stablecoin-charts-path-to-recovery",
    },
    {
      label: "Blockworks — USDR shows illiquid real-world assets can break a stablecoin",
      href: "https://blockworks.com/news/tangible-real-usd-illiquid-stablecoin-real-world-assets",
    },
    {
      label: "DL News — Real-estate-backed stablecoin USDR collapses",
      href: "https://www.dlnews.com/articles/defi/usdr-stablecoin-backed-by-real-estate-collapses/",
    },
  ],
  metaDescription:
    "USDR died when its DAI cushion drained and tokenized real estate could not meet instant redemptions. Real RWA collateral was not liquid collateral.",
  datePublished: "2026-06-18",
};
