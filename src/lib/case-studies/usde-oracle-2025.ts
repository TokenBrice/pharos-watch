import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "usde-oracle-2025",
  eyebrow: "Venue oracle dislocation",
  title: "USDe and the October 2025 Binance oracle print",
  subtitle:
    "During the 10 October 2025 crypto-wide deleveraging, USDe printed as low as ~$0.65 on Binance while its backing and primary-market redemption stayed intact: a venue artifact, not a peg break.",
  lead: [
    "On 10 October 2025 the broader crypto market suffered one of its largest single-day liquidation cascades, and for roughly forty minutes the price of Ethena's USDe on Binance fell to about $0.65. To anyone watching that single screen, it looked like a synthetic dollar coming apart in real time. It was not. The dislocation was confined to one venue while USDe traded within a tight band of its peg on the deepest on-chain pools, and Ethena's primary-market mint and redeem channel kept clearing at one dollar throughout.",
    "The distinction matters because the failure mode here is the opposite of a backing failure. A backing failure shows up everywhere at once and persists until reserves are repaired or the asset is wound down. What happened on Binance was a pricing-and-liquidity artifact: the exchange referenced its own thin order book to value USDe used as margin collateral, and with deposits and withdrawals impaired, the arbitrageurs who normally close that gap could not. The print fed forced liquidations, the liquidations deepened the print, and the loop ran until conditions eased.",
    "USDe survived the episode with its collateral and redemption mechanics untouched, but the event left a real scar in confidence and supply. This case study separates the venue print from an actual peg break, walks through how the delta-neutral design held, and draws out what a practitioner should monitor when a stablecoin doubles as exchange margin collateral.",
  ],
  takeaways: [
    "The ~$0.65 low was a single-venue oracle artifact: Binance priced USDe off its own thin order book during impaired settlement, so the arbitrage loop that would close the gap was severed.",
    "It was the opposite of a backing failure: deep on-chain pools held within ~100 bps of par and primary mint-and-redeem cleared at $1 the entire time, redeeming ~$2B in 24 hours while staying overcollateralized.",
    "Collateral pricing is a system property: the same USDe was sound and catastrophically mispriced at once, depending only on which oracle a venue trusted.",
    "Surviving is not being unscarred. Confidence and supply still bled ~$8B over the following months even though the mechanism performed as designed.",
  ],
  primaryCoinId: "usde-ethena",
  depegEventSlug: "usde-2025-10-10",
  archetype: "synthetic-delta-neutral",
  outcome: "survived",
  eventDateLabel: "October 2025",
  eventWindow: {
    startISO: "2025-10-10",
    endISO: "2025-10-11",
    peakDeviationBps: -3500,
    lowPrice: 0.65,
  },
  timeline: [
    {
      dateISO: "2025-10-10",
      headline: "Market-wide deleveraging cascade begins",
      body: "A violent, market-wide drawdown triggered the largest leveraged-position liquidation cascade crypto had seen, with open interest unwinding across major venues within hours. The selloff hit its lows before any single asset dislocated, setting the stage for collateral stress on exchanges that valued staking and synthetic-dollar assets off their own books.",
      severity: "med",
    },
    {
      dateISO: "2025-10-10",
      headline: "USDe prints ~$0.65 on Binance",
      body: "Between roughly 21:36 and 22:16 UTC, USDe's price on Binance fell as low as about $0.65 even as it held near peg elsewhere. Binance's index referenced its own relatively shallow order book, and impaired deposits and withdrawals kept market makers from arbitraging the gap, so the depressed print fed forced liquidations of accounts using USDe as margin.",
      severity: "high",
      href: "https://www.binance.com/en/support/announcement/detail/0989d6c7f32545bfb019e3249eaabc3f",
    },
    {
      dateISO: "2025-10-10",
      headline: "Peg holds on the deepest venues",
      body: "Through the same window, USDe stayed within roughly 100 basis points of a dollar on the deepest on-chain pools such as Curve, and dipped only to around $0.92 on Bybit. The severe discrepancy was isolated to the one venue whose index did not reference the deepest liquidity.",
      severity: "med",
    },
    {
      dateISO: "2025-10-11",
      headline: "Primary redemption absorbs the run; print recovers",
      body: "Ethena's mint-and-redeem channel cleared at one dollar as supply fell sharply: the protocol reported roughly $2 billion redeemed within about 24 hours, and supply moved from roughly $9 billion toward $6 billion almost immediately, without basis positions needing to be unwound. Independent attestors reported USDe remained overcollateralized by roughly $66 million across the event.",
      severity: "med",
    },
    {
      dateISO: "2025-10-12",
      headline: "Ethena and Binance respond",
      body: "Ethena's founder publicly attributed the print to the venue's oracle referencing its own order book during impaired settlement, not to USDe's collateral or mechanics. Binance announced compensation for affected futures, margin, and loan users and committed to index changes including incorporating redemption prices and a soft price floor for the USDe reference.",
      severity: "low",
      href: "https://www.coindesk.com/markets/2025/10/13/no-ethena-s-usde-didn-t-de-peg",
    },
  ],
  sections: [
    {
      heading: "What happened on Binance",
      paragraphs: [
        "USDe is a synthetic dollar: rather than holding fiat in a bank, Ethena keeps backing in liquid stablecoins and in spot crypto (predominantly BTC and ETH) that is hedged one-for-one with short perpetual futures on centralized venues. The hedge is what keeps the dollar value of the collateral roughly constant as crypto prices swing, and funding paid on those shorts is the source of yield. None of that mechanism broke on 10 October.",
        "What broke was how one exchange priced USDe for the purpose of valuing it as margin collateral. Binance's reference index for USDe leaned on its own order book rather than the deepest external liquidity. During the cascade that book was thin, and the exchange was simultaneously experiencing deposit and withdrawal friction, which meant the market makers who would normally buy the cheap USDe on Binance and redeem or sell it elsewhere could not move inventory in to close the gap.",
        "With the arbitrage loop severed, a downward print became self-reinforcing: accounts posting USDe as collateral were marked down against the local index, forced liquidations sold into a shallow book, and each sale dragged the index lower still. The low of roughly $0.65 was the bottom of that loop, not a quote at which Ethena was redeeming or at which deep markets valued the asset.",
      ],
    },
    {
      heading: "Venue print vs. peg break",
      paragraphs: [
        "A peg break and a venue print look similar on a single chart and behave nothing alike underneath. A genuine peg break is a backing problem: it appears across venues at once, primary redemption either halts or clears below par, and the deviation persists until reserves are restored or the asset is retired. The 2023 USDC episode is the reference case: the deviation was global and redemption was effectively paused over a weekend until the reserve shortfall was backstopped.",
        "October 2025 was the inverse on every axis. The deviation was local to one order book; the deepest pools stayed within about a percent of par; and Ethena's primary mint-and-redeem channel cleared at a dollar the entire time, absorbing billions in outflows. A holder who could reach primary redemption or a deep venue never faced a 35-cent loss; only accounts marked against the distressed local index did.",
        "Pharos encodes exactly this separation. PegScore reads price stability across the venues a coin actually trades on, and DEWS is built to flag sustained, structural deviation rather than a single-venue spike that mean-reverts within hours. Treating the $0.65 tick as a peg break would overstate the event; treating it as nothing would understate a real, if exogenous, stress on holders who used USDe as exchange collateral.",
      ],
    },
    {
      heading: "How the delta-neutral design held",
      paragraphs: [
        "The deleveraging that caused the chaos elsewhere was, mechanically, favorable to Ethena's backing. As spot crypto fell, the short perpetual hedges that offset the BTC and ETH collateral moved into profit, which cushions rather than erodes the dollar value of the position. This is the structural difference from an undercollateralized algorithmic design, where a falling market and a falling token reinforce each other into a death spiral.",
        "The redemption record is the cleaner proof. The protocol reported roughly $2 billion redeemed within about 24 hours while primary redemption kept clearing at par, and it did not need to unwind basis positions to honor that flow because a large share of backing already sat in liquid stablecoins. Independent attestors reported the book stayed modestly overcollateralized throughout, on the order of $66 million, rather than tipping into a shortfall. The bleed did not stop at the event window: USDe's market value fell from roughly $14.7 billion on the eve of the crash toward about $6 billion over the following two months (on the order of $8 billion in net outflows) as capital rotated into overcollateralized alternatives, a sustained confidence drain rather than a single-day shock.",
        "The genuine exposure the delta-neutral model carries is venue and counterparty risk on the hedge, and auto-deleveraging is its sharpest edge. When an exchange's insurance fund is exhausted, it can force-close profitable positions, which can include Ethena's protective shorts, leaving the corresponding spot temporarily unhedged. The mitigant is that hedges can be re-established and profit-and-loss realized to restore neutrality, and that backing is spread across multiple venues and custodians rather than concentrated on one exchange.",
      ],
    },
    {
      heading: "Lessons",
      paragraphs: [
        "The first lesson is to read deviation by venue and by liquidity depth, never off a single screen. The headline number that circulated was the worst tick on the thinnest book; the price that mattered for solvency was where primary redemption and the deepest pools cleared. A pricing source that references only its own order book will manufacture artifacts under stress.",
        "The second is that collateral pricing is a system property, not a token property. The same USDe was perfectly sound and catastrophically mispriced at the same instant depending on which oracle a counterparty trusted. Money markets that referenced deep liquidity or a hardcoded peg avoided liquidations entirely; the venue that referenced its own book did not. When a stablecoin is accepted as margin, the oracle design of every venue that accepts it becomes part of that coin's risk surface.",
        "The third is that surviving an event is not the same as being unscarred by it. USDe held its backing and its peg where it counted, yet confidence and supply fell materially in the following weeks. For a synthetic dollar whose stability rests on funding markets and exchange relationships, perception-driven outflows are a live risk even when the mechanism performs exactly as designed, which is why the durable signals to track are the mechanism's behavior and its venue dependencies rather than a single day's recovery.",
      ],
    },
  ],
  dataWidgets: [
    {
      kind: "peg-deviation",
      coinId: "usde-ethena",
      caption:
        "USDe peg deviation around 10 October 2025. The ~$0.65 low was a Binance-only print; the asset held near par on deep venues and recovered within hours.",
    },
  ],
  watchpoints: [
    "Whether venues that accept USDe as margin collateral price it off deep external liquidity rather than their own order book; single-venue index design is the recurring failure surface.",
    "Health of the primary mint-and-redeem channel during stress: par redemption clearing without unwinding basis positions is the real solvency signal, not the worst exchange tick.",
    "Hedge concentration and auto-deleveraging risk across the centralized venues holding Ethena's short perpetuals, and how quickly neutrality is re-established after a forced close.",
    "Supply and confidence trajectory after a shock: outflows can persist even when collateral and peg held, because a synthetic dollar's stability is partly reflexive.",
  ],
  crossLinks: [
    {
      href: "/learn/mechanisms/synthetic-delta-neutral/",
      label: "Mechanism: synthetic delta-neutral dollars",
    },
    {
      href: "/stablecoin/usde-ethena/",
      label: "USDe on Pharos",
    },
    {
      href: "/methodology/",
      label: "Methodology: PegScore and DEWS",
    },
    {
      href: "/learn/case-studies/usr-resolv-2026/",
      label: "Case study: when a delta-neutral issuer's mint key failed",
    },
  ],
  sources: [
    {
      label: "Binance: Resolution of USDE, BNSOL, and WBETH Price Depeg and Risk Control Enhancements",
      href: "https://www.binance.com/en/support/announcement/detail/0989d6c7f32545bfb019e3249eaabc3f",
    },
    {
      label: "CoinDesk: No, Ethena's USDe Didn't De-peg During Friday's Crash (Guy Young statement)",
      href: "https://www.coindesk.com/markets/2025/10/13/no-ethena-s-usde-didn-t-de-peg",
    },
    {
      label: "Cointelegraph: Ethena founder says USDe depeg due to Binance oracle issue",
      href: "https://cointelegraph.com/news/usde-depeg-oracle-issues-ethena-founder",
    },
    {
      label: "Ethena: USDe transparency dashboard (live collateral and attestations)",
      href: "https://app.ethena.fi/dashboards/transparency",
    },
    {
      label: "Ethena documentation: protocol mechanism and risk",
      href: "https://docs.ethena.fi/",
    },
  ],
  metaDescription:
    "How USDe printed ~$0.65 on Binance in the 10 October 2025 crash: a venue oracle artifact, not a backing failure. Delta-neutral backing and redemption held.",
  datePublished: "2026-05-23",
};
