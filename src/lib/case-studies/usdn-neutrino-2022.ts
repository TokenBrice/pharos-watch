import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "usdn-neutrino-2022",
  eyebrow: "Algorithmic collapse",
  title: "Neutrino USD: the stablecoin collapse before Terra",
  subtitle:
    "A WAVES-collateralized algorithmic stablecoin that broke peg in April 2022 on circular-leverage allegations, never durably recovered, and was quietly retired as the floating index token XTN.",
  lead: [
    "Neutrino USD (USDN) was an algorithmic stablecoin in the Waves ecosystem, not the US-centric DeFi mainstream. Its dollar peg rested on a single reflexive collateral asset: WAVES, the Waves chain's native token. Users locked WAVES in Neutrino's smart contracts to mint USDN, and redeeming USDN destroyed it to unlock WAVES. That single-token backing meant the stablecoin's solvency tracked WAVES' market value one-for-one. WAVES had just run up more than 200% over March 2022, from roughly $19 to a record near $60, lifting USDN's circulating value toward the billion-dollar mark.",
    "On 31 March 2022 the on-chain analyst 0xHamZ alleged a circular leverage loop: the Waves team was said to be borrowing USDC and USDT against USDN on Vires.finance, the dominant Waves lending market, buying WAVES with the proceeds, staking that WAVES to mint fresh USDN, and borrowing again, a self-funding cycle that pumped WAVES on borrowed money. The accompanying warning was arithmetic: if WAVES fell far enough that its market cap dropped below the USDN outstanding, USDN was insolvent, and a large USDC short on Vires could be forced to liquidate roughly $607M of the ~$875M USDN supply. Waves founder Sasha Ivanov denied it and blamed a coordinated short campaign by Alameda Research.",
    "The peg broke on 4 April 2022. USDN fell about 15% to the low-$0.80s (press reports put the spot near $0.82 against a market cap that slid to ~$824M from a year-to-date high near $960M), with some venues printing intraday lows reported in the $0.66 to $0.76 range before a partial bounce. Ivanov proposed clamping WAVES/USDN liquidation thresholds and the protocol held emergency votes, but USDN never durably reclaimed a dollar. A second break followed in May during the Terra contagion, the protocol tried recapitalization through SURF, and the project ultimately abandoned the $1 peg entirely, rebranding USDN to the floating Neutrino Index Token (XTN), which trades around a few cents today and is effectively dead. The full collapse landed about five weeks before TerraUSD: the same reflexive failure mode, a smaller stage, and a warning the wider market read as a Waves-specific accident.",
  ],
  takeaways: [
    "USDN's peg was backed by a single reflexive asset, WAVES, so its solvency tracked one volatile token's market cap; the same run-up that lifted USDN toward a billion dollars set up the fall.",
    "The trigger was a circular-leverage allegation: borrow stablecoins against USDN on Vires, buy WAVES, stake it to mint more USDN, borrow again: a self-referential loop that inflated both legs on credit.",
    "The arithmetic was the warning: once WAVES' market cap risked falling below USDN outstanding, the stablecoin was insolvent and a large Vires short could force-liquidate the float.",
    "It broke about five weeks before Terra with the identical reflexive death-spiral structure, yet was dismissed as a Waves-ecosystem accident rather than a category warning.",
  ],
  archetype: "algorithmic",
  outcome: "died",
  eventDateLabel: "April 2022",
  eventWindow: {
    startISO: "2022-03-31",
    endISO: "2022-05-11",
    lowPrice: 0.66,
  },
  cemeteryId: "usdn-neutrino-usd-2022-04",
  timeline: [
    {
      dateISO: "2022-03-01",
      headline: "WAVES begins a parabolic run",
      body: "WAVES traded near $19 at the start of March 2022. Over the month it climbed more than 200%, becoming one of the best-performing tokens with a market cap above $1 billion. Because USDN was minted by locking WAVES, the rally lifted the stablecoin's circulating value toward the billion-dollar range, and tied its solvency ever more tightly to a single volatile asset.",
      severity: "low",
    },
    {
      dateISO: "2022-03-31",
      headline: "Circular-leverage allegations surface; the peg starts to wobble",
      body: "On-chain analyst 0xHamZ alleged the Waves team was running a self-funding loop on Vires.finance: borrowing USDC/USDT against USDN, buying WAVES, staking it to mint more USDN, and borrowing again. The thread warned that if WAVES' market cap fell below USDN outstanding, USDN was insolvent and a ~$607M slice of the ~$875M supply could be force-liquidated. WAVES peaked near $60 the same day and the USDN peg began to slip.",
      severity: "high",
    },
    {
      dateISO: "2022-04-03",
      headline: "Founder proposes clamping liquidation thresholds",
      body: "Sasha Ivanov dismissed the allegations and blamed Alameda Research for a short-driven media campaign, arguing a multi-billion-dollar daily market could not be moved by borrowing a few million. He launched a governance proposal to limit WAVES and USDN liquidation thresholds to 0.1%, which critics said would squeeze short-sellers at the expense of WAVES holders.",
      severity: "high",
    },
    {
      dateISO: "2022-04-04",
      headline: "USDN breaks peg to the low-$0.80s",
      body: "USDN fell roughly 15% to the low-$0.80s, with press reports putting the spot near $0.82 as its market cap dropped to about $824M from a year-to-date high near $960M. Some venues printed sharper intraday lows reported in the $0.66 to $0.76 range before a partial recovery toward $0.88. The protocol still claimed a backing ratio of 2.62, but confidence, not stated collateral, was the binding constraint.",
      severity: "high",
    },
    {
      dateISO: "2022-05-11",
      headline: "A second break during the Terra contagion",
      body: "As TerraUSD collapsed, the crisis spread back to USDN. It slipped its peg again, falling roughly 12% to the high-$0.80s on the day, while WAVES dropped sharply alongside it. The May episode confirmed that the April recovery had restored price but not the structural trust the peg depended on.",
      severity: "high",
    },
    {
      dateISO: "2022-08-08",
      headline: "SURF recapitalization attempts to repair the reserve",
      body: "The protocol introduced SURF, a Smart Utility Recapitalization Feature token meant to recapitalize USDN reserves when the backing ratio was below target. It was a repair layer for undercollateralization, not a restoration of the single-asset peg's original credibility.",
      severity: "med",
      href: "https://medium.com/neutrinoteam/what-is-surf-and-why-is-it-important-for-the-neutrino-ecosystem-8962c2230049",
    },
    {
      dateISO: "2023-02-15",
      headline: "USDN abandons the dollar peg and becomes XTN",
      body: "Conceding that USDN could not withstand the market's volatility, the Neutrino community voted to drop the $1 peg and rebrand the asset as the Neutrino Index Token (XTN), a floating token backed by a basket of Waves-ecosystem assets rather than a single-asset stablecoin. The transition plan targeted a complete rebrand around mid-February 2023.",
      severity: "med",
    },
    {
      dateISO: "2023-06-01",
      headline: "Effectively dead as a floating index token",
      body: "Stripped of its peg, the renamed token traded far below a dollar and its supply was wound down sharply over 2023. It has since lingered around a few cents and is widely listed as inactive, a stablecoin that did not so much recover as cease to be one.",
      severity: "med",
    },
  ],
  sections: [
    {
      heading: "What happened",
      paragraphs: [
        "Neutrino USD was an algorithmic, crypto-collateralized stablecoin on the Waves blockchain, pegged to the dollar but backed by WAVES rather than cash or Treasuries. Minting one USDN required locking a dollar's worth of WAVES in Neutrino's contracts; redeeming USDN burned it to release WAVES. The arrangement borrowed the language of over-collateralization (the protocol cited a backing ratio above 2), but the collateral was a single reflexive token whose value moved with the same sentiment that drove demand for the stablecoin.",
        "Through March 2022 WAVES rallied more than 200% to a record near $60, and USDN's circulating value swelled toward roughly a billion dollars. On 31 March an on-chain analyst published a detailed allegation that the rally was being financed by a circular leverage loop on Vires.finance, and that the structure left USDN one sharp WAVES drawdown away from insolvency. The peg began wobbling immediately.",
        "On 4 April USDN broke, falling about 15% into the low-$0.80s with reported intraday lows materially deeper, while its market cap slid roughly $130M+ from its recent high. The founder framed it as an Alameda-driven short attack and proposed emergency liquidation-threshold changes, but the peg never durably returned. A second break arrived in May alongside Terra, recapitalization efforts followed through SURF, and the project eventually abandoned the dollar target altogether, rebranding USDN as the floating index token XTN. Pharos preserves USDN in the stablecoin cemetery rather than on a public coin page.",
      ],
    },
    {
      heading: "The WAVES reflexivity loop",
      paragraphs: [
        "The structural flaw was single-asset reflexive backing. Because USDN was minted against WAVES and WAVES alone, the stablecoin's solvency was a direct function of one volatile token's market capitalization. When WAVES rose, the protocol could mint more USDN against the same locked tokens and the system looked robustly over-collateralized; when WAVES fell, the value standing behind every USDN fell with it, in lockstep.",
        "That is the same reflexivity that defined Terra, with the roles relabeled: WAVES played LUNA, USDN played UST, and the peg held only while the volatile leg stayed large and confident relative to the stablecoin it backed. A stated backing ratio of 2.62 offered little protection, because the ratio was computed against a WAVES price that could, and did, fall faster than the protocol could react. Collateral measured in the asset most correlated with the run is not a buffer; it is a second exposure to the same shock.",
        "The decisive threshold was the one 0xHamZ named in advance: the point at which WAVES' total market value risked dropping below the USDN outstanding. Past that line the collateral could no longer cover the float, par redemption could not hold for everyone, and rational holders had every reason to exit first. Pharos weights reflexive, single-token collateral as a high-fragility configuration through PegScore and the DEWS early-warning surface for exactly this reason.",
      ],
    },
    {
      heading: "The Vires leverage circle",
      paragraphs: [
        "What turned a fragile design into an acute crisis was the alleged leverage loop on Vires.finance, the largest lending market on Waves. As described by 0xHamZ on 31 March, the cycle ran: deposit USDN as collateral on Vires and borrow USDC and USDT against it; use the borrowed stablecoins to buy WAVES on exchanges such as Binance; stake that WAVES through Neutrino to mint fresh USDN; deposit the new USDN back on Vires and borrow again. Each turn of the loop pushed WAVES higher and printed more USDN, with the whole edifice financed by borrowed dollars rather than organic demand.",
        "The danger was that the loop was symmetric only on the way up. The same analysis flagged a large USDC short position on Vires, and warned that a material USDN depeg could trigger liquidations on the order of $607M against the roughly $875M USDN outstanding, an outcome it labeled 'Armageddon.' A circular structure that manufactures its own collateral and its own demand has no independent buyer to lean on when sentiment turns; the leverage that inflated both legs unwinds them together.",
        "Waves founder Sasha Ivanov rejected the manipulation framing, attributing the pressure to a coordinated short campaign by Alameda Research and arguing a market with billions in daily volume could not be moved by a few million in borrowing. Pharos does not adjudicate the intent dispute. The structural reading stands regardless: a peg whose collateral and whose demand both depend on the same self-referential leverage circle is fragile by construction, whoever lit the match.",
      ],
    },
    {
      heading: "The slow death and the XTN rebrand",
      paragraphs: [
        "Unlike Terra, USDN did not vaporize in a single week. After the April break it bounced into the high-$0.80s and low-$0.90s without ever durably reclaiming a dollar, then broke again in May 2022 as the Terra collapse drained confidence across every reflexive design at once. Each recovery restored a price without restoring the trust the peg actually required, and the gap between the two only widened as WAVES kept sliding through the year.",
        "By late 2022 the team had conceded the point. In a community post the developers acknowledged that 'with the current setup, clearly, USDN can not withstand the unprecedented market volatility,' and governance voted to abandon the dollar peg outright. After a February 2023 transition, USDN was rebranded as the Neutrino Index Token (XTN): no longer a stablecoin, but a floating token whose value tracks a basket of Waves-ecosystem assets and a backing ratio rather than a fixed $1.",
        "The rebrand was an obituary in the language of a relaunch. Stripped of its peg, the renamed asset traded far below a dollar, its supply was wound down sharply, and it has since lingered around a few cents and is widely listed as inactive. For the purposes of a stablecoin archive, USDN died in 2022; XTN is the marker left on the grave.",
      ],
    },
    {
      heading: "Lessons",
      paragraphs: [
        "Collateral correlated with the run is not collateral. A stablecoin backed by a single reflexive token inherits that token's volatility directly into its solvency, so a headline over-collateralization ratio computed at the top of a rally can evaporate on the way down. The buffer has to be uncorrelated with the stress event to be a buffer at all; WAVES backing USDN was a second bet on the same outcome.",
        "Circular leverage manufactures both sides of the market and so removes the floor. When the same actors borrow against the stablecoin to buy the collateral that mints more of the stablecoin, demand and backing are the same financed position. There is no independent counterparty to absorb the unwind, and the leverage that lifted the system in calm markets pulls it down together in a run, the precise scenario the on-chain analysis predicted in advance.",
        "Finally, the market mispriced the warning. USDN ran the full reflexive death spiral about five weeks before Terra, complete with a public, arithmetic insolvency thesis, and the wider market filed it as a Waves-specific accident rather than a structural preview. Reading USDN, IRON, and Terra together makes the pattern legible: single-token or share-token reflexive backing cannot anchor a peg through a panic, regardless of the chain it lives on or the size of the stage.",
      ],
    },
  ],
  watchpoints: [
    "A stablecoin minted against a single volatile token, where the protocol's stated collateral ratio is computed in that same token; solvency and the run are then driven by the identical price move.",
    "Circular leverage loops where the stablecoin is borrowed against to buy the very asset that mints more of it, so demand and collateral are one financed position with no independent buyer on the unwind.",
    "The backing token's market capitalization approaching the stablecoin's circulating value: past that line the collateral cannot cover the float and par redemption cannot hold for all holders.",
    "An issuer attributing a peg break to an external 'attack' and proposing emergency liquidation or redemption-limit changes, rather than addressing the reflexive structure underneath.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/algorithmic/", label: "How algorithmic stablecoins work" },
    {
      href: "/learn/case-studies/terra-ust-2022/",
      label: "Case study: Terra / UST, the larger collapse five weeks later",
    },
    {
      href: "/learn/case-studies/iron-titan-2021/",
      label: "Case study: IRON Finance, the earlier algorithmic prequel",
    },
    { href: "/cemetery/", label: "Stablecoin cemetery" },
  ],
  sources: [
    {
      label: "CryptoCompare archive: USDN transitioning from stablecoin to Neutrino Index Token (XTN)",
      href: "https://resources.cryptocompare.com/asset-management/642/1741081490633.pdf",
    },
    {
      label: "CoinDesk: Waves' USDN Stablecoin Loses Peg, Drops 15% Amid Manipulation Scare",
      href: "https://www.coindesk.com/markets/2022/04/04/waves-usdn-stablecoin-loses-peg-drops-15-amid-manipulation-scare",
    },
    {
      label: "Forkast: Waves' Neutrino USD loses peg amid price manipulation allegations",
      href: "https://forkast.news/waves-usdn-loses-peg-price-manipulation-allegations/",
    },
    {
      label: "Neutrino Protocol: SURF recapitalization feature",
      href: "https://medium.com/neutrinoteam/what-is-surf-and-why-is-it-important-for-the-neutrino-ecosystem-8962c2230049",
    },
    {
      label: "CoinDesk: Crisis in Terra's UST stablecoin spreads to Neutrino USD on Waves",
      href: "https://www.coindesk.com/markets/2022/05/11/crisis-in-terras-ust-stablecoin-spreads-to-neutrino-usd-on-waves-protocol",
    },
    {
      label: "CoinGecko: Neutrino Index Token (XTN) price and market data",
      href: "https://www.coingecko.com/en/coins/neutrino-index-token",
    },
  ],
  metaDescription:
    "How Neutrino USD (USDN) broke peg in April 2022: WAVES single-token backing, a Vires circular-leverage loop, and the algo death five weeks before Terra.",
  datePublished: "2026-06-15",
};
