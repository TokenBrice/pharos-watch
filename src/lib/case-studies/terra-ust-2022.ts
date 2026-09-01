import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "terra-ust-2022",
  eyebrow: "Algorithmic collapse",
  title: "TerraUSD: the death spiral that erased $18 billion",
  subtitle:
    "An uncollateralized mint-burn stablecoin propped up by a 20% yield unwound in six days, hyperinflating LUNA and dragging UST to a dime.",
  lead: [
    "TerraUSD held its dollar peg through reflexivity, not reserves. The protocol let anyone burn $1 of UST to mint $1 of its sister token LUNA, or burn $1 of LUNA to mint one UST. As long as LUNA carried a deep, confident market, that two-way convertibility kept UST near par. The design had no cash, no Treasuries, and no collateral pool to fall back on, only the assumption that LUNA's market capitalization would stay comfortably larger than the UST it was meant to absorb.",
    "Most of the demand was rented. Anchor, Terra's flagship lending market, advertised a roughly 20% yield on UST deposits, and by spring 2022 around three-quarters of all UST sat parked there. That yield was subsidized rather than earned, and the subsidy reserve was visibly draining. When a wave of withdrawals hit a thinning on-chain liquidity base in early May, UST slipped below a dollar and the convertibility mechanism, designed to defend the peg, instead became the accelerant.",
    "Within a week UST had fallen to the ~$0.10 dime level by May 12 and kept sliding toward a few cents in the sessions that followed, LUNA's supply ballooned from a few hundred million tokens into the trillions, and the Terra chain was halted twice to fend off a governance takeover. Peak UST market value of roughly $18.7B was effectively gone, and the shock rippled outward: USDT briefly traded under a dollar, MIM wobbled, and several leveraged crypto lenders later failed.",
  ],
  takeaways: [
    "An uncollateralized mint-burn peg defended only by a sister token (LUNA) has no floor: the same convertibility that holds par in calm markets becomes an unlimited dilution engine in a run.",
    "Demand was rented, not earned: ~75% of UST sat in Anchor chasing a subsidized ~20% yield, so the float left together the moment that subsidy looked unsustainable.",
    "Once LUNA's market cap fell below the UST it backstopped, the math guaranteed not everyone could exit at par; spending the LFG Bitcoin reserve only delayed recognition.",
    "At roughly $18.7B peak value erased it remains the largest stablecoin failure on record, and its contagion (USDT, MIM, leveraged lenders) reset how the market reads reflexive backing.",
  ],
  relatedCoins: [
    {
      coinId: "usdt-tether",
      note: "Largest fiat-backed stablecoin; briefly traded near $0.95 on 2022-05-12 as redemptions spiked during the Terra contagion, then reclaimed par.",
    },
    {
      coinId: "mim-abracadabra",
      note: "CDP stablecoin with Terra-linked collateral exposure; wobbled to roughly $0.98 on 2022-05-12, with a deeper $0.93 break arriving in a later June 2022 stress.",
    },
  ],
  archetype: "algorithmic",
  outcome: "died",
  eventDateLabel: "May 2022",
  eventWindow: {
    startISO: "2022-05-07",
    endISO: "2022-05-13",
    peakDeviationBps: -9900,
    lowPrice: 0.1,
  },
  cemeteryId: "ust-terrausd-2022-05",
  timeline: [
    {
      dateISO: "2022-05-07",
      headline: "First withdrawals and a Curve imbalance push UST below par",
      body: "Large holders pulled hundreds of millions of UST out of Anchor and swapped sizeable blocks into other stablecoins on Curve. The thinning of the main on-chain pool nudged UST under a dollar for the first time, an early signal that demand was concentrated and the exit was narrow.",
      severity: "med",
    },
    {
      dateISO: "2022-05-08",
      headline: "Anchor outflows accelerate; the peg defense begins",
      body: "Deposits drained from Anchor at a pace the subsidy model could not absorb. The Luna Foundation Guard began deploying its reserves (including a multi-billion-dollar Bitcoin stockpile assembled earlier in the year) to buy UST and steady the peg.",
      severity: "high",
    },
    {
      dateISO: "2022-05-09",
      headline: "Reserves spent, peg breaks decisively",
      body: "Roughly a third of all UST in Anchor was withdrawn in a single day. The foundation sold large tranches of Bitcoin to fund UST purchases, but selling the reserve into a falling market depleted it without restoring confidence. UST detached from a dollar and did not recover.",
      severity: "high",
    },
    {
      dateISO: "2022-05-10",
      headline: "The mint-burn loop turns into a death spiral",
      body: "With par redemption gone, holders rushed the only remaining exit: burning UST to mint LUNA. Each burn minted fresh LUNA at a collapsing price, so the protocol issued ever more tokens to honor each redemption. LUNA's supply began inflating exponentially as its price cratered.",
      severity: "high",
    },
    {
      dateISO: "2022-05-11",
      headline: "LUNA market cap falls below UST in circulation",
      body: "Cumulative Anchor withdrawals passed eleven billion UST. Once LUNA was worth less than the UST it was supposed to backstop, the math guaranteed that not every holder could exit at par: the reflexive backing had inverted.",
      severity: "high",
    },
    {
      dateISO: "2022-05-12",
      headline: "LUNA hyperinflates; the Terra chain is halted",
      body: "LUNA fell more than 96% as supply expanded from a few hundred million tokens toward the trillions. Validators halted the Terra blockchain near block 7,603,700 to prevent a cheap governance takeover, since so little of the inflated supply was still staked. UST traded around a dime.",
      severity: "high",
    },
    {
      dateISO: "2022-05-13",
      headline: "Second halt and a delegation freeze; UST near zero",
      body: "The chain was halted again and patched to disable LUNA delegations, locking down governance while assets remained on the network. LUNA was effectively worthless and UST kept falling below the ~$0.10 dime level of May 12 toward a few cents in later sessions. Peak UST value of roughly $18.7B had been erased.",
      severity: "high",
    },
  ],
  sections: [
    {
      id: "what-happened",
      heading: "What happened",
      paragraphs: [
        "UST was a seigniorage-style algorithmic stablecoin: no reserve account stood behind it, only an arbitrage relationship with LUNA. Holders could always burn one UST to mint a dollar's worth of LUNA, and vice versa, so when UST drifted off par the protocol expected traders to close the gap for profit. That worked while LUNA was large and liquid relative to UST.",
        "In early May 2022 a cluster of withdrawals and large stablecoin swaps hit at the same moment liquidity was unusually thin. UST slipped below a dollar, and instead of arbitrage quietly restoring the peg, the redemption mechanism began minting LUNA into a falling market. The faster holders fled, the more LUNA the protocol printed, and the cheaper LUNA became, a self-reinforcing loop with no floor.",
        "By 2022-05-13 the system had unwound completely. LUNA's supply had hyperinflated by orders of magnitude, the chain had been halted to protect what remained, and UST's roughly $18.7B peak was effectively wiped out. It remains the largest stablecoin failure on record and the canonical example of an algorithmic peg breaking.",
        "Pharos does not surface UST on a public coin page, but it preserves the asset's historical price and supply series as a shadow record so the collapse continues to inform the Pharos Stability Index calibration.",
      ],
    },
    {
      id: "mint-burn-doom-loop",
      heading: "The mint-burn doom loop",
      paragraphs: [
        "The convertibility that kept UST at a dollar in calm markets is the same mechanism that destroyed it under stress. Burning UST minted a fixed dollar value of LUNA regardless of LUNA's price, so as LUNA fell, each redemption required minting more and more tokens. Supply that started in the hundreds of millions ran into the trillions within days.",
        "The fatal threshold was reached when LUNA's total market value dropped below the UST still in circulation. At that point the backing token could no longer absorb the stablecoin it was meant to support, and rational holders all tried to exit before the value drained away. The result was a classic bank run with no reserve and no lender of last resort: only an algorithm that responded to selling by issuing more of an already-collapsing asset.",
        "This is the structural signature an algorithmic peg carries by design: the stabilizer is a volatile sister token, and the same arbitrage that defends the peg upward will dilute it downward without limit. Pharos flags this exposure through PegScore and the DEWS early-warning surface, which weight reflexive, uncollateralized backing as a high-fragility configuration.",
      ],
    },
    {
      id: "why-anchors-yield-mattered",
      heading: "Why Anchor's yield mattered",
      paragraphs: [
        "Demand for UST was not organic; it was largely manufactured by Anchor's advertised yield of roughly 20%. By spring 2022, on the order of three-quarters of all circulating UST was deposited in Anchor chasing that rate, which concentrated the entire stablecoin's float in a single venue with a single exit.",
        "The yield was a subsidy, not a return. The reserve funding those payouts was draining at a rate measured in millions of dollars a day, and the community had already begun stepping the rate down, signaling that the headline number could not last. When the rate outlook softened and large depositors started leaving, the withdrawal pressure landed on a peg with no collateral and a narrow liquidity base.",
        "The lesson generalizes beyond Terra: a stablecoin whose demand depends on an above-market, subsidized yield is renting its float rather than earning it. When the subsidy thins, the deposits leave together, and a concentrated venue turns an orderly drawdown into a run. Pharos tracks yield-driven supply concentration as a structural-resilience input rather than treating high yield as a strength.",
      ],
    },
    {
      id: "contagion",
      heading: "Contagion",
      paragraphs: [
        "Terra was deeply wired into the rest of crypto, so the collapse did not stay contained. As redemptions spiked on 2022-05-12, even the largest fiat-backed stablecoin wobbled: USDT briefly traded near $0.95 on some venues before market makers arbitraged it back to par. The deviation was shallow and short-lived, but it showed how a single algorithmic failure can stress otherwise unrelated, reserve-backed assets.",
        "Crypto-collateralized stablecoins took direct damage. MIM, the Abracadabra CDP stablecoin, wobbled to roughly $0.98 during the Terra window as collateral values and confidence dropped together, then suffered a deeper break in later June stress. The shock then propagated into leveraged credit: several large lenders and funds carrying Terra exposure or correlated positions failed in the weeks and months that followed.",
        "The episode reset how the market and regulators viewed stablecoin risk. It drew a sharp line between assets backed by liquid reserves and assets backed by their own reflexivity, and it became the reference case in subsequent stablecoin rulemaking and risk frameworks.",
      ],
    },
    {
      id: "lessons",
      heading: "Lessons",
      paragraphs: [
        "An uncollateralized peg defended only by a sister token has no floor. The same convertibility that holds the line in calm markets becomes a dilution engine in a run, and once the backing token's market value falls below the stablecoin's float, the design cannot make every holder whole. Reflexive backing should be read as a fragility, not a feature.",
        "Subsidized yield is a demand mirage. When most of a stablecoin's supply sits in one venue chasing an above-market rate that the issuer pays out of reserves, the float is borrowed and will leave on the same signal. Concentration of supply and the source of its yield matter as much as the headline market cap.",
        "Reserve-defense buys time, not solvency. Spending a Bitcoin treasury into a falling market drained the reserve without changing the underlying mechanism. A peg that depends on continuous intervention is already broken; the intervention only delays recognition.",
      ],
    },
  ],
  watchpoints: [
    "An algorithmic stablecoin whose peg defense depends on minting a volatile sister token: the backing absorbs volatility upward but dilutes without limit downward.",
    "Supply concentration in a single yield venue, especially when that yield is subsidized rather than earned and the reserve funding it is draining.",
    "The backing token's market capitalization approaching or falling below the stablecoin's circulating value, the point past which par redemption cannot hold for all holders.",
    "Issuer reserve-defense operations (selling a treasury to buy the peg) that arrest price only briefly, signaling the underlying mechanism is failing.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/algorithmic/", label: "How algorithmic stablecoins work" },
    { href: "/learn/case-studies/iron-titan-2021/", label: "Case study: IRON Finance, the algorithmic prequel" },
    { href: "/cemetery/", label: "Stablecoin cemetery" },
    { href: "/stablecoin/usdt-tether/", label: "USDT: Tether (contagion contact)" },
  ],
  sources: [
    {
      label: "CoinDesk: Terra/UST reporting",
      href: "https://www.coindesk.com/tech/2022/05/11/usts-do-kwon-was-behind-earlier-failed-stablecoin-ex-terra-colleagues-say",
    },
    {
      label: "TechCrunch: Terra halts its blockchain to prevent hacks",
      href: "https://techcrunch.com/2022/05/12/terra-halts-its-blockchain-to-prevent-hacks-ust/",
    },
    {
      label: "Harvard Law / MIT CFI: Anatomy of a Run: The Terra Luna Crash",
      href: "https://corpgov.law.harvard.edu/2023/05/22/anatomy-of-a-run-the-terra-luna-crash/",
    },
    {
      label: "Chainalysis: How TerraUSD collapsed",
      href: "https://www.chainalysis.com/blog/how-terrausd-collapsed/",
    },
    {
      label: "Federal Reserve: Interconnected DeFi: Ripple Effects from the Terra Collapse",
      href: "https://www.federalreserve.gov/econres/feds/files/2023044pap.pdf",
    },
  ],
  metaDescription:
    "How TerraUSD's uncollateralized mint-burn peg unwound in May 2022: Anchor's 20% yield, the LUNA death spiral, the chain halt, and the USDT/MIM contagion.",
  datePublished: "2026-05-23",
};
