import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "ftx-contagion-2022",
  eyebrow: "Exchange-collapse contagion",
  title: "The FTX weekend: which pegs broke",
  subtitle:
    "When the second-largest crypto exchange collapsed in November 2022, the stablecoins that wobbled were not the weakest by design but the ones standing closest to Alameda's order flow.",
  lead: [
    "The FTX failure was a counterparty event, not a stablecoin event. On 2 November 2022 CoinDesk published Alameda Research's balance sheet, showing that of roughly $14.6B in assets a large share (around $5.8B) was its affiliate's own FTT token rather than independent collateral. Four days later Binance announced it would liquidate its FTT holdings, a bank run followed, FTX halted withdrawals on 8 November, and the company filed for Chapter 11 on 11 November. None of that touched a stablecoin's reserves directly.",
    "The contagion travelled through proximity. Alameda was one of the largest market makers and liquidity providers in crypto, so its forced deleveraging hit whatever it was holding or had pledged, including stablecoin positions it appeared to be dumping into thin weekend liquidity. The assets that deviated were not the ones with the most fragile mechanics but the ones nearest the failing counterparty. That is the distinguishing signature of exchange-collapse contagion: a solvent peg can still print below par if the entity unwinding into it is large enough and the venue is shallow enough.",
    "Three pegs are worth separating. USDT briefly showed a ~$0.96 quote on a handful of venues and data aggregators, but the deviation was contested and reclaimed par within the session. USDD slid to roughly $0.96 on suspected Alameda selling and recovered after the Tron DAO Reserve intervened. HUSD, the Huobi-ecosystem dollar already being unwound after Justin Sun took it over and steered volume into his own USDD, collapsed toward ~$0.28 and never came back, the clearest peg death of the episode.",
  ],
  takeaways: [
    "Exchange-collapse contagion picks targets by proximity, not design fragility: the pegs that moved were the ones a deleveraging Alameda was holding, pledging, or dumping into.",
    "HUSD was the only outright casualty: already being wound down via a Huobi delisting and a forced exit into USDT, it fell toward ~$0.28 in October 2022 and never recovered (now in the cemetery).",
    "USDD slid to roughly $0.96 on suspected Alameda Curve selling but recovered once the Tron DAO Reserve stepped in; it remained live, structurally scarred rather than dead.",
    "USDT's ~$0.96 print was shallow, venue-specific, and disputed (attributed to a data/price-discrepancy issue rather than a reserve problem), and par was reclaimed quickly.",
  ],
  relatedCoins: [
    {
      coinId: "usdt-tether",
      note: "Largest fiat-backed stablecoin; a ~$0.96 quote appeared on some venues and aggregators around 2022-11-10 but was brief, contested (attributed to a data/price-discrepancy issue), and reclaimed par the same session.",
    },
    {
      coinId: "usdd-tron-dao-reserve",
      note: "Tron's stablecoin; slid to roughly $0.96 on suspected Alameda selling around 2022-11-09/10 with a ~$725M market cap, then recovered after the Tron DAO Reserve pledged to buy USDT to shore up collateral.",
    },
  ],
  archetype: "fiat-cash",
  outcome: "died",
  eventDateLabel: "October-November 2022",
  eventWindow: {
    startISO: "2022-10-31",
    endISO: "2022-11-16",
    peakDeviationBps: -7200,
    lowPrice: 0.28,
  },
  cemeteryId: "husd-husd-2022-10",
  timeline: [
    {
      dateISO: "2022-10-31",
      headline: "Huobi delists HUSD; volume routed into USDD",
      body: "After Justin Sun took a senior role at Huobi, the exchange announced it was delisting HUSD and helping users swap into USDT, while steering ecosystem volume toward Sun's own stablecoin, USDD. HUSD's market cap had already shrunk from a peak around $400M-$555M to about $63M, and the token slid toward ~$0.28 with no redemption backstop.",
      severity: "high",
      href: "https://www.coindesk.com/business/2022/10/31/after-huobi-delisting-stablecoin-husd-falls-72-from-dollar-peg",
    },
    {
      dateISO: "2022-11-02",
      headline: "CoinDesk publishes Alameda's FTT-heavy balance sheet",
      body: "CoinDesk reported that of roughly $14.6B in Alameda Research assets, around $5.8B was its affiliate's own FTT token, a position that could not be liquidated at quoted prices. The disclosure reframed FTX's market-maker arm as structurally undercapitalized.",
      severity: "med",
      href: "https://www.coindesk.com/business/2022/11/02/divisions-in-sam-bankman-frieds-crypto-empire-blur-on-his-trading-titan-alamedas-balance-sheet",
    },
    {
      dateISO: "2022-11-06",
      headline: "Binance announces it will liquidate its FTT",
      body: "Binance said it would sell its FTT holdings, acquired when it exited FTX equity in 2021. The signal triggered a run on FTX; reporting later put withdrawal requests at roughly $5B over the following 72 hours.",
      severity: "high",
    },
    {
      dateISO: "2022-11-08",
      headline: "FTT collapses; FTX halts withdrawals",
      body: "FTT fell more than 80% to around $4 from roughly $22 a day earlier, even after a brief Binance acquisition letter of intent. FTX paused customer withdrawals as the contagion drove bitcoin to a 23-month low near $17,100 and pressured Alameda's broader book.",
      severity: "high",
      href: "https://www.coindesk.com/markets/2022/11/08/ftx-token-falls-80-despite-binance-bailout-as-alameda-contagion-spreads-to-bitcoin",
    },
    {
      dateISO: "2022-11-10",
      headline: "USDD and USDT wobble as Alameda is suspected of dumping",
      body: "USDD dropped to roughly $0.96 on multiple exchanges, which Justin Sun himself attributed to Alameda selling USDD to raise FTX liquidity. USDT separately showed a ~$0.96 quote on some venues and aggregators; Tether attributed it to a price-discrepancy issue, and it reclaimed par the same session.",
      severity: "med",
      href: "https://www.coindesk.com/markets/2022/11/10/tron-network-usdd-stablecoin-wobbles-from-dollar-peg-amid-latest-crypto-crisis",
    },
    {
      dateISO: "2022-11-11",
      headline: "FTX files for Chapter 11",
      body: "FTX, Alameda, and ~130 affiliated entities filed for bankruptcy and Sam Bankman-Fried resigned. The Tron DAO Reserve announced plans to buy up to $1B of USDT to bolster USDD's collateral, and USDD's peg stabilized in the days that followed.",
      severity: "high",
    },
    {
      dateISO: "2022-11-16",
      headline: "The survivors reclaim par; HUSD does not",
      body: "By mid-month USDT and USDD had returned to within a fraction of a cent of a dollar as Alameda's forced selling cleared and reserves were reinforced. HUSD stayed broken (delisted, abandoned, and routed into other assets) and was retired to the stablecoin cemetery.",
      severity: "low",
    },
  ],
  sections: [
    {
      heading: "What happened: an exchange, not a stablecoin, failed",
      paragraphs: [
        "FTX was the second-largest crypto exchange and Alameda Research was its affiliated trading firm and one of the market's dominant liquidity providers. The trigger was a 2 November 2022 CoinDesk report on Alameda's balance sheet: of roughly $14.6B in assets, a large block (about $5.8B) was FTX's own FTT token, an illiquid asset Alameda itself could not sell at quoted prices without crashing it. The disclosure exposed that FTX's market-making arm was effectively capitalized by paper it minted.",
        "On 6 November Binance announced it would liquidate its FTT, and the resulting loss of confidence became a classic bank run. FTX paused withdrawals on 8 November as FTT fell more than 80% to around $4, a Binance rescue letter of intent collapsed within a day, and on 11 November FTX, Alameda, and roughly 130 affiliates filed for Chapter 11. Sam Bankman-Fried was later convicted of fraud.",
        "Critically, none of this was a reserve failure at a stablecoin. No issuer's cash, Treasuries, or collateral pool was impaired by the FTX bankruptcy itself. The stablecoin stress that accompanied the weekend came entirely from the collapse of a counterparty, which is why the pegs that moved cannot be diagnosed from their own mechanics alone.",
      ],
    },
    {
      heading: "Contagion by proximity to the counterparty",
      paragraphs: [
        "Because Alameda was a top-tier market maker and lender, its forced deleveraging hit whatever it touched: positions it held, collateral it had pledged, and liquidity pools it traded against. As the firm scrambled for cash, on-chain observers and exchanges saw stablecoin selling that pushed individual pegs off the dollar, not because those pegs were unsound, but because a very large, distressed seller was unwinding into them over a thin weekend.",
        "This is the missing failure mode that the algorithmic and reserve-banking case studies don't capture. In Terra the mechanism destroyed itself; in the SVB episode a reserve became temporarily unreachable. Here the stablecoins were largely fine internally: the shock arrived from outside, through the order book, and selected its targets by who was nearest the failing entity. A solvent peg can still print below par if the seller is big enough and the venue is shallow enough.",
        "The practical lesson is that proximity is itself a risk dimension. Pharos tracks counterparty and venue concentration alongside reserve quality precisely because exposure to a single dominant trading firm or exchange can transmit stress that no amount of clean collateral prevents in the moment.",
      ],
    },
    {
      heading: "HUSD: the casualty that didn't recover",
      paragraphs: [
        "HUSD was a fiat-backed dollar tied to the Huobi exchange ecosystem. Its decline began before FTX's final days: after Justin Sun took a senior position at Huobi, the exchange moved to delist HUSD and shift trading volume into Sun's own stablecoin, USDD. With its home venue actively winding it down and helping users swap into USDT, HUSD lost the one thing a custodial dollar depends on: a credible redemption path.",
        "On 31 October 2022 HUSD fell about 72% from its peg, touching roughly $0.28, and its market capitalization had already collapsed from a peak in the hundreds of millions (roughly $393M in the Pharos cemetery, with some external trackers higher) to around $63M. There was no run on reserves in the usual sense; the issuer's ecosystem simply chose to stop supporting it, and the token had no independent demand to fall back on. It never reclaimed the dollar and now sits in the Pharos cemetery, recorded as a counterparty failure rather than a mechanism failure.",
        "HUSD is the cleanest illustration of the thesis. It was not the weakest stablecoin design in the market but a custodial dollar whose fate was decided by the entity that controlled it. When that entity pivoted to a competing product, the peg died, and the FTX-weekend stablecoin turmoil that pulled USDD toward $0.96 was the same Sun-and-USDD nexus that had already finished HUSD off.",
      ],
    },
    {
      heading: "The wobbles that held: USDD and USDT",
      paragraphs: [
        "USDD was the more genuinely strained survivor. Around 9-10 November it slid to roughly $0.96 on several exchanges, which Justin Sun publicly attributed to Alameda selling USDD to fund FTX. At a market cap near $725M, USDD's collateral looked ample on paper but was largely staked and illiquid; counting only liquid reserves, its effective coverage was much tighter. The Tron DAO Reserve announced plans to buy up to $1B of USDT to reinforce backing, and the peg recovered, though it had clearly absorbed real damage.",
        "USDT's deviation should be read more skeptically. A ~$0.96 quote appeared on a subset of venues and data aggregators around 10 November, but other venues showed lows nearer $0.97, Tether characterized it as a price-discrepancy issue rather than a reserve problem, and at least one aggregator later acknowledged a data fault. Tether did separately freeze USDT tied to FTX, and there was visible speculation that Alameda was shorting USDT, but the largest fiat-backed stablecoin reclaimed par within the session and within about two weeks was trading at $0.999.",
        "Both assets stayed live and both reclaimed the dollar, which is why neither is the subject of this study. They are the control cases: they show how shallow and recoverable a contagion deviation is when the underlying reserves are sound and an intervention or arbitrage closes the gap.",
      ],
    },
    {
      heading: "Lessons",
      paragraphs: [
        "The peg that breaks is not always the weakest design but the one nearest the failing counterparty. FTX impaired no stablecoin's reserves, yet it killed HUSD and dented USDD and USDT, because contagion travelled through Alameda's positions and the venues it traded on. Counterparty and venue proximity belong in a peg's risk picture alongside collateral quality.",
        "A custodial dollar is only as durable as the entity that runs it. HUSD had no mechanical flaw; it died because its controlling ecosystem chose to stop supporting it and pointed users at a competing token. Concentration of an issuer's distribution and redemption in a single exchange is a structural fragility, not a convenience.",
        "Distinguish a data print from a depeg. The USDT ~$0.96 quote was shallow, venue-specific, and disputed, and it reclaimed par almost immediately, a different category of event from USDD's real-collateral strain or HUSD's terminal abandonment. Treating every off-par tick as equivalent overstates contagion; reading the source, depth, and recovery of each deviation is what separates noise from a genuine break.",
      ],
    },
  ],
  watchpoints: [
    "Stablecoins with heavy distribution, redemption, or liquidity concentration on a single exchange or a single dominant market maker; proximity to a failing counterparty can break a sound peg.",
    "A large distressed seller unwinding into thin weekend or holiday liquidity, where venue depth, not reserve quality, determines how far a peg prints below par.",
    "Off-par quotes that appear on only a subset of venues or data aggregators, likely a price-discrepancy or data issue rather than a reserve impairment; confirm against deep, liquid venues before treating it as a depeg.",
    "Reserves that look over-collateralized on paper but are largely staked or illiquid, leaving a much tighter effective coverage ratio under acute redemption pressure (as with USDD's JustLend-staked backing).",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/fiat-cash/", label: "Mechanism: fiat-cash stablecoins" },
    { href: "/cemetery/", label: "Stablecoin cemetery" },
    { href: "/stablecoin/usdt-tether/", label: "USDT, the contested wobble that held" },
    { href: "/stablecoin/usdd-tron-dao-reserve/", label: "USDD: slid to ~$0.96, then recovered" },
  ],
  sources: [
    {
      label: "CoinDesk: The epic collapse of Sam Bankman-Fried's FTX, a timeline",
      href: "https://www.coindesk.com/markets/2022/11/12/the-epic-collapse-of-sam-bankman-frieds-ftx-exchange-a-crypto-markets-timeline",
    },
    {
      label: "CoinDesk: Alameda's FTT-heavy balance sheet (Nov. 2, 2022)",
      href: "https://www.coindesk.com/business/2022/11/02/divisions-in-sam-bankman-frieds-crypto-empire-blur-on-his-trading-titan-alamedas-balance-sheet",
    },
    {
      label: "CoinDesk: FTX token falls 80% despite Binance bailout as Alameda contagion spreads",
      href: "https://www.coindesk.com/markets/2022/11/08/ftx-token-falls-80-despite-binance-bailout-as-alameda-contagion-spreads-to-bitcoin",
    },
    {
      label: "CoinDesk: Tron network USDD stablecoin wobbles from dollar peg",
      href: "https://www.coindesk.com/markets/2022/11/10/tron-network-usdd-stablecoin-wobbles-from-dollar-peg-amid-latest-crypto-crisis",
    },
    {
      label: "CoinDesk: After Huobi delisting, stablecoin HUSD falls 72% from dollar peg",
      href: "https://www.coindesk.com/business/2022/10/31/after-huobi-delisting-stablecoin-husd-falls-72-from-dollar-peg",
    },
    {
      label: "Cointelegraph: Tron's stablecoin USDD loses dollar peg on suspected Alameda selloff",
      href: "https://cointelegraph.com/news/tron-s-stablecoin-usdd-loses-dollar-peg-on-suspected-selloff-by-alameda-research",
    },
  ],
  metaDescription:
    "How the November 2022 FTX collapse rippled into stablecoins: HUSD died, USDD slid to ~$0.96 and recovered, and USDT's contested wobble held.",
  datePublished: "2026-06-15",
};
