import type { CaseStudy } from "./types";

/**
 * June 2026 (ongoing) — Apyx's apxUSD, an "RWA-backed" dollar whose reserve is
 * majority Strategy preferred equity (STRC) — around 62% per Apyx's own
 * Accountable dashboard — slides into a downside depeg as
 * Bitcoin falls and the preferred shares trade below par. The asset class is
 * labelled real-world, but the dominant leg is Bitcoin-correlated, so the
 * reserve weakened exactly when a dollar should hold. The incident opened in
 * Pharos's June 2 snapshot and is still unresolved. Annotations: see
 * shared/data/annotations/coins/apxusd-apyx.json (2026-06-04).
 */
export const content: CaseStudy = {
  slug: "apxusd-dat-collateral",
  eyebrow: "Correlated collateral shock",
  title: "apxUSD and the Bitcoin-treasury collateral chain",
  subtitle:
    "Apyx markets apxUSD as an RWA-backed dollar, but roughly 62% of its reserve is Strategy preferred equity, a Bitcoin-correlated asset that fell with crypto in early June 2026, opening a downside depeg that is still unresolved.",
  lead: [
    "apxUSD is a dollar stablecoin issued through Apyx and facilitated by Preference Capital (BVI) Ltd. under British Virgin Islands law. It is mintable 1:1 and described as real-world-asset-backed, but the composition of that backing is unusual. By Apyx's own Accountable reserve dashboard, the majority of the reserve (around 62%) is STRC, preferred equity issued by Strategy, the largest corporate Bitcoin treasury, with a fractional sliver of Strive's SATA preferred and the remaining share in cash and short-term U.S. Treasury Bills (including USDC) for liquidity. CoinDesk's reporting confirms preferred equity is the majority leg but does not publish a precise split; the label says RWA, and the dominant leg is a claim on a company whose balance sheet is Bitcoin.",
    "In early June 2026, that distinction stopped being academic. As Bitcoin fell and Strategy's preferred shares traded below their par value, apxUSD's reserve marked down with it. The token slid from about $0.99 toward the low-$0.90s in the first break and later printed a deeper all-time low near $0.865 on June 18, about 13.5% below par. CoinDesk reported the break on June 4, and Apyx framed it publicly as expected behaviour for a preferred-equity-backed dollar rather than a failure. The cash-and-Treasury buffer, sized at under 40% of reserves, could not absorb a drawdown on a leg nearly twice its size.",
    "The episode has not closed. Pharos still flags the June incident as an active depeg, and on June 18, 2026 apxUSD traded around $0.87 (roughly 1,300 basis points under par) with a DISTRESSED status, a Safety grade of D (49/100), a DEWS reading of WATCH (29/100), and circulating supply down about 8.6% over thirty days as holders exit. Because the token remains live and is structurally scarred rather than decommissioned, Pharos classifies the outcome as wounded. This study treats apxUSD as a case of correlated collateral: an RWA dollar whose reserve was, in substance, long the very asset its peg was supposed to be stable against.",
  ],
  takeaways: [
    "The 'RWA-backed' label hides the risk: the majority leg (~62% per Apyx's dashboard) is Strategy's STRC preferred equity, a Bitcoin-correlated asset that falls when a dollar most needs to hold.",
    "When crypto sold off in June 2026, reserve and stress shared a common factor: the cash/T-Bill buffer was sized below the volatile leg, so apxUSD slid through the low-$0.90s and was still depegged near $0.87 on June 18.",
    "Redemption is whitelisted, so retail's only exit is a thin Curve market; the participants who can arbitrage par lose the incentive to defend it exactly when the reserve is falling.",
    "An issuer calling a depeg 'a feature, not a bug' is telling you the design permits the price to move with its collateral; take it literally.",
  ],
  primaryCoinId: "apxusd-apyx",
  depegEventSlug: "apxusd-2026-06-02",
  relatedCoins: [
    {
      coinId: "apyusd-apyx",
      note: "apyUSD is Apyx's ERC-4626 savings wrapper over apxUSD; it unlocks back to apxUSD over roughly thirty days, so it inherits the same collateral risk and a redemption queue on top of it. Pharos scores it F (37/100).",
    },
  ],
  archetype: "rwa-credit-fund",
  outcome: "wounded",
  eventDateLabel: "June 2026 (ongoing)",
  eventWindow: {
    startISO: "2026-06-02",
    endISO: "2026-06-18",
    peakDeviationBps: -1352,
    lowPrice: 0.8648,
  },
  timeline: [
    {
      dateISO: "2026-02-18",
      headline: "apxUSD launches on a Digital-Asset-Treasury collateral model",
      body: "Apyx launches apxUSD as a 1:1 mint-and-redeem dollar backed by preferred shares of Digital Asset Treasury companies (variable-rate, dividend-bearing preferred equity from firms that hold crypto on their balance sheet), plus a cash and T-Bill buffer. The issuer is Preference Capital (BVI) Ltd. under British Virgin Islands law, with U.S., EU, UK, and Canadian persons blocked from the platform.",
      severity: "low",
    },
    {
      dateISO: "2026-03-23",
      headline: "A brief upside spike to $1.11 hints at thin liquidity",
      body: "apxUSD prints a short upside dislocation to about $1.11, roughly a +1,100 bps deviation, before snapping back to par. An isolated spike of that size in a dollar token is a liquidity signal: the secondary market is thin enough that modest flow can move the price far from $1 in either direction.",
      severity: "low",
    },
    {
      dateISO: "2026-06-02",
      headline: "Downside incident opens as Bitcoin and STRC fall",
      body: "As Bitcoin declines and Strategy's STRC preferred shares trade below their par value, apxUSD's reserve marks down and the token slides from about $0.99 toward the low-$0.90s. Pharos opens a depeg incident from the June 2 snapshot; it carries no recovery print and remains active.",
      severity: "high",
      href: "https://www.coindesk.com/markets/2026/06/04/apyx-s-stablecoin-suffers-a-brief-depeg-protocol-says-its-a-feature-not-bug",
    },
    {
      dateISO: "2026-06-04",
      headline: "Apyx calls the depeg “a feature, not a bug”",
      body: "CoinDesk reports the depeg, quoting prices from $0.90 to $0.93. Apyx frames the move as expected behaviour for a preferred-equity-backed dollar rather than a peg break. That framing is itself the story: it is a statement about design intent (the reserve is allowed to move with crypto), not a defense of par.",
      severity: "high",
      href: "https://www.coindesk.com/markets/2026/06/04/apyx-s-stablecoin-suffers-a-brief-depeg-protocol-says-its-a-feature-not-bug",
    },
    {
      dateISO: "2026-06-18",
      headline: "Still unresolved: ~$0.87, DISTRESSED, supply shrinking",
      body: "By June 18, apxUSD trades near $0.87 after printing an all-time low around $0.865, and Pharos still shows an active depeg. Safety sits at D (49/100), DEWS at WATCH (29/100), liquidity at 60 across 17 pools, and circulating supply is down about 8.6% over thirty days as holders redeem and exit.",
      severity: "high",
    },
  ],
  sections: [
    {
      heading: "What apxUSD actually holds",
      paragraphs: [
        "apxUSD's reserve is reported through Apyx's Accountable dashboard as a collateral mix, and the live split is lopsided. Around 62% sits in STRC, the preferred equity of Strategy (formerly MicroStrategy), with a negligible fraction in Strive's SATA preferred and the rest, about 38%, in cash, short-term U.S. Treasury Bills, and USDC held for liquidity. Redemptions settle in USDC, and under stress the protocol sells preferred-share positions into USDC to meet them. A Protocol-Owned-Liquidity buffer is meant to smooth the secondary market during dislocations.",
        "Preferred equity in a Digital Asset Treasury company is not a Treasury bill. STRC is a dividend-bearing claim on Strategy, a firm whose principal asset is Bitcoin; its value depends on Strategy's ability to service the preferred and on the market's appetite for leveraged Bitcoin exposure. That is a real instrument with a real yield, but it is a corporate-credit-plus-equity claim, and its price behaviour tracks crypto risk far more closely than it tracks the front of the Treasury curve. Calling the resulting dollar 'RWA-backed' is accurate about the asset class and silent about the correlation.",
      ],
    },
    {
      heading: "Why a real-world asset moved with crypto",
      paragraphs: [
        "A stablecoin's reserve does its job when it holds value precisely in the moments the peg is tested. T-Bill-backed dollars work because the collateral is, to a first approximation, uncorrelated with the crypto markets where the token trades: when crypto sells off, the bills are still worth par. apxUSD inverts that property. Its dominant leg is a Bitcoin-correlated preferred share, so a crypto drawdown weakens the reserve at the same instant redemption pressure rises. The collateral and the stress share a common factor, and a common factor is exactly what a stablecoin reserve is supposed to avoid.",
        "The buffer could not cover the gap. With roughly 38% in cash and Treasuries against roughly 62% in the volatile leg, even a moderate markdown on STRC pushes net collateral toward, or through, the value of apxUSD outstanding before the buffer is exhausted. The cash sleeve is enough to clear an orderly trickle of redemptions; it is not enough to defend par when the majority of the reserve is falling in lockstep with the broader market. The June low near $0.865 is what that arithmetic looks like under stress.",
        "This is the structural cousin of pmUSD's gold-RWA fragility: in both cases the headline is a real-world asset, and in both cases the peg depends on a layer whose value the token holder cannot independently pin down or convert on demand. apxUSD's chain runs apxUSD → preferred shares → a Bitcoin-treasury company → Bitcoin, and a shock anywhere along it propagates straight up to the token.",
      ],
    },
    {
      heading: "Who can actually arbitrage the peg",
      paragraphs: [
        "A healthy dollar holds par because arbitrage is cheap and symmetric: below $1, someone redeems for a dollar of value; above $1, someone mints and sells. apxUSD weakens both legs. Minting is an attested-minter flow: an OpenZeppelin AccessManager gates a Gnosis Safe (3-of-6) and a backend-signed MinterV0 contract, with an externally-owned account as admin. Supply is created by a small set of controllers on signed orders, not by open arbitrage. Redemption is whitelisted: only approved participants mint and redeem against the protocol directly. Retail holders do not have that door.",
        "For everyone else, the exit is the secondary market, and apxUSD's secondary market is a set of Curve pools that the March upside spike already showed to be thin. When the whitelisted rebalancers cannot or will not buy the discount back to par (because doing so means warehousing a falling, Bitcoin-correlated reserve), the price discovers itself against whatever depth the pools provide. That is why the discount has persisted for weeks rather than snapping back: the participants who can redeem at par are not the participants holding the token, and the ones holding it can only sell into a shallow book.",
        "Transparency around the reserve is real-time but lightly attested. Apyx publishes a live Accountable feed, but Pharos records the proof-of-reserve as coming from a niche attestor with no monthly attestation, and the GENIUS-compliance review returns no public authorization, a Terms of Service that disclaims the customary legal meaning of its own financial terminology, and a BVI domicile that blocks U.S. persons. None of that caused the depeg, but it shapes what a holder can enforce when the price is below par.",
      ],
    },
    {
      heading: "How Pharos saw it",
      paragraphs: [
        "The signal was structural before it was a price. Pharos scores apxUSD's collateral quality as RWA with a single-entity governance posture, flags the STRC and SATA legs as high-risk in the live reserve map, and routes the asset through the RWA-credit-fund mechanism rather than treating it as a cash-backed dollar. Those classifications are why a token that spent its first months near par still carried structural caution rather than a clean bill of health.",
        "When the incident opened, the live surfaces moved together. The depeg resolver flagged the June 2 downside event and has kept it open with no recovery print; DEWS sits at WATCH (29/100) and Safety at D (49/100); and the supply trend turned negative, down about 8.6% over thirty days, as redemptions and exits shrank the float. The peg and liquidity sub-scores (65 and 60 across 17 pools) capture a token that can still clear sellers, but only at a standing discount. apxUSD also appears inside other protocols' reserves as Pendle PT collateral, so its stress is a dependency worth tracing on the map, not only a price on its own page.",
      ],
    },
    {
      heading: "Lessons",
      paragraphs: [
        "The asset-class label is not the risk profile. 'RWA-backed' tells you what the reserve is made of; it does not tell you whether the reserve holds value when the peg is tested. The question that matters is correlation: a dollar backed by an instrument that falls with crypto carries the same factor risk as the market it trades in, and it will weaken exactly when holders most want par. A buffer sized below the volatile leg cannot change that: it can delay the discount, not prevent it.",
        "Redemption access is part of the peg. When direct mint-and-redeem is whitelisted and retail's only exit is a thin secondary market, the arbitrage that normally pins par is gated to a few participants whose incentive to defend the floor evaporates precisely when the reserve is falling. And when an issuer describes a depeg as expected behaviour rather than a break, take the statement literally: it is telling you the design permits the price to move with its collateral. apxUSD remains live, but its still-open June incident is a clean illustration of what happens when a stablecoin's reserve and its stress share a common cause.",
      ],
    },
  ],
  dataWidgets: [
    {
      kind: "peg-deviation",
      coinId: "apxusd-apyx",
      caption:
        "apxUSD's peg-deviation history on Pharos. The June 2026 incident opened from the June 2 snapshot, first drove the token into the low-$0.90s, and later printed an all-time low near $0.865 on June 18.",
    },
  ],
  watchpoints: [
    "STRC and Bitcoin: the ~62% Strategy-preferred leg is the dominant reserve risk, and its value tracks Bitcoin and Strategy's ability to service its preferred; a crypto drawdown weakens collateral and peg together.",
    "Buffer adequacy: whether Apyx grows the cash and T-Bill sleeve relative to the volatile preferred-equity leg, or the ~38%/62% split that failed to defend par in June persists.",
    "Redemption access and Curve depth: direct redemption is whitelisted, so retail exits through a thin secondary market. Watch whether the whitelisted rebalancers and POL actually buy the discount back toward par.",
    "Incident resolution: the June depeg has no recovery print and supply is shrinking; a return to par versus a continued managed discount is the difference between wounded and worse.",
    "Attestation and disclosure: a niche attestor with no monthly attestation, no public GENIUS authorization, and a ToS that disclaims its own financial terminology limit what a holder can enforce below par.",
  ],
  crossLinks: [
    {
      href: "/learn/mechanisms/rwa-credit-fund/",
      label: "Mechanism: tokenized credit and RWA-backed dollars",
    },
    {
      href: "/stablecoin/apxusd-apyx/",
      label: "apxUSD coin page",
    },
    {
      href: "/learn/case-studies/pmusd-precious-metals/",
      label: "Case study: pmUSD's exotic-RWA fragility",
    },
    {
      href: "/dependency-map/",
      label: "Dependency map: where apxUSD's collateral and DeFi exposure connect",
    },
  ],
  sources: [
    {
      label: "CoinDesk: Apyx's STRC collateralized stablecoin suffers a brief depeg (June 4, 2026)",
      href: "https://www.coindesk.com/markets/2026/06/04/apyx-s-stablecoin-suffers-a-brief-depeg-protocol-says-its-a-feature-not-bug",
    },
    {
      label: "Apyx: apxUSD product overview",
      href: "https://docs.apyx.fi/product-overview/apxusd-overview",
    },
    {
      label: "Apyx: collateral, custody, and transparency",
      href: "https://docs.apyx.fi/collateral-and-custody/transparency",
    },
    {
      label: "Apyx: Accountable real-time reserve dashboard",
      href: "https://accountable.apyx.fi/",
    },
    {
      label: "Apyx: Terms of Service (BVI; financial terms disclaimed; U.S. persons blocked)",
      href: "https://docs.apyx.fi/resources/terms-of-service",
    },
  ],
  metaDescription:
    "apxUSD's RWA-backed dollar is ~62% Bitcoin-correlated Strategy preferred equity; when crypto fell in June 2026 it slid below $0.90 and is still depegged.",
  datePublished: "2026-06-15",
};
