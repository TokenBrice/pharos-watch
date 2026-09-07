import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "usdx-kava-2022",
  eyebrow: "Collateral contagion",
  title: "Kava USDX: one toxic collateral leg",
  subtitle:
    "An overcollateralized CDP dollar broke its peg in May 2022 because a single whitelisted collateral asset, TerraUSD, collapsed, and it never durably recovered.",
  lead: [
    "USDX was Kava Mint's crypto-collateralized dollar, minted as overcollateralized debt against a basket of accepted assets. By design it was the opposite of an algorithmic peg: every USDX in circulation was backed by collateral worth more than the debt it secured, with liquidations meant to retire under-water positions before they could threaten par. On paper, that structure should have absorbed the May 2022 shock. It did not.",
    "The flaw was on the whitelist. Kava Mint accepted TerraUSD (UST) as collateral alongside KAVA, ATOM, wrapped Bitcoin, and Ether. When UST entered its death spiral in May 2022 (detaching on May 7-8 and collapsing more than 90% in a week toward roughly $0.10), the positions backed by UST became instantly under-collateralized. The liquidation machinery fired into a market with no bid for the toxic asset, and the cascade dragged USDX off its dollar peg. It fell to about $0.47 mid-week before a partial bounce to roughly $0.89 and a renewed slide to around $0.56.",
    "Kava governance voted to remove UST from Kava Mint, and the team, citing USDX's non-algorithmic collateralized design, said the peg would return once UST was out of the system. It never did. The acute break gave way to a slow fade: USDX languished well below a dollar for years, with a recorded all-time low near $0.10, and traded around $0.70 on negligible volume by mid-2026. It is the first died-CDP case in this library: an overcollateralized stablecoin killed not by its mechanism but by one bad name on its collateral list.",
  ],
  takeaways: [
    "Overcollateralization is only as sound as the worst asset on the collateral whitelist, not a blanket safeguard. One toxic collateral leg (UST) was terminal even though USDX was nominally over-backed.",
    "The same liquidation engine that defends a CDP peg in normal markets becomes the transmission channel when a whitelisted collateral asset goes to zero: positions go under-water instantly and liquidations fire into a market with no bid.",
    "USDX was structurally distinct from UST (collateralized, not algorithmic), yet it shared UST's fate by holding UST. Composition risk, not mechanism risk, did the damage.",
    "Removing the bad collateral by governance vote stopped further bleeding but did not restore confidence: USDX never durably reclaimed par and faded to a near-defunct discount asset.",
  ],
  primaryCoinId: "usdx-kava",
  archetype: "cdp",
  outcome: "died",
  eventDateLabel: "May 2022",
  eventWindow: {
    startISO: "2022-05-11",
    endISO: "2022-05-13",
    peakDeviationBps: -5300,
    lowPrice: 0.47,
  },
  timeline: [
    {
      dateISO: "2022-05-08",
      headline: "UST begins its death spiral; Kava Mint's whitelist is exposed",
      body: "TerraUSD detached from a dollar over May 7-8 and began its uncontrolled collapse. Because UST was an accepted collateral asset in Kava Mint, every USDX position backed by UST started losing its margin of safety as the collateral itself headed toward a dime.",
      severity: "med",
    },
    {
      dateISO: "2022-05-11",
      headline: "Cascading liquidations drag USDX off peg",
      body: "As UST cratered more than 90% in a week, the USDX positions it collateralized went under-water and were liquidated into a market with no bid for UST. Kava Labs attributed the depeg to USDX's UST exposure; the liquidations transmitted the shock straight to the stablecoin.",
      severity: "high",
    },
    {
      dateISO: "2022-05-11",
      headline: "USDX falls to roughly $0.47",
      body: "USDX dropped to about $0.47 around mid-week, a deviation on the order of 5,300 bps below par, before staging a partial recovery. Its market value had been above $115 million before the break, per CoinGecko.",
      severity: "high",
    },
    {
      dateISO: "2022-05-12",
      headline: "A brittle bounce and a renewed slide",
      body: "USDX recovered toward roughly $0.89 within about a day, then slid again to around $0.56. The round-trip showed the peg was being held up by intervention and hope rather than by a restored collateral base.",
      severity: "high",
    },
    {
      dateISO: "2022-05-13",
      headline: "Governance votes UST out of Kava Mint",
      body: "The Kava community passed majority votes to begin removing UST from Kava Mint so USDX could no longer be minted against it. Kava Labs CEO Scott Stuart called the UST exposure isolated and said USDX, being collateralized rather than algorithmic, was expected to repeg once UST left the system.",
      severity: "med",
    },
    {
      dateISO: "2023-05-01",
      headline: "The peg never returns",
      body: "Removing the toxic collateral stopped further contagion but did not restore confidence or par. Through 2023 and beyond, USDX traded persistently below a dollar, well off the $1 mark its CDP mechanism was designed to defend.",
      severity: "med",
    },
    {
      dateISO: "2026-05-11",
      headline: "Effectively defunct",
      body: "Years on, USDX still trades at a deep discount: around $0.70 with a market cap near $78 million and daily volume in the low thousands of dollars. It survives as a legacy debt token on Kava Mint rather than a functioning stablecoin, with a recorded all-time low near $0.10.",
      severity: "low",
    },
  ],
  sections: [
    {
      id: "what-happened",
      heading: "What happened",
      paragraphs: [
        "Kava Mint let users lock crypto collateral and draw USDX against it as overcollateralized debt, with liquidations retiring positions that fell below their required ratio. The accepted-collateral set included TerraUSD (UST) alongside KAVA, ATOM, wrapped Bitcoin, and Ether. That whitelist was a governance decision, and it is where the failure originated.",
        "When UST collapsed in May 2022, the USDX positions it backed lost their collateral value almost overnight. Liquidations fired to defend the system, but they were selling a collapsing asset into a market that no longer wanted it, so they recovered little and did nothing to reassure holders. USDX broke to about $0.47, bounced to roughly $0.89, and slid back near $0.56, the signature of a peg being propped up rather than structurally restored.",
        "Kava governance voted UST out of Kava Mint and the team predicted a clean repeg, on the logic that USDX was collateralized rather than algorithmic. The prediction was wrong. The mechanism was indeed sound; the collateral list was not, and the loss of confidence outlived the bad asset that caused it.",
      ],
    },
    {
      id: "collateral-whitelist-as-an-attack-surface",
      heading: "The collateral whitelist as an attack surface",
      paragraphs: [
        "A CDP stablecoin does not choose its risk by mechanism alone; it chooses it by what it accepts as collateral. Every asset added to the whitelist is a potential failure path, because the stablecoin inherits that asset's worst-case behavior the moment it is locked against new debt. Adding UST imported the full fragility of an uncollateralized algorithmic peg into a system whose whole pitch was that it was not algorithmic.",
        "This is the part the headline design obscures. USDX's own contract behaved exactly as intended: positions that breached their ratio were liquidated. But correctness of the liquidation engine is irrelevant if the collateral it is unwinding has no floor. The whitelist, not the code, set the true risk surface, and a single entry on it was enough to be terminal.",
        "Pharos treats collateral composition as a first-class risk input rather than reading overcollateralization as a uniform strength. A CDP coin's resilience depends on the quality and correlation of what backs it, which is why collateral quality and dependency exposure are scored separately from the nominal collateral ratio.",
      ],
    },
    {
      id: "why-overcollateralization-didnt-save-it",
      heading: "Why overcollateralization didn't save it",
      paragraphs: [
        "Overcollateralization protects against ordinary price moves: if collateral drifts down a few tens of percent, liquidations close positions while there is still surplus value to cover the debt. It is a buffer sized for volatility, not for a collateral asset going to near-zero faster than the system can unwind it.",
        "UST did not drift; it gapped. The collateral backing a slice of USDX lost more than 90% of its value in days, blowing through any reasonable liquidation ratio before the auctions could clear. When a buffer is overwhelmed by a discontinuous move in the collateral itself, the surplus that was supposed to make the stablecoin whole simply is not there, and the liquidation process converts a collateral failure directly into a peg failure.",
        "The deeper lesson is that overcollateralization and collateral quality are different risks. A position can be 150% collateralized and still be unsafe if that 150% is denominated in an asset capable of becoming worthless. The ratio measures how much collateral there is; it says nothing about whether that collateral will still exist tomorrow.",
      ],
    },
    {
      id: "slow-fade",
      heading: "The slow fade",
      paragraphs: [
        "Acute depegs usually resolve one of two ways: the coin recovers to par, or it is wound down. USDX did neither cleanly. The toxic collateral was removed and the contagion stopped, but the peg never came back, and the token was not retired. It settled into a long half-life as a discounted legacy claim.",
        "By later years USDX traded persistently below a dollar, with a recorded all-time low near $0.10 and a market value that drifted down with its credibility. As of mid-2026 it changes hands around $0.70 with a market cap near $78 million and daily volume measured in the low thousands of dollars. It is present in the data, but no longer functioning as a stablecoin in any meaningful sense.",
        "This is why the case is filed as died rather than wounded. A wounded stablecoin takes structural damage and goes on operating near par; USDX lost the one property that defined it and never got it back. The CDP machinery still runs, but what it produces is no longer a dollar.",
      ],
    },
    {
      id: "lessons",
      heading: "Lessons",
      paragraphs: [
        "One toxic collateral asset can be terminal even under nominal overcollateralization. The mechanism's soundness is bounded by the worst name on the whitelist, so collateral hygiene (what is accepted, in what size, and how correlated it is) is the real safety control, not the headline collateral ratio.",
        "Liquidation systems defend a peg only against collateral that retains a market. When a whitelisted asset gaps toward zero, the same auctions that normally protect the stablecoin become the channel that transmits the collateral's collapse straight into the peg. A CDP coin should be read through the fragility of its collateral set, not the elegance of its liquidation design.",
        "Recovery is about confidence, not just plumbing. Removing the bad collateral repaired the mechanism but not the market's belief in it, and a stablecoin that has visibly broken once can fade indefinitely below par even after the proximate cause is gone. Restoring the code is necessary but not sufficient; restoring trust is the harder, slower problem.",
      ],
    },
  ],
  watchpoints: [
    "Collateral whitelists that accept other stablecoins as backing, especially algorithmic or reflexively-backed ones, importing the worst-case behavior of an asset that can go to near-zero.",
    "Concentration and correlation within a CDP collateral set: how much of the float is backed by a single asset, and whether that asset can gap faster than liquidations can clear.",
    "Liquidation assumptions that presume a liquid market for the collateral; a collapsing asset has no bid, so auctions recover little and transmit rather than contain the shock.",
    "A coin that recovers part-way after a break but never durably reclaims par. A brittle bounce followed by a renewed slide signals a peg held up by intervention, not by restored backing.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/cdp/", label: "How CDP stablecoins work" },
    { href: "/stablecoin/usdx-kava/", label: "USDX (Kava) overview" },
    {
      href: "/learn/case-studies/terra-ust-2022/",
      label: "Case study: TerraUSD, the collateral that killed it",
    },
  ],
  sources: [
    {
      label: "The Block: Kava Network's USDX tumbles to $0.65 as yet another stablecoin depegs (May 13, 2022)",
      href: "https://www.theblock.co/post/146802/kava-networks-usdx-tumbles-to-0-65-as-yet-another-stablecoin-depegs",
    },
    {
      label: "CryptoAdventure: Kava USDX Suffers Devaluation as UST Continues Implosion",
      href: "https://cryptoadventure.com/kava-usdx-suffers-devaluation-as-ust-continues-implosion/",
    },
    {
      label: "Kava Help Center: What is Kava Mint?",
      href: "https://help.app.kava.io/article/15-what-is-kava-mint",
    },
    {
      label: "CoinGecko: USDX (Kava) price, market cap, and all-time low",
      href: "https://www.coingecko.com/en/coins/usdx",
    },
  ],
  metaDescription:
    "Kava USDX broke peg in May 2022 because UST, a whitelisted collateral asset, collapsed. USDX fell to ~$0.47 and never recovered. One bad leg was terminal.",
  datePublished: "2026-06-15",
};
