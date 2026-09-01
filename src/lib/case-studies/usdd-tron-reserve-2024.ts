import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "usdd-tron-reserve-2024",
  eyebrow: "Reflexive collateral",
  title: "USDD: when the issuer pulled the Bitcoin",
  subtitle:
    "No dramatic depeg. The shock was structural: the TRON DAO Reserve quietly withdrew ~12,000 BTC, leaving USDD backed almost entirely by TRX, before a 2025 redesign into an overcollateralized CDP.",
  lead: [
    "USDD did not break its dollar peg in this episode. What changed was the backing behind it. Through mid-2024 the TRON DAO Reserve's published transparency page listed roughly 12,000 BTC (worth about $726 million at the time) among the assets standing behind USDD. In August 2024 that Bitcoin disappeared from the listed collateral, on-chain trackers traced it moving to the HTX exchange, and USDD was left backed largely by TRX, the native token of the chain it lives on.",
    "That is the structural flaw Terra made famous, in a milder form: collateral correlated to the issuer's own ecosystem. A stablecoin backed by its sponsor's governance or gas token has no independent floor: if confidence in the ecosystem falls, the backing falls with the thing it is meant to absorb. Reports put the post-withdrawal mix at roughly 98% TRX, with a small USDT remainder. The Bitcoin had been the one large, exogenous, uncorrelated reserve asset, and it was gone.",
    "The change was contested on process as much as substance. The withdrawal was announced from Justin Sun's personal account rather than the reserve, with no recorded DAO vote, which sharpened a long-running transparency and centralization critique. The stablecoin-rating outfit Bluechip had already assigned USDD its lowest grade, citing exactly this TRX reliance. USDD survived as a live token, and in January 2025 it relaunched as USDD 2.0: an overcollateralized, on-chain CDP. The redesign is real, but the underlying TRX-correlation concern did not fully go away, which is why this study reads USDD as wounded, not dead.",
  ],
  takeaways: [
    "USDD did not depeg here. The event is a backing and transparency shift: ~12,000 BTC (~$726M) was removed from the TRON DAO Reserve in August 2024, leaving USDD backed roughly 98% by TRX.",
    "Backing correlated to the issuer's own ecosystem token is Terra's structural flaw in milder form: the collateral has no independent floor and falls in the same crisis it is meant to absorb.",
    "Process compounded substance: the change was announced from a personal account with no recorded DAO vote, reinforcing a transparency critique already flagged by Bluechip's lowest stablecoin grade.",
    "The January 2025 USDD 2.0 redesign into an overcollateralized on-chain CDP is a genuine structural improvement, but TRX-correlation remains a live concern: wounded, not dead.",
  ],
  primaryCoinId: "usdd-tron-dao-reserve",
  relatedCoins: [
    {
      coinId: "dai-makerdao",
      note: "The CDP contrast. Justin Sun framed the Bitcoin withdrawal as MakerDAO-style (a collateral holder freely withdrawing surplus above the required ratio). But Dai's collateral is a diversified, exogenous mix (real-world assets, ETH, stablecoins) deliberately uncorrelated with MKR, the governance token. USDD's post-withdrawal backing was concentrated in TRX, the issuer's own ecosystem asset. That is the same MakerDAO mechanics over collateral that does not share Dai's independence from its sponsor.",
    },
  ],
  archetype: "cdp",
  outcome: "wounded",
  eventDateLabel: "2024-2025",
  eventWindow: {
    startISO: "2024-08-19",
    endISO: "2025-01-25",
  },
  timeline: [
    {
      dateISO: "2023-07-13",
      headline: "Antecedent: Bluechip assigns USDD its lowest grade",
      body: "Before the Bitcoin episode, the stablecoin-rating firm Bluechip rated USDD at the bottom of its stability scale, citing heavy reliance on TRX and weak transparency. The critique that would define the 2024 controversy was already on record.",
      severity: "low",
      href: "https://bluechip.org/en/news/stablecoin-rating-platform-bluechip-launches",
    },
    {
      dateISO: "2024-08-19",
      headline: "~12,000 BTC removed from the TRON DAO Reserve",
      body: "The roughly 12,000 BTC (about $726 million) that had been listed on USDD's transparency page disappeared from the published collateral. On-chain trackers traced a large portion moving to the HTX exchange. The withdrawal left USDD backed predominantly by TRX.",
      severity: "high",
      href: "https://decrypt.co/246054/justin-suns-usdd-stablecoin-loses-bitcoin-backing",
    },
    {
      dateISO: "2024-08-22",
      headline: "Backlash over governance and transparency",
      body: "The change drew immediate criticism because it surfaced through Justin Sun's personal account rather than a TRON DAO Reserve announcement, with no recorded DAO vote on a roughly $726M reserve decision, hardening doubts about how decentralized the reserve really was.",
      severity: "med",
      href: "https://www.theblock.co/post/312708/justin-suns-usdd-stablecoin-is-no-longer-backed-by-bitcoin",
    },
    {
      dateISO: "2024-08-23",
      headline: "Sun: removal was 'DeFi 101'; backing now ~98% TRX",
      body: "Sun defended the move as routine, arguing USDD had run a 300%-plus collateralization that was capital-inefficient and comparing it to a MakerDAO vault holder withdrawing surplus. With the Bitcoin gone, reports put the backing at roughly 98% TRX plus a small USDT remainder.",
      severity: "med",
    },
    {
      dateISO: "2025-01-25",
      headline: "USDD 2.0 relaunches as an overcollateralized CDP",
      body: "USDD 2.0 launched on TRON, replacing the earlier hybrid-algorithmic, subsidy-dependent model with an overcollateralized Collateralized Debt Position design: users mint USDD against TRX, sTRX, and USDT in publicly verifiable vaults, with permissionless liquidations and a PSM for 1:1 swaps. The legacy token continued to redeem 1:1.",
      severity: "low",
    },
  ],
  sections: [
    {
      id: "what-happened",
      heading: "What happened",
      paragraphs: [
        "For much of its life USDD's published reserves included a large Bitcoin position: on the order of 12,000 BTC, worth roughly $726 million in August 2024. That holding was the reserve's single largest asset that had nothing to do with the TRON ecosystem: an exogenous, deeply liquid store of value that could hold its worth even if TRX did not.",
        "In August 2024 that Bitcoin was removed from the listed collateral. On-chain analysts traced a large share of it moving to the HTX exchange, and the announcement came from Justin Sun's personal account rather than the TRON DAO Reserve, with no recorded governance vote on a decision of that size. What remained behind USDD was overwhelmingly TRX (reports cited roughly 98%) alongside a small USDT position.",
        "Crucially, the token did not lose its peg in the process. USDD continued to trade near a dollar throughout. The event here is not a price collapse but a change in the quality and independence of the backing, and the governance questions that surrounded how that change was made.",
      ],
    },
    {
      id: "reflexive-collateral",
      heading: "Reflexive collateral",
      paragraphs: [
        "The structural problem is that the remaining backing was correlated to the issuer. TRX is TRON's native token; its value rises and falls with confidence in the same ecosystem that issues USDD. A stablecoin backed mostly by its sponsor's own asset has no independent floor; in the precise scenario where you would most want hard backing, a loss of faith in the ecosystem, the collateral is falling for the very same reason.",
        "This is the flaw that destroyed Terra, in a milder and non-algorithmic form. UST had no reserve at all, only a reflexive mint-burn relationship with LUNA, so a run hyperinflated the backing token without limit. USDD does hold real collateral and never relied on that doom loop, but removing the uncorrelated Bitcoin leg pushed it toward the same family of risk: the asset standing behind the dollar promise is wired to the issuer rather than independent of it.",
        "Pharos treats issuer-correlated collateral as a structural fragility rather than a neutral design choice. Backing that moves with the sponsor's own token is weighted as lower-quality collateral in resilience scoring, because diversification away from the issuer is what gives a peg something to lean on when the issuer's ecosystem is the thing under stress.",
      ],
    },
    {
      id: "transparency-problem",
      heading: "The transparency problem",
      paragraphs: [
        "The substance of the change was compounded by how it was made. A roughly $726 million reserve decision surfaced through an individual's social-media account, not through the entity nominally responsible for the reserve, and without a governance vote on record. For a project that markets itself around a decentralized reserve, that gap between the decentralization claim and the observed control was the sharper story.",
        "It also validated an earlier warning. The rating firm Bluechip had already placed USDD at the bottom of its stability scale, citing precisely the TRX concentration and the thin transparency that the Bitcoin withdrawal then put on full display. A published transparency page is only as useful as the governance behind the assets it lists; here the page changed and the assets moved, with little in the way of binding process to explain or constrain it.",
        "The durable lesson is that reserve transparency is two things, not one: the disclosure of what backs a coin, and the governance that controls whether that backing can change unilaterally. A dashboard that lists Bitcoin today tells you little if a single party can move it tomorrow without a vote.",
      ],
    },
    {
      id: "usdd-2-0-redesign",
      heading: "The USDD 2.0 redesign",
      paragraphs: [
        "In January 2025 USDD relaunched as USDD 2.0, a materially different system. The earlier model leaned on TRON DAO subsidies and hybrid-algorithmic mechanics; the new one is an overcollateralized Collateralized Debt Position protocol. Users lock TRX, sTRX, or USDT into publicly verifiable vaults and mint USDD against them under enforced minimum collateral ratios, with undercollateralized vaults cleared through permissionless liquidations and a Peg Stability Module offering 1:1 swaps against USDT and USDC.",
        "This is a real improvement on the structure that drew the 2024 criticism. On-chain, auditable collateral with rule-based liquidations and no discretionary subsidy is a stronger foundation than an opaque reserve a single party can rebalance off-platform. By the protocol's own one-year review, collateral value stayed above circulating supply through 2025 and most vaults ran well above their minimum ratios.",
        "What the redesign does not erase is the correlation concern. TRX and sTRX remain core collateral, so a sharp, ecosystem-wide drawdown in TRX would still stress the system through liquidations and vault health, even with the CDP guardrails working as intended. The mechanism is sturdier; the dependence on the issuer's own asset is reduced and governed, but not removed.",
      ],
    },
    {
      id: "lessons",
      heading: "Lessons",
      paragraphs: [
        "Collateral quality is about independence, not just amount. A high headline collateralization ratio means little if the collateral is the issuer's own ecosystem token, because that backing falls in the same crisis it is meant to cushion. Removing the one uncorrelated reserve asset can weaken a stablecoin structurally even when its price never moves. That is why this is read as a wounding, not a death.",
        "Transparency is disclosure plus governance. Listing reserves on a page is necessary but not sufficient; what matters is whether a single party can move those reserves without a binding vote. The USDD episode is a clean example of a published reserve changing through an off-platform decision, and of why Pharos tracks the control over reserves alongside their composition.",
        "A redesign can fix the mechanism without fully fixing the exposure. USDD 2.0's overcollateralized, on-chain CDP is a genuine step up from the model it replaced, but core collateral still skews toward TRX and sTRX. The structural improvement is real and worth crediting; the residual issuer-correlation is real too, and is the reason the durable signal here remains how much of a coin's backing is independent of the entity that issues it.",
      ],
    },
  ],
  dataWidgets: [
    {
      kind: "peg-deviation",
      coinId: "usdd-tron-dao-reserve",
      caption:
        "USDD's daily peg history on Pharos. Note that the August 2024 event was a backing change, not a price break. The line stays near a dollar, which is exactly the point: the risk was structural, not a depeg.",
    },
  ],
  watchpoints: [
    "Collateral correlated to the issuer's own ecosystem token (here, TRX), which has no independent floor and falls in the same crisis it is meant to absorb.",
    "Whether a single party can move or remove listed reserves without a binding governance vote, the gap between a decentralization claim and observed control.",
    "Reserve transparency as governance, not just disclosure: a published reserve page tells you little if the assets behind it can change unilaterally and off-platform.",
    "Residual issuer-correlation after a redesign: even an overcollateralized CDP stays exposed if its core vault collateral is concentrated in the sponsor's own asset.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/cdp/", label: "How CDP stablecoins work" },
    { href: "/learn/case-studies/terra-ust-2022/", label: "Case study: Terra, the reflexive-collateral cautionary tale" },
    { href: "/stablecoin/usdd-tron-dao-reserve/", label: "USDD overview" },
  ],
  sources: [
    {
      label: "The Block: Justin Sun's USDD stablecoin is no longer backed by bitcoin",
      href: "https://www.theblock.co/post/312708/justin-suns-usdd-stablecoin-is-no-longer-backed-by-bitcoin",
    },
    {
      label: "Decrypt: Justin Sun's USDD Stablecoin Loses Bitcoin Backing",
      href: "https://decrypt.co/246054/justin-suns-usdd-stablecoin-loses-bitcoin-backing",
    },
    {
      label: "Bluechip: Stablecoin rating platform launch, including USDD rating context",
      href: "https://bluechip.org/en/news/stablecoin-rating-platform-bluechip-launches",
    },
    {
      label: "CryptoRank: TRON DAO loses Bitcoin backing",
      href: "https://cryptorank.io/news/feed/6363d-tron-dao-loses-bitcoin-backing",
    },
    {
      label: "Protos: Justin Sun's USDD removes 12,000 BTC without DAO approval",
      href: "https://protos.com/justin-suns-usdd-removes-12000-btc-without-dao-approval/",
    },
    {
      label: "Messari: USDD One Year After 2.0: Yield, Peg Stability, and Multichain Execution",
      href: "https://messari.io/report/usdd-one-year-after-2-0",
    },
  ],
  metaDescription:
    "USDD didn't depeg. In August 2024 the TRON DAO Reserve pulled ~12,000 BTC, leaving it ~98% TRX-backed, before a 2025 redesign into an overcollateralized CDP.",
  datePublished: "2026-06-15",
};
