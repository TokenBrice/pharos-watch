import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "usdf-falcon-2025",
  eyebrow: "Opacity discount",
  title: "USDf and the opacity discount",
  subtitle:
    "In July 2025 Falcon's USDf became the first delta-neutral synthetic dollar to be wounded by what holders could not see (opaque off-chain collateral and a seven-day redemption lag) rather than by anything its mechanism actually did wrong.",
  lead: [
    "On 8 July 2025, USDf (the synthetic dollar from Falcon Finance, then a top-15 stablecoin with roughly $550 million in circulation) fell to about $0.887 on decentralized exchanges. The drop came against a backdrop of public bad-debt allegations and a late-May LlamaRisk report flagging centralized control of reserves and the ability to mint more USDf against a single low-cap collateral token than that token's entire market value. Managing partner Andrei Grachev had publicly defended the token as 116% overcollateralized; the worst of the deviation printed shortly after, as the market declined to take the headline number on faith.",
    "What made this episode distinct is that nothing in the delta-neutral machinery broke. The collateral did not vanish, the hedges did not blow up, no key was compromised. What failed was the market's ability to verify the backing in real time. Falcon's own disclosure during the stress put only about $25 million of reserves, roughly four percent, on-chain, with the remaining ~96% held off-chain across centralized custodians. Combined with a seven-day cooldown on redemptions, that meant the normal arbitrage that pins a synthetic dollar to par could not operate on the timescale the panic did. Holders could not redeem quickly to defend the peg, and they could not independently see what backed the token, so they priced the uncertainty.",
    "USDf recovered to near par within days and Falcon moved to address the transparency gap, publishing its first independent quarterly audit in October 2025. But the scar is structural rather than cosmetic. This is the first delta-neutral synthetic dollar Pharos classifies as wounded. That sets it apart from USDe, which survived a venue oracle print with its mechanics intact, and from Resolv's USR, which died when a compromised key minted tokens against no collateral. USDf's wound was inflicted by opacity and redemption friction, not by mechanism failure.",
  ],
  takeaways: [
    "USDf, then a top-15 stablecoin near $550M, fell to ~$0.887 on DEXes on 8 July 2025 without any mechanical failure: the collateral, hedges, and minting all functioned. What broke was the market's ability to verify the backing.",
    "Falcon's own stress-period disclosure put only ~$25M (~4%) of reserves on-chain and ~96% off-chain across centralized custodians (Binance, Fireblocks, Ceffu, ChainUp); a seven-day redemption cooldown meant arbitrage could not close the gap on the timescale of the panic.",
    "Transparency is a peg input, not a nicety: a 116% overcollateralization claim that holders cannot independently verify trades at a discount to the same backing they can see and redeem against on demand.",
    "Distinct failure mode: USDe (oracle print) survived with mechanics intact; USR (key compromise) died; USDf was wounded by opacity and redemption lag, a structurally scarred survivor.",
  ],
  primaryCoinId: "usdf-falcon",
  relatedCoins: [
    {
      coinId: "usde-ethena",
      note: "The survived peer. USDe's October 2025 print to ~$0.65 was a single-venue oracle artifact against intact backing and par redemption, a pricing failure external to the protocol. USDf's deviation, by contrast, came from inside: holders could not verify or quickly redeem against the backing, so the same delta-neutral archetype was wounded by disclosure rather than by an exchange's order book.",
    },
    {
      coinId: "usr-resolv",
      note: "The died peer. Resolv's USR was frozen after a compromised mint key issued tokens against no collateral: a mechanism-level solvency failure. USDf stayed solvent throughout; its backing was real but unseen. The contrast isolates the variable: USR lost the collateral, USDf only lost the ability to prove it in real time.",
    },
  ],
  archetype: "synthetic-delta-neutral",
  outcome: "wounded",
  eventDateLabel: "July 2025",
  eventWindow: {
    startISO: "2025-07-08",
    endISO: "2025-07-11",
    peakDeviationBps: -1130,
    lowPrice: 0.887,
  },
  timeline: [
    {
      dateISO: "2025-05-28",
      headline: "LlamaRisk flags centralization and over-issuance",
      body: "Weeks before the depeg, DeFi research group LlamaRisk published an assessment warning that the Falcon team held unilateral authority over reserve management and that solvency could fail through operational mismanagement or the underlying CEX and DeFi strategies. It also flagged that up to 50,000,000 USDf could be minted against DOLO as collateral (more than DOLO's entire market capitalization), alongside missing reserve breakdowns and an inaccessible insurance fund.",
      severity: "med",
    },
    {
      dateISO: "2025-07-07",
      headline: "Bad-debt allegations trigger a confidence run",
      body: "A widely shared post alleged that Falcon was sitting on tens of millions in bad debt, backed by illiquid low-cap assets, using high APYs to bait liquidity. Specific concerns pointed at collateral like DOLO and reserves of Movement's MOVE token, which Coinbase had suspended in May for failing listing standards. Liquidity providers began pulling from USDf pools.",
      severity: "med",
    },
    {
      dateISO: "2025-07-08",
      headline: "Grachev defends 116% overcollateralization",
      body: "Managing partner Andrei Grachev publicly defended USDf as overcollateralized by 116%, stating that stablecoins and Bitcoin made up about 89% (~$565M) of backing and altcoins roughly 11% (~$67M), and that only market-neutral strategies with no directional risk were used. He pledged to publish a full asset breakdown the following week.",
      severity: "low",
    },
    {
      dateISO: "2025-07-08",
      headline: "USDf prints ~$0.887 on DEXes",
      body: "Despite the defense, USDf fell to about $0.887 on decentralized exchanges early on 8 July per DEX Screener, a deviation near 1,130 bps below par, while centralized aggregators showed a milder dip toward ~$0.978. Liquidity providers pulled more than $2 million from the Uniswap USDT/USDf pool in a short span. The market was pricing what it could not verify, not redeeming at that level.",
      severity: "high",
    },
    {
      dateISO: "2025-07-08",
      headline: "Reserve composition and redemption lag exposed",
      body: "Falcon's stress-period disclosure put only about $25M (~4%) of reserves on-chain, with ~$607M (~96%) held off-chain across Binance, Fireblocks, Ceffu, and ChainUp. With redemptions subject to a seven-day cooldown to unwind off-chain strategies, the arbitrage loop that normally pins a synthetic dollar to par could not operate on the timescale of the panic.",
      severity: "high",
    },
    {
      dateISO: "2025-07-11",
      headline: "Recovery toward par",
      body: "Within days USDf recovered to near a dollar, trading just below par by mid-July, with no collateral loss realized. The mechanism had stayed solvent throughout; the deviation unwound as the immediate panic eased rather than through any change in the backing.",
      severity: "low",
    },
    {
      dateISO: "2025-10-01",
      headline: "First independent quarterly audit published",
      body: "Falcon published its first Independent Quarterly Audit, conducted by Harris & Trotter LLP under ISAE 3000. As of 22 September 2025 it reported ~$1.96B in reserves against ~$1.889B USDf in circulation (a 103.87% collateralization ratio) in segregated, unencumbered accounts, and Grachev framed USDf as 'not only fully collateralized but backed by a diversified reserve base.' Attestations moved to weekly reserve reports plus quarterly assurance.",
      severity: "low",
      href: "https://www.prnewswire.com/news-releases/falcon-finance-publishes-independent-quarterly-audit-report-confirming-usdf-fully-backed-by-reserves-302572289.html",
    },
  ],
  sections: [
    {
      id: "what-happened",
      heading: "What happened",
      paragraphs: [
        "USDf is an overcollateralized synthetic dollar. Falcon mints it 1:1 against stablecoins, or at dynamic ratios against volatile collateral like BTC, ETH, SOL, and select altcoins, and runs market-neutral strategies on that backing to generate the yield paid to the staked sUSDf wrapper. By July 2025 it had grown into a top-15 stablecoin with roughly $550 million in circulation.",
        "The trouble started as a confidence problem, not a balance-sheet one. A late-May LlamaRisk report had already warned that Falcon held unilateral authority over reserve management and that the system could mint up to 50,000,000 USDf against a single low-cap token, DOLO, exceeding DOLO's own market capitalization. In early July those concerns were amplified by public allegations of tens of millions in bad debt backed by illiquid assets. As liquidity drained from USDf pools, Grachev defended the token as 116% overcollateralized and pledged a full asset breakdown. The worst of the deviation, a print to about $0.887 on decentralized exchanges, followed rather than preceded that defense. The market was not persuaded by a number it could not check.",
      ],
    },
    {
      id: "opacity-discount",
      heading: "The opacity discount",
      paragraphs: [
        "The phrase that fits this episode is an opacity discount: the gap between what a token's backing is worth and what holders will pay when they cannot independently see or quickly reach it. USDf's discount had two ingredients, and neither was a mechanism flaw.",
        "The first was where the collateral lived. Falcon's own disclosure during the stress put only about $25 million of reserves (roughly four percent) on-chain, with the remaining ~96% (about $607 million) held off-chain across centralized custodians including Binance, Fireblocks, Ceffu, and ChainUp. Off-chain custody is not inherently unsound; much of USDe's hedge collateral also sits at centralized venues. But it is unverifiable in real time by an outside holder. During a panic driven explicitly by doubts about composition, an attestation that lags reality by days is not a substitute for backing you can watch on a block explorer.",
        "The second was the seven-day redemption cooldown. That cooldown exists for a sound operational reason: Falcon needs a window to unwind off-chain yield strategies before returning assets, so a redemption request takes seven days to settle. But a delta-neutral dollar holds its peg because arbitrageurs buy it cheap and redeem it at par, and that loop only disciplines price if redemption is fast relative to the dislocation. With a week-long lag, and primary redemption gated to whitelisted users, the arbitrage that should have bought $0.887 USDf and closed the gap could not operate on the timescale of the run. The discount persisted because the corrective mechanism was structurally too slow to apply it.",
      ],
    },
    {
      id: "why-transparency-is-a-peg-input",
      heading: "Why transparency is a peg input",
      paragraphs: [
        "The instinctive read is that transparency is a governance virtue: nice to have, orthogonal to whether the peg holds. USDf shows it is a peg input in the literal sense. The same backing, at the same overcollateralization ratio, trades at a different price depending on whether holders can verify and reach it. A 116% claim that cannot be independently checked, redeemed against on demand, or seen on-chain is worth less than backing a holder can confirm, and that difference shows up directly in the secondary-market price.",
        "This is why Pharos does not score a synthetic dollar on its collateral ratio alone. The reserve-transparency and redemption surfaces are first-class inputs: where the backing is custodied, how current the attestation is, whether composition is fully disclosed, and how fast and to whom primary redemption is open. A coin with strong real-time on-chain proof and open redemption earns a structurally tighter band than one whose backing is real but only visible through a delayed off-chain report, even when the dollar value of the collateral is identical.",
        "The mirror image is informative. When USDe printed to ~$0.65 in October 2025, holders could point to a live transparency dashboard and a primary mint-and-redeem channel clearing at par, which is much of why that deviation was correctly read as a venue artifact and mean-reverted within hours. USDf had neither lever fully available during its stress, so a milder fundamental scare produced a deeper and slower-healing deviation. Visibility and redeemability are not the same property as solvency, but under stress they price like they are.",
      ],
    },
    {
      id: "recovery-and-the-audit",
      heading: "Recovery and the audit",
      paragraphs: [
        "USDf recovered to near par within days, with no collateral loss realized, consistent with a confidence shock rather than an insolvency. The mechanism had never stopped working; the panic simply ran ahead of the backing's visibility and then eased. But recovering the price did not retire the underlying critique, which was about what holders could see, not what existed.",
        "Falcon's substantive response came in October 2025 with its first Independent Quarterly Audit by Harris & Trotter LLP under ISAE 3000. As of 22 September 2025 it reported about $1.96 billion in reserves against roughly $1.889 billion USDf outstanding, a 103.87% collateralization ratio, held in segregated, unencumbered accounts, with procedures verifying wallet ownership, collateral valuation, and reserve sufficiency. Grachev framed the result as USDf being 'not only fully collateralized but backed by a diversified reserve base designed for resilience,' and Falcon committed to weekly reserve attestations plus quarterly assurance going forward.",
        "The audit is the right kind of fix because it targets the actual failure, verifiability, rather than the symptom. It does not, however, fully erase the discount's cause. A quarterly assurance report still lags real time, redemption remains gated by the cooldown, and the bulk of collateral remains off-chain. The wound is treated, not closed: USDf trades again at par, but the episode established that its peg carries a transparency premium that on-chain, openly-redeemable designs do not.",
      ],
    },
    {
      id: "lessons",
      heading: "Lessons",
      paragraphs: [
        "The first lesson is that a synthetic dollar can be solvent and still be wounded. USDf's collateral was real, its hedges were market-neutral, and its overcollateralization claim later survived an audit, yet it still printed to $0.887 because holders could not verify or quickly reach the backing while the panic was live. Solvency is necessary for a peg; it is not sufficient when the proof of solvency is slower than the doubt.",
        "The second is that redemption speed is part of the peg, not an operational footnote. A delta-neutral dollar is pinned by arbitrage, and arbitrage requires redemption that is fast relative to the dislocation it is correcting. A seven-day cooldown that exists for legitimate strategy-unwinding reasons is also a week during which the price-disciplining loop is offline. The same gate that protects the reserve from a fast outflow also disarms the mechanism that would defend the peg.",
        "The third is the one that sets this case apart from its peers. USDe survived because its failure was external (a single venue's oracle) and its backing stayed visible and redeemable. USR died because its failure was internal and terminal: a key minted tokens against nothing. USDf sits between them: a structurally scarred survivor whose injury came from opacity and redemption friction, both of which are fixable and partly fixed. The durable signal to track for any synthetic dollar is therefore not just the collateral ratio but the freshness and on-chain share of reserve proof and the speed and openness of primary redemption, the inputs that decide whether real backing earns a tight band or an opacity discount.",
      ],
    },
  ],
  dataWidgets: [
    {
      kind: "peg-deviation",
      coinId: "usdf-falcon",
      caption:
        "USDf peg history on Pharos. The marker pins the July 2025 stress. The DEX low near $0.887 reflects an opacity-and-redemption discount on real backing, not a realized collateral loss; the asset recovered to par within days.",
    },
  ],
  watchpoints: [
    "On-chain share of reserves versus off-chain custody, and how current the attestation is: a delayed report on mostly off-chain backing is the surface that prices an opacity discount under stress.",
    "Redemption speed and access: a multi-day cooldown or whitelist gate disarms the arbitrage that pins a synthetic dollar to par exactly when it is needed most.",
    "Collateral concentration in low-cap or illiquid tokens, and any rule that lets minting against a single asset exceed that asset's own market capitalization (the LlamaRisk DOLO flag).",
    "Whether public solvency claims (overcollateralization ratios) are independently and currently verifiable, or are headline numbers the market must take on faith.",
  ],
  crossLinks: [
    {
      href: "/learn/mechanisms/synthetic-delta-neutral/",
      label: "Mechanism: synthetic delta-neutral dollars",
    },
    {
      href: "/stablecoin/usdf-falcon/",
      label: "USDf on Pharos",
    },
    {
      href: "/learn/case-studies/usde-oracle-2025/",
      label: "Case study: USDe's venue oracle print (the survived peer)",
    },
  ],
  sources: [
    {
      label: "The Defiant: DWF Labs' USDf Stablecoin Briefly Depegs amid Doubts over Collateral and Yield",
      href: "https://thedefiant.io/news/tokens/dwf-labs-usdf-stablecoin-briefly-depegs-amid-doubts-over-collateral-and-yield",
    },
    {
      label: "DL News: DWF CEO pledges asset breakdown as stablecoin breaks $1 peg (89%/11% split, $25M on-chain / $607M off-chain across four custodians)",
      href: "https://www.dlnews.com/articles/defi/dwf-ceo-pledges-asset-breakdown-as-stablecoin-breaks-peg/",
    },
    {
      label: "Cointelegraph: Falcon USD stablecoin depegs amid liquidity and collateral concerns (LlamaRisk DOLO over-issuance flag)",
      href: "https://cointelegraph.com/news/falcon-usd-stablecoin-depegs-liquidity-collateral-concerns",
    },
    {
      label: "Falcon Finance / PR Newswire: Independent Quarterly Audit by Harris & Trotter LLP (103.87% collateralization, ISAE 3000)",
      href: "https://www.prnewswire.com/news-releases/falcon-finance-publishes-independent-quarterly-audit-report-confirming-usdf-fully-backed-by-reserves-302572289.html",
    },
    {
      label: "Falcon Finance documentation: redemptions and the seven-day cooldown",
      href: "https://docs.falcon.finance/mechanism/redemptions",
    },
  ],
  metaDescription:
    "USDf fell to ~$0.887 in July 2025, wounded by opaque off-chain collateral and a 7-day redemption lag, not by its delta-neutral mechanism. The opacity discount.",
  datePublished: "2026-06-15",
};
