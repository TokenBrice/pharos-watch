import type { CaseStudy } from "./types";

/**
 * 2025–2026 — Synthetix passes SIP-420, replacing per-staker debt with a single
 * protocol-owned debt pool and dropping the minting C-ratio to 200%. The change
 * severs the individual arbitrage incentive that had defended the sUSD peg
 * ("it's not your debt anymore"), sUSD oversupplies, and the token grinds down
 * to an ~$0.21 all-time low in August 2025. The demand-engineering repair never
 * restores a durable peg, and in June 2026 a second vote — SIP-423 — freezes and
 * retires sUSD outright. A depeg, and ultimately a death, made by governance
 * votes rather than a hack or an insolvency. susd-synthetix already carries
 * curated annotations (SIP-420 + the ATL) — this study references them, it does
 * not add new ones.
 */
export const content: CaseStudy = {
  slug: "susd-sip420-2025",
  eyebrow: "Governance depeg",
  title: "sUSD and SIP-420: the depeg a governance vote chose",
  subtitle:
    "Synthetix did not get hacked and did not go insolvent. It voted to pool its debt and drop the collateral ratio — removing the very incentive that had kept sUSD at a dollar — then, a year later, voted to freeze and retire the token outright.",
  lead: [
    "sUSD is Synthetix's crypto-collateralized dollar: a CDP-style stablecoin minted against staked SNX. For most of its life the peg was defended by a simple reflexive loop — each staker carried their own share of the system's sUSD debt, so whenever sUSD traded below a dollar, those stakers had a direct incentive to buy it back cheap and burn it to close their position at a discount. That individual arbitrage, repeated across thousands of stakers, was the mechanism that pulled the price back to par.",
    "In 2025 a governance proposal, SIP-420, deliberately dismantled that loop. It moved nearly all individual debt into a single protocol-owned pool and dropped the minting ratio for the pool to 200%, far below the several-hundred-percent ratios solo stakers had carried. The intent was capital efficiency and simpler staking. The side effect was that debt was no longer personal: a staker who deposited into the pool had their obligation forgiven over twelve months and no longer had a reason to defend the peg with their own balance sheet. The phrase that captures it is \"it's not your debt anymore.\"",
    "With the repeg incentive severed and the lower ratio making minting cheap, sUSD oversupplied. It slid to roughly $0.664 in April 2025 when the change took effect, and kept grinding down to an all-time low near $0.21 in August — an ~80% drawdown — while its float stubbornly stayed alive around the low-30-millions. This is the lesson none of the other studies on Pharos cover: a live CDP can be depegged by its own governance — and, when a hand-built repair fails to bring it back, retired by governance too. In June 2026, after more than a year below par, Synthetix passed SIP-423 and wound sUSD down: the token was frozen, a holder snapshot taken, and sUSD made permanently non-transferable, with holders repaid in vested SNX.",
  ],
  takeaways: [
    "This was a self-inflicted governance depeg, not a hack or an insolvency: SIP-420 pooled per-staker debt and dropped the minting ratio to 200%, and sUSD lost its peg as a direct consequence of the vote.",
    "The mechanism that broke was the reflexive repeg incentive — when debt stopped being personal (\"it's not your debt anymore\"), individual stakers no longer had a reason to buy sUSD back below a dollar and burn it.",
    "Cheaper minting plus a dead arbitrage loop produced a persistent oversupply: sUSD dominated the majority of its own liquidity pools and bottomed near $0.21 in August 2025, roughly an 80% drawdown, yet the float never collapsed.",
    "The demand-side repair — 420-pool lockups, a ratcheting staking requirement, and fee-funded buybacks rather than reverting the ratio — never restored a durable peg, and in June 2026 governance gave up and retired sUSD via SIP-423: the contract frozen, a holder snapshot taken, and holders repaid four SNX per sUSD in vested form.",
  ],
  primaryCoinId: "susd-synthetix",
  archetype: "cdp",
  outcome: "died",
  eventDateLabel: "2025–2026",
  eventWindow: {
    startISO: "2025-04-18",
    endISO: "2026-06-26",
    peakDeviationBps: -7900,
    lowPrice: 0.21,
  },
  timeline: [
    {
      dateISO: "2025-01-06",
      headline: "SIP-420 is drafted: a protocol-owned debt pool",
      body: "Synthetix publishes SIP-420, proposing to consolidate individual staker debt into a single protocol-owned \"420\" pool. Pool participants would mint against a 200% issuance ratio and have their legacy debt forgiven linearly over twelve months, while solo staking is discouraged with a punitive ratio. The proposal's stated goal is capital efficiency and simpler staking.",
      severity: "low",
      href: "https://sips.synthetix.io/sips/sip-420/",
    },
    {
      dateISO: "2025-04-18",
      headline: "The 420 Pool goes live; sUSD slides toward $0.664",
      body: "As the pooled-debt model takes effect, sUSD breaks down to roughly $0.664 — a ~34% deviation — with intraday prints lower still. Synthetix launches the 420 Pool the same day, offering 5 million SNX over twelve months to stakers who lock sUSD, the first of the demand-side measures.",
      severity: "high",
      href: "https://cointelegraph.com/news/synthetic-usd-stablecoin-fall-new-lows-depeg",
    },
    {
      dateISO: "2025-04-21",
      headline: "Oversupply takes hold across the pools",
      body: "With the individual repeg arbitrage gone and minting cheaper, sUSD oversupplies and dominates its own liquidity venues — at points making up well over 75% of major Curve pairs, the on-chain signature of holders trying to exit a coin with no natural buyer of last resort. On-chain analysts attribute the depeg to the SIP-420 incentive change rather than to bad debt or any backing failure.",
      severity: "high",
    },
    {
      dateISO: "2025-08-31",
      headline: "All-time low near $0.21",
      body: "After months of persistent surplus and a falling SNX, sUSD bottoms around $0.21 — roughly an 80% drawdown from par and its deepest level on record. Notably the supply does not collapse: a float in the low-30-millions stays outstanding, so the failure presents as a sustained discount rather than a death spiral.",
      severity: "high",
    },
    {
      dateISO: "2026-02-12",
      headline: "\"Rebuilding sUSD\": the staking ratchet",
      body: "Synthetix raises the in-pool sUSD staking requirement to 50% of jubileed debt and schedules automatic 10% increases every two weeks until the requirement hits 100% or sUSD trades above $0.98. Combined with fee-funded buybacks, the team frames roughly $5 million of support as enough to restore lasting stability, targeting a repeg by early Q2 and sustained stability by mid-2026.",
      severity: "med",
      href: "https://blog.synthetix.io/rebuilding-susd/",
    },
    {
      dateISO: "2026-06-19",
      headline: "SIP-423 vote approves sUSD retirement",
      body: "The demand engineering never restores a durable peg. In June 2026 Synthetix governance approves SIP-423 — its first proposal to wind sUSD down rather than repair it. The contract is frozen and a holder snapshot taken, making sUSD permanently non-transferable; remaining holders are repaid four SNX per sUSD (SNX valued at $0.25) under a one-year lock and one-year vest. The depeg a vote chose is ended by another vote.",
      severity: "high",
      href: "https://sips.synthetix.io/sips/sip-423/",
    },
  ],
  sections: [
    {
      heading: "What happened",
      paragraphs: [
        "sUSD is minted against staked SNX, which makes it a collateralized debt position in the same family as Dai or crvUSD — value comes from over-collateralized backing, not from a bank reserve or a delta-neutral hedge. Through 2025 nothing went wrong with that backing in the conventional sense. There was no exploit, no oracle failure, and no insolvency event in which collateral fell short of the debt it secured. The coin simply stopped trading at a dollar and stayed there.",
        "The proximate cause was a vote. SIP-420 restructured how Synthetix carries debt: instead of each SNX staker owning a personal slice of the system's outstanding sUSD, the protocol pooled that debt into a single contract it owns and manages, and lowered the issuance ratio for the pool to 200%. sUSD broke toward $0.664 as the change took effect in April, oversupplied through the summer, and reached an all-time low near $0.21 in August. The discount narrowed at times but never closed, and after more than a year below par Synthetix stopped trying to repair it: in June 2026 SIP-423 froze the token and retired it, repaying holders in vested SNX. What began as a wound became, by governance choice, a decommissioning.",
      ],
    },
    {
      heading: "SIP-420 and the broken repeg incentive",
      paragraphs: [
        "Every CDP stablecoin needs a force that pushes the price back up when it trades below peg. In sUSD's original design that force was the staker. Because each staker personally owed a share of the outstanding sUSD, a price below a dollar was an opportunity: buy sUSD cheap on the market, burn it against your own debt, and close your position for less than a dollar of value per unit retired. Thousands of self-interested stakers running that trade was the repeg engine. It was reflexive, decentralized, and required no treasury.",
        "SIP-420 turned that debt over to the protocol. Once a staker migrated into the 420 pool, their obligation was scheduled to be forgiven over twelve months and was no longer theirs to defend — \"it's not your debt anymore.\" The arbitrage that depended on individual ownership of debt simply had no one to run it. The lower 200% issuance ratio compounded the problem from the other side by making fresh sUSD cheaper to mint. So the change weakened the demand for sUSD below peg and strengthened the supply of it at the same time.",
        "It is worth being precise about what kind of risk this is. The collateral was sound; the disclosures were honest; the protocol was solvent. What failed was a behavioral mechanism that the governance process chose to remove on purpose, in exchange for capital efficiency. That is self-inflicted mechanism risk on a live CDP — a failure mode that does not show up in reserve attestations or collateral-quality scores because it lives in the incentive design, not the balance sheet.",
      ],
    },
    {
      heading: "The oversupply spiral",
      paragraphs: [
        "With the repeg buyer gone and minting cheaper, sUSD accumulated faster than the market wanted to hold it. The clearest on-chain tell was pool composition: sUSD came to make up the large majority — at points well over 75%, and on some pairs far higher — of the Curve liquidity meant to keep it near a dollar. A stablecoin dominating its own pools is the visible shape of one-way selling: holders rotating out, with the automated market maker absorbing the imbalance and the price grinding lower as it does.",
        "Two reinforcing pressures deepened the slide. A falling SNX through the period reduced confidence in the collateral asset and the staking yield that was supposed to anchor demand, and the absence of a reflexive buyer meant nothing leaned against the drift. Crucially, though, this never became a Terra-style death spiral. There was no reflexive mint-and-dump link between sUSD and SNX of the kind that destroyed UST; the supply stayed roughly flat in the low-30-millions while the price fell. The system found a depressed equilibrium and sat in it, which is exactly why the outcome here is a durable discount rather than a collapse.",
      ],
    },
    {
      heading: "The road back: lockups and the staking ratchet",
      paragraphs: [
        "Synthetix chose not to reverse SIP-420. Rather than re-raising the collateral ratio to resurrect the old per-staker arbitrage, it set out to manufacture demand and throttle supply directly. The first lever was the 420 Pool itself: locking sUSD for a year against SNX rewards (with rewards vesting over a further three months) pulled float out of circulation and out of the liquidity pools that had been pricing the discount.",
        "The second lever was a ratcheting staking requirement. By early 2026 the protocol required pool participants to hold a rising share of their forgiven debt as staked sUSD — escalated from an initial 10%, through 20%, to 50% of jubileed debt with the \"Rebuilding sUSD\" update, plus automatic 10% increases every two weeks until the requirement reaches 100% or sUSD trades above $0.98. In effect the protocol re-imposed a synthetic version of the obligation SIP-420 had forgiven, but routed through pool rules rather than individual incentives.",
        "Underneath both sat demand from protocol revenue: fee-funded buybacks, including a portion of perps trading revenue and capped on-market purchases, plus integrations meant to create structural sinks for sUSD. The team's stated arithmetic was that on the order of $5 million of coordinated support would be enough to re-establish stability, with a repeg targeted around early Q2 2026 and sustained stability by mid-2026. The shape of the attempted recovery is the inverse of the break: where one vote could sever the incentive overnight, rebuilding demand by hand is a months-long grind — and in this case one that never reached par.",
      ],
    },
    {
      heading: "How it ended: SIP-423 and the wind-down",
      paragraphs: [
        "The demand engineering bought time but not a peg. Lockups, the staking ratchet, and fee-funded buybacks narrowed the discount in stretches, yet sUSD never reclaimed a durable dollar; it kept changing hands well below par on a float that refused either to recover or to disappear. Synthetix's own framing shifted from repair to triage — founder Kain Warwick described the remaining tail as functionally insolvent without exchange revenue to backstop it, and the treasury had already absorbed roughly a third of the supply over the prior year.",
        "In June 2026 governance drew the line. SIP-423 — the first Synthetix proposal to wind sUSD down rather than fix it — froze the contract, took a holder snapshot, and made sUSD permanently non-transferable. Rather than a cash buyback the protocol judged value-destructive, holders are repaid four SNX per sUSD, valuing SNX at $0.25 against sUSD's $1.00 face, under a one-year lock and one-year vest; sUSD held in LP and deposit contracts is handled through a separate claims process. The same governance machinery that severed the peg in SIP-420 used the same lever to bury the token.",
      ],
    },
    {
      heading: "Lessons",
      paragraphs: [
        "Governance is part of the peg. A CDP stablecoin's stability rests not only on its collateral but on the incentive that pulls it back to par, and that incentive can be legislated away by a vote even when the backing is untouched. When assessing a crypto-collateralized dollar, the question is not only \"what backs it\" but \"who is structurally motivated to buy it below a dollar, and could that motivation be changed by governance?\" SIP-420 answered that question the hard way.",
        "Capital efficiency and peg defense can be in direct tension. Lowering a collateral ratio and pooling debt genuinely improves capital efficiency and reduces the death-spiral risk a founder rightly pointed to — but the same change can remove the reflexive arbitrage that defended the peg in the first place. There is no free lunch: a more efficient CDP may be a less self-correcting one. The honest read on sUSD is that it never recovered from its own redesign: more than a year of demand-engineering failed to manufacture the buyer the vote had removed, and in the end the same governance process retired the token rather than restore it. Solvency was never the question — an incentive was legislated away, and a stablecoin died of it.",
      ],
    },
  ],
  dataWidgets: [
    {
      kind: "peg-deviation",
      coinId: "susd-synthetix",
      caption:
        "sUSD's peg-deviation history on Pharos — the curated markers pin the April 2025 SIP-420 change and the August 2025 all-time low near $0.21, then a grind that never reclaimed par before SIP-423 froze the token in June 2026.",
    },
  ],
  watchpoints: [
    "Governance as a peg risk: a CDP's stability can rest on an incentive that a single vote can remove, even when collateral, disclosures, and solvency are all intact.",
    "Pool composition as an oversupply gauge: a stablecoin dominating its own Curve and stable pools is the on-chain signature of one-way selling with no buyer of last resort.",
    "Demand-engineered repegs — lockups, staking ratchets, fee-funded buybacks — can arrest a slide without restoring a durable peg; temporary support is not a self-correcting mechanism.",
    "When a protocol's own founder calls the remaining float \"functionally insolvent\" and the treasury is steadily absorbing supply, retirement rather than recovery becomes the likely endgame.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/cdp/", label: "How CDP stablecoins work" },
    { href: "/stablecoin/susd-synthetix/", label: "sUSD frozen archive and risk" },
    { href: "/cemetery/", label: "Stablecoin cemetery" },
    {
      href: "/learn/case-studies/crvusd-exploit-trilogy/",
      label: "Case study: crvUSD, the CDP that absorbed its shocks",
    },
    {
      href: "/learn/case-studies/usd0pp-usual-2025/",
      label: "Case study: USD0++, the other 2025 governance-terms depeg",
    },
  ],
  sources: [
    {
      label: "Synthetix — SIP-420: protocol-owned debt pool",
      href: "https://sips.synthetix.io/sips/sip-420/",
    },
    {
      label: "Synthetix — SIP-423: freeze and retire sUSD (4:1 SNX repayment)",
      href: "https://sips.synthetix.io/sips/sip-423/",
    },
    {
      label: "Synthetix — Rebuilding sUSD (staking ratchet and repeg plan)",
      href: "https://blog.synthetix.io/rebuilding-susd/",
    },
    {
      label: "Cointelegraph — What happened to sUSD? How a crypto-collateralized stablecoin depegged",
      href: "https://cointelegraph.com/explained/what-happened-to-susd-how-a-crypto-collateralized-stablecoin-depegged",
    },
    {
      label: "Cointelegraph — Synthetix's sUSD stablecoin continues fall after depeg, tapping $0.68",
      href: "https://cointelegraph.com/news/synthetic-usd-stablecoin-fall-new-lows-depeg",
    },
    {
      label: "Synthetix — sUSD peg update (420 Pool, buybacks, Infinex rewards)",
      href: "https://blog.synthetix.io/synthetix-susd-peg-update/",
    },
  ],
  metaDescription:
    "How Synthetix's SIP-420 vote depegged sUSD by killing its repeg incentive — and how SIP-423 froze and retired the token in 2026. A governance-made CDP death.",
  datePublished: "2026-06-15",
};
