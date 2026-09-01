import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "usdc-svb-2023",
  eyebrow: "Reserve banking shock",
  title: "USDC and the Silicon Valley Bank weekend",
  subtitle:
    "A fully-reserved dollar stablecoin lost its peg for two days in March 2023, not because its backing failed, but because one of the banks holding that backing did.",
  lead: [
    "On the weekend of March 10-13, 2023, USDC traded as low as roughly $0.87, a peak deviation near 1,300 bps below par and the largest the issuer had ever recorded. The cause sat one layer below the token: about $3.3 billion of Circle's cash reserves were deposited at Silicon Valley Bank, which entered FDIC receivership on Friday, March 10.",
    "USDC was not undercollateralized in any structural sense. Treasuries and repo continued to back the bulk of the float. What broke was access: with primary redemptions paused over a weekend and roughly 8% of the cash leg trapped at a failed bank, the secondary market repriced the token for the uncertainty of whether those deposits would be recovered.",
    "They were. After the Treasury, Federal Reserve, and FDIC jointly guaranteed all SVB deposits on Sunday, March 12, the deviation closed quickly and USDC traded at parity again by the March 13 New York session. The episode is studied here as a banking-channel concentration event, not a backing failure, and as the clearest case of fiat-stablecoin contagion propagating into DeFi.",
  ],
  takeaways: [
    "USDC fell to ~$0.87 not because its backing failed but because access did: ~$3.3B (~8% of the cash leg) was trapped at the failed Silicon Valley Bank and primary redemption paused over a weekend.",
    "Reserve quality and reserve access are different risks: a fully, conservatively reserved coin can still depeg if part of the backing is briefly unreachable.",
    "Hard-coded $1 plumbing spread the shock: Dai (via the PSM, to ~$0.85), FRAX (~$0.88), and alUSD all inherited the deviation by composition, the clearest case of fiat-stablecoin contagion into DeFi.",
    "The recovery was a policy decision (a federal deposit backstop), not a structural feature of the token; the durable signal is named-bank reserve composition and disclosure cadence.",
  ],
  primaryCoinId: "usdc-circle",
  relatedCoins: [
    {
      coinId: "dai-makerdao",
      note: "Dai held roughly half of its collateral in USDC through MakerDAO's Peg Stability Module, so it inherited the depeg almost one-for-one, falling to about $0.85 as the PSM turned from a stabilizer into an exit ramp. A governance vote to throttle the USDC PSM passed within hours but could not take effect until after the weekend because of the 48-hour timelock.",
    },
    {
      coinId: "frax-frax",
      note: "Frax was partially backed by USDC and, by design, valued each collateral asset at a hardcoded $1 for redemption. With its USDC leg impaired and the system below full reserve at the time, FRAX tracked the shock downward to roughly $0.88 before recovering with USDC.",
    },
    {
      coinId: "alusd-alchemix",
      note: "alUSD's self-repaying loans are collateralized by stablecoin deposits routed into yield strategies, including DAI and USDC. With both of those reference assets dislocated over the weekend, alUSD's peg was exposed to the same secondary-market repricing rather than to any fault in the Alchemix mechanism.",
    },
  ],
  archetype: "fiat-cash",
  outcome: "survived",
  eventDateLabel: "March 2023",
  eventWindow: {
    startISO: "2023-03-10",
    endISO: "2023-03-13",
    peakDeviationBps: -1300,
    lowPrice: 0.87,
  },
  depegEventSlug: "usdc-2023-03-11",
  timeline: [
    {
      dateISO: "2020-03-12",
      headline: "Antecedent: Black Thursday liquidity squeeze",
      body: "During the market-wide crash of March 12, 2020, USDC dipped to roughly $0.97 amid a scramble for on-chain dollars. The move was minor and self-correcting, but it foreshadowed how fiat-backed tokens reprice on liquidity stress even when their reserves are intact.",
      severity: "low",
    },
    {
      dateISO: "2023-03-10",
      headline: "SVB enters receivership; Circle discloses exposure",
      body: "Silicon Valley Bank was taken into FDIC receivership on Friday, March 10. Late that day Circle disclosed that about $3.3 billion of the USDC reserve (roughly 8% of the cash backing) was held at the bank and could not be withdrawn. Primary-market redemption queues stalled.",
      severity: "med",
      href: "https://www.circle.com/pressroom/3-3-billion-of-usdc-reserve-risk-removed-dollar-de-peg-closes",
    },
    {
      dateISO: "2023-03-11",
      headline: "Secondary-market low near $0.87",
      body: "With redemptions effectively paused into the weekend, selling pressure moved to secondary markets. USDC fell from $1.00 to a low near $0.87 on March 11, a peak deviation around 1,300 bps below peg and the largest ever recorded for the issuer. Curve's 3pool saw record volume as holders rotated out of USDC.",
      severity: "high",
      href: "https://www.circle.com/pressroom/3-3-billion-of-usdc-reserve-risk-removed-dollar-de-peg-closes",
    },
    {
      dateISO: "2023-03-12",
      headline: "Federal deposit backstop announced",
      body: "On Sunday, March 12, the Treasury, Federal Reserve, and FDIC jointly invoked a systemic-risk exception to make all SVB depositors whole, with access to funds promised for Monday. Circle confirmed it expected to recover the full $3.3 billion, and the deviation began to close immediately.",
      severity: "med",
      href: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20230312b.htm",
    },
    {
      dateISO: "2023-03-13",
      headline: "Peg restored",
      body: "By the March 13 New York session USDC was trading at parity again, under two days after the low. Contagion in Dai, FRAX, and the other USDC-exposed coins unwound on the same recovery.",
      severity: "low",
    },
  ],
  sections: [
    {
      id: "what-happened",
      heading: "What happened",
      paragraphs: [
        "USDC is a fiat-backed stablecoin: each token is meant to be redeemable 1:1 against a reserve of short-dated Treasuries, overnight repo, and cash. The cash leg is the part that lives inside the conventional banking system, spread across a small set of commercial banks. Silicon Valley Bank was one of those banks.",
        "When SVB failed and was placed into receivership on March 10, the roughly $3.3 billion Circle held there became inaccessible pending resolution. That was a small share of the total reserve, but it was enough, combined with paused primary redemptions over a weekend, to inject genuine uncertainty about same-day, full-value redemption. The secondary market did what markets do with uncertainty: it discounted the token until the question was resolved.",
      ],
    },
    {
      id: "why-a-fully-reserved-coin-still-broke",
      heading: "Why a fully-reserved coin still broke",
      paragraphs: [
        "The lesson here is not that USDC was undercollateralized. It was that even an over-reserved, transparently attested stablecoin is only as liquid as the weakest link in its redemption path. For a fiat-backed coin, that path runs through commercial banks that keep limited weekend hours and can themselves fail.",
        "Two factors amplified the move. First, banking-channel concentration: a meaningful slice of the cash leg sat at a single institution, so one bank's failure impaired a measurable fraction of immediately-accessible backing. Second, redemption timing: primary mint and burn ran on banking hours while secondary trading ran around the clock, so price discovery happened on venues that could not arbitrage back to par until the banks reopened.",
        "Transparency cut both ways. Circle's prior disclosures let the market quickly size the exposure at about 8% of reserves rather than fear the worst, but that same precision is what let the secondary market price the gap so sharply and so fast.",
      ],
    },
    {
      id: "contagion-through-defi",
      heading: "Contagion through DeFi",
      paragraphs: [
        "USDC is not just a token people hold; it is collateral and plumbing for much of on-chain finance. Any protocol that treated USDC as a hard dollar inherited the depeg directly. The cleanest channel was MakerDAO's Peg Stability Module, which let users swap USDC for Dai 1:1. With roughly half of Dai's collateral in USDC, the PSM passed the discount straight through and Dai fell with it, while a corrective governance vote sat behind a 48-hour timelock until after the worst had passed.",
        "Frax propagated the shock through a different mechanism: it held USDC in its backing and valued collateral at a hardcoded $1 for redemption, so an impaired USDC leg dragged FRAX to roughly $0.88. alUSD, whose collateral routes through DAI- and USDC-denominated yield strategies, was exposed to the same dislocation by composition rather than by any flaw in its own design.",
        "Capital that fled the USDC-exposed cluster flowed toward coins seen as unexposed, and tokens like USDT briefly traded above par on the rotation. The episode is a reference case for how a single fiat issuer's banking incident becomes a system-wide event once that issuer is wired into DeFi as base collateral. Pharos models this propagation explicitly in the dependency map.",
      ],
    },
    {
      id: "lessons",
      heading: "Lessons",
      paragraphs: [
        "Reserve quality and reserve access are different risks. A coin can be fully and conservatively reserved and still depeg if part of the backing is briefly unreachable. Monitoring should track not only what backs a coin but where the cash leg is custodied and how concentrated it is.",
        "The recovery was contingent, not automatic. A federal backstop over a specific weekend restored the peg; that is a policy decision, not a structural feature of the token, and it should not be treated as a repeatable guarantee. The durable signal from March 2023 is the named-bank composition of cash reserves and the disclosure cadence around it, exactly the kind of exposure Pharos surfaces through reserve transparency tracking rather than through any single price print.",
      ],
    },
  ],
  dataWidgets: [
    {
      kind: "peg-deviation",
      coinId: "usdc-circle",
      caption:
        "USDC's daily peg history on Pharos. The marker pins the March 2023 SVB weekend. Daily snapshots show the deviation but understate the intraday low near $0.87.",
    },
  ],
  watchpoints: [
    "Banking-channel concentration: how many commercial banks hold the cash leg of a fiat-backed reserve, and how much sits at the largest single counterparty.",
    "Redemption availability across weekends and holidays, when primary mint/burn pauses but secondary markets keep trading and pricing.",
    "Composability exposure: protocols that hard-code a stablecoin to $1 (PSMs, fixed-price redemption) pass any depeg straight through to their own token.",
    "Disclosure cadence and named-bank reserve composition in attestations, which is what lets the market size an incident quickly rather than fear the worst.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/fiat-cash/", label: "Mechanism: fiat-cash stablecoins" },
    { href: "/depeg/usdc-2023-03-11/", label: "Depeg record: USDC, March 11, 2023" },
    { href: "/learn/case-studies/dai-black-thursday/", label: "Case study: how the same weekend hit Dai" },
    { href: "/dependency-map/", label: "Stablecoin dependency map" },
    { href: "/stablecoin/usdc-circle/", label: "USDC overview" },
  ],
  sources: [
    {
      label: "Circle: $3.3B of USDC reserve risk removed; dollar depeg closes",
      href: "https://www.circle.com/pressroom/3-3-billion-of-usdc-reserve-risk-removed-dollar-de-peg-closes",
    },
    {
      label: "Federal Reserve: Joint Statement by Treasury, Federal Reserve, and FDIC (March 12, 2023)",
      href: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20230312b.htm",
    },
    {
      label: "FDIC: Joint Statement on Silicon Valley Bank and Signature Bank",
      href: "https://www.fdic.gov/news/press-releases/2023/pr23017.html",
    },
    {
      label: "Federal Reserve: In the Shadow of Bank Runs: SVB and its impact on stablecoins",
      href: "https://www.federalreserve.gov/econres/notes/feds-notes/in-the-shadow-of-bank-run-lessons-from-the-silicon-valley-bank-failure-and-its-impact-on-stablecoins-20251217.html",
    },
  ],
  metaDescription:
    "USDC fell to ~$0.87 in March 2023 when $3.3B of Circle's reserves were trapped at the failed Silicon Valley Bank: a banking shock, not a backing failure.",
  datePublished: "2026-05-23",
};
