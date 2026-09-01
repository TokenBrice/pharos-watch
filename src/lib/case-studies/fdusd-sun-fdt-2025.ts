import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "fdusd-sun-fdt-2025",
  eyebrow: "Reflexive bank run",
  title: "FDUSD and the insolvency tweet",
  subtitle:
    "A fully-reserved dollar stablecoin lost its peg for hours in April 2025, not because its backing failed, but because a high-profile competitor publicly called its custodian insolvent and the market ran first and checked later.",
  lead: [
    "On April 2, 2025, Tron founder Justin Sun posted on X that First Digital Trust (FDT), the Hong Kong custodian behind the FDUSD stablecoin, was \"effectively insolvent and unable to fulfill client fund redemptions,\" urging users to secure their assets immediately. FDUSD, a fiat-backed token meant to redeem 1:1 against short-dated US Treasuries, cash, and overnight deposits, fell to roughly $0.87 within hours (about a 13% deviation, near 1,300 bps below par).",
    "Nothing in FDUSD's reserve had changed. The claim grew out of a separate dispute over TUSD: Sun alleged that FDT had moved about $456 million of custodial client funds tied to TrueUSD to a private entity in Dubai without authorization. FDUSD's own reserve attestation with a March 1, 2025 record date put reserves at roughly $2.05 billion, primarily US Treasury bills and overnight term deposits, against about $2.04 billion of issued tokens; FDUSD was not the subject of the dispute. The depeg was a counterparty-trust event: holders priced the risk that the entity custodying their backing might be impaired, regardless of what that backing actually was.",
    "FDT denied the allegations as a \"malicious\" smear, reaffirmed that FDUSD was fully backed and redeemable, kept processing redemptions, and filed a defamation claim against Sun in Hong Kong's High Court. On-chain data showed the issuer honored roughly $26 million of FDUSD redemptions in the days after the post. The peg recovered toward $0.98 and higher. The episode is studied here as the reflexive social-media bank run, distinct from USDC's March 2023 depeg, where a bank holding the reserve genuinely failed.",
  ],
  takeaways: [
    "FDUSD fell to ~$0.87 within hours of an April 2, 2025 tweet calling its custodian First Digital Trust \"effectively insolvent\"; the reserve itself never changed.",
    "The allegation grew out of a separate ~$456M TUSD custody dispute, not FDUSD; FDUSD's March 1, 2025 attestation put reserves near $2.05B, mostly US Treasury bills and overnight term deposits, against ~$2.04B issued.",
    "Custodian counterparty trust is its own risk axis: a fiat-backed coin can depeg on doubt about who holds the backing, not just on what the backing is.",
    "FDT denied the claim, processed ~$26M of redemptions, filed a defamation suit, and FDUSD recovered toward $0.98+: recovery came from honored redemptions, not a policy backstop.",
  ],
  primaryCoinId: "fdusd-first-digital",
  relatedCoins: [
    {
      coinId: "tusd-trueusd",
      note: "TrueUSD, not FDUSD, was the actual subject of the dispute. Sun's allegation centered on roughly $456 million of TUSD-linked custodial funds he said First Digital Trust had moved to a Dubai entity without authorization. FDUSD shared the same custodian, so the market treated a TUSD-custody question as an FDUSD solvency question; the contagion ran through the trustee, not through any shared collateral.",
    },
    {
      coinId: "usdc-circle",
      note: "On Binance, where the large majority of FDUSD float trades, the FDUSD/USDC pair reportedly dislocated further than the headline ~$0.87 low, to around $0.76 in thin moments, as holders rotated into USDC as the safe-haven dollar. USDC's own backing was never in question; it simply absorbed the flight from a coin whose custodian had just been called insolvent.",
    },
  ],
  archetype: "fiat-cash",
  outcome: "wounded",
  eventDateLabel: "April 2025",
  eventWindow: {
    startISO: "2025-04-02",
    endISO: "2025-04-09",
    peakDeviationBps: -1300,
    lowPrice: 0.87,
  },
  timeline: [
    {
      dateISO: "2025-04-02",
      headline: "Justin Sun calls First Digital Trust \"insolvent\"",
      body: "Tron founder Justin Sun posted on X that First Digital Trust was \"effectively insolvent and unable to fulfill client fund redemptions,\" urging users to secure their assets. The claim grew out of a separate TUSD custody dispute, not FDUSD's reserve, but it named FDUSD's custodian directly.",
      severity: "high",
      href: "https://blockworks.co/news/fdusd-depeg-sun-justin-insolvency-stablecoin",
    },
    {
      dateISO: "2025-04-02",
      headline: "FDUSD falls to ~$0.87 within hours",
      body: "FDUSD dropped from $1.00 to roughly $0.87 (about a 13% deviation, near 1,300 bps below peg) within hours of the post. On Binance, which hosts the large majority of FDUSD's float, the FDUSD/USDC pair reportedly traded as low as ~$0.76 in thin moments as holders rotated into safer dollars.",
      severity: "high",
    },
    {
      dateISO: "2025-04-02",
      headline: "First Digital denies, cites ~$2.05B in reserves",
      body: "First Digital Trust rejected the claim as false and malicious, said the dispute concerned TUSD rather than FDUSD, and stated FDUSD remained fully backed and redeemable. FDUSD's attestation with a March 1, 2025 record date put reserves near $2.05 billion, primarily US Treasury bills and overnight term deposits, against roughly $2.04 billion of issued FDUSD.",
      severity: "med",
    },
    {
      dateISO: "2025-04-03",
      headline: "Redemptions honored; peg begins to recover",
      body: "First Digital kept processing redemptions to demonstrate solvency; on-chain data showed roughly $26 million (about $25.8M on Etherscan) of FDUSD redeemed in the days following the post. With redemption working, the secondary-market discount closed and FDUSD traded back toward $0.98 and higher.",
      severity: "med",
      href: "https://cointelegraph.com/news/first-digital-redeems-26m-fdusd-after-stablecoin-depeg",
    },
    {
      dateISO: "2025-04-09",
      headline: "Sun escalates; First Digital serves defamation claim",
      body: "Sun doubled down, alleging FDT had transferred roughly $456 million of custodial client funds to a Dubai entity, and announced a $50 million bounty. First Digital served Sun with a defamation claim in Hong Kong's High Court (Case No. HCA 680), seeking an injunction and damages. The dispute remained unresolved well beyond the depeg.",
      severity: "med",
      href: "https://www.coindesk.com/policy/2025/04/09/first-digital-trust-serves-justin-sun-with-defamation-claim",
    },
  ],
  sections: [
    {
      id: "what-happened",
      heading: "What happened",
      paragraphs: [
        "FDUSD is a fiat-backed stablecoin: each token is meant to be redeemable 1:1 against a reserve of short-dated US Treasury bills, overnight deposits, and cash, held by First Digital Trust, a Hong Kong custodian. The reserve sits below the token, and the entity that holds and attests to that reserve is the custodian. FDUSD's design depends on trusting that custodian to keep the backing intact and to honor redemptions on demand.",
        "On April 2, 2025, Justin Sun, a competitor in the stablecoin market and the figure who had earlier backstopped TUSD, publicly declared that First Digital Trust was \"effectively insolvent\" and could not meet client redemptions. He told users to pull their assets. Within hours FDUSD fell from $1.00 to roughly $0.87, a deviation near 1,300 bps, and on Binance's FDUSD/USDC pair it reportedly dislocated further, toward $0.76 in thin trading, before stabilizing.",
      ],
    },
    {
      id: "custodian-counterparty-risk",
      heading: "Custodian counterparty risk",
      paragraphs: [
        "The accusation was not, strictly, about FDUSD. It grew out of a dispute over TrueUSD: Sun alleged that First Digital Trust had moved roughly $456 million of TUSD-linked custodial funds to a private entity in Dubai without authorization. FDUSD's reserve (attested near $2.05 billion in T-bills and overnight term deposits against about $2.04 billion issued, using a March 1, 2025 record date) was a separate pool. But FDUSD and TUSD shared the same trustee, so a question about how that trustee handled one client's money read, to the market, as a question about its solvency overall.",
        "This is the counterparty-trust axis that fiat-backed designs cannot escape. A token can be fully and conservatively reserved and still depeg if holders lose confidence in the institution that custodies the reserve and stands behind redemption. The asset that matters is not only what backs the coin but who holds it, who can move it, and whether that party's other obligations are sound. When the custodian's integrity is in doubt, every token it backs inherits the doubt.",
      ],
    },
    {
      id: "reflexive-run-a-tweet-versus-a-bank-failure",
      heading: "The reflexive run: a tweet versus a bank failure",
      paragraphs: [
        "This is the cleanest counterexample to USDC's March 2023 depeg. There, a bank holding part of the reserve actually failed: about $3.3 billion of Circle's cash was genuinely trapped at Silicon Valley Bank, and the discount priced a real, measurable impairment. Here, no reserve was impaired. The depeg priced a claim, amplified by the reach of the person making it and by the structure of where FDUSD trades.",
        "Two features made the run reflexive. First, concentration of venue: on-chain estimates put the large majority of FDUSD's roughly $2.2 billion supply on Binance, so price discovery happened on a single exchange's order books where a coordinated exit could move the print fast and far. Second, the messenger: an allegation from a prominent, interested party carried enough credibility that holders chose to sell first and verify later. The cheaper it is to exit and the louder the warning, the more a stablecoin's price reflects narrative rather than backing, at least until redemption proves the backing is real.",
      ],
    },
    {
      id: "recovery-via-redemption",
      heading: "Recovery via redemption",
      paragraphs: [
        "What closed the gap was not a policy backstop or an external rescue but the redemption mechanism working as designed. First Digital reaffirmed that FDUSD was fully backed, pointed to its T-bill reserve report, and, crucially, kept burning tokens against dollars. On-chain data showed roughly $26 million of FDUSD redeemed in the days after the post, each redemption a demonstration that par was available to anyone who wanted it.",
        "Once redemption was visibly honored, the arbitrage that should close any discount on a redeemable coin reasserted itself: buying FDUSD below par and redeeming at $1 was profitable, so the discount could not persist. FDUSD recovered toward $0.98 and beyond. First Digital then went on the offensive, serving Sun with a defamation claim in Hong Kong's High Court, seeking an injunction and damages. The legal dispute outlasted the depeg by far, but the peg itself was restored within days, by the issuer honoring its own promise rather than by anyone changing the reserve.",
      ],
    },
    {
      id: "lessons",
      heading: "Lessons",
      paragraphs: [
        "Custodian counterparty trust is a distinct risk from reserve quality. A coin can hold conservative, fully-sized T-bill reserves and still depeg if the market doubts the institution that holds them, especially when that institution backs other tokens whose own affairs are contested. Monitoring should track not just what backs a coin but who custodies it, what else that custodian is responsible for, and how exposed the issuer is to a single trustee.",
        "Reflexive runs are a structural feature of liquid, venue-concentrated fiat-backed coins, not an anomaly. A credible accusation can move the price faster than any reserve fact can rebut it, because exiting is cheap and the cost of being wrong is asymmetric. The durable defense is the same one that ended this episode: open, working redemption. A coin that can prove par on demand recovers from a narrative shock; a coin that cannot does not. The signal to watch is therefore redemption availability and custodian transparency, not the price print during the panic, which reflects who is talking as much as what is true.",
      ],
    },
  ],
  dataWidgets: [
    {
      kind: "peg-deviation",
      coinId: "fdusd-first-digital",
      caption:
        "FDUSD's daily peg history on Pharos. The marker pins the April 2025 insolvency-tweet depeg. Daily snapshots show the deviation but understate the intraday low near $0.87 and the deeper FDUSD/USDC dislocation on Binance.",
    },
  ],
  watchpoints: [
    "Custodian concentration: whether one trustee holds the reserves for multiple tokens, so a dispute over one client's funds can spill into another coin's peg.",
    "Venue concentration: how much of a coin's float trades on a single exchange, where a coordinated or narrative-driven exit can move the price far before arbitrage corrects it.",
    "Redemption availability during stress: whether primary redemption stays open and is visibly honored, which is what ends a reflexive run rather than any single price print.",
    "Reserve transparency and disclosure cadence: named-composition attestations let the market size a counterparty claim quickly instead of pricing the worst case.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/fiat-cash/", label: "Mechanism: fiat-cash stablecoins" },
    { href: "/learn/case-studies/usdc-svb-2023/", label: "Case study: when a real bank failure broke USDC" },
    { href: "/stablecoin/fdusd-first-digital/", label: "FDUSD overview" },
    { href: "/stablecoin/tusd-trueusd/", label: "TUSD overview" },
  ],
  sources: [
    {
      label: "Blockworks: Justin Sun's allegations of FDUSD insolvency cause depeg",
      href: "https://blockworks.co/news/fdusd-depeg-sun-justin-insolvency-stablecoin",
    },
    {
      label: "Cointelegraph: First Digital redeems $26M after FDUSD depeg, dismisses Sun insolvency claims",
      href: "https://cointelegraph.com/news/first-digital-redeems-26m-fdusd-after-stablecoin-depeg",
    },
    {
      label: "CoinDesk: First Digital Trust serves Justin Sun with defamation claim",
      href: "https://www.coindesk.com/policy/2025/04/09/first-digital-trust-serves-justin-sun-with-defamation-claim",
    },
    {
      label: "First Digital Labs: Transparency and FDUSD reserve reports",
      href: "https://www.firstdigitallabs.com/transparency",
    },
    {
      label: "Binance Square: FDUSD audit report summary with March 1, 2025 record date",
      href: "https://www.binance.com/en/square/post/22395282658474",
    },
    {
      label: "The Defiant: Justin Sun declares First Digital Trust insolvent, FDUSD depegs as Binance holds $1.67B",
      href: "https://thedefiant.io/news/cefi/justin-sun-declares-first-digital-trust-insolvent-fdusd-depegs-binance-holds-1-fcdb4d5a",
    },
  ],
  metaDescription:
    "FDUSD fell to ~$0.87 in April 2025 after Justin Sun called custodian First Digital Trust insolvent: a reflexive run on counterparty trust, not a backing fault.",
  datePublished: "2026-06-15",
};
