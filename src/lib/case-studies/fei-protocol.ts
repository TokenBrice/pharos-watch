import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "fei-protocol",
  eyebrow: "Algorithmic collapse",
  title: "Fei Protocol: the peg that broke at birth",
  subtitle:
    "A $1.3B genesis raise and a reflexive incentive engine could not hold the dollar; after an $80M lending hack, Tribe DAO voted to wind the whole thing down.",
  lead: [
    "Fei Protocol launched in April 2021 as one of the most heavily funded experiments in decentralized stablecoin design. Its genesis event drew roughly 639,000 ETH (about $1.3B at the time), and the asset arrived with a novel pitch: instead of holding fiat in a bank or over-collateralizing with volatile crypto, FEI would defend its dollar peg through a combination of bonding curves, algorithmic reweights, and a pool of Protocol Controlled Value (PCV) the protocol itself owned and managed.",
    "The defense mechanism was called direct incentives. Selling FEI below a dollar triggered a burn penalty that scaled with the size of the deviation, while buying back toward the peg earned a reward. The intent was to make running for the exit expensive enough that the peg would self-correct. In practice the design inverted: FEI traded below a dollar almost immediately, the burn penalty trapped holders who wanted out, and each algorithmic reweight became the single best moment to dump, restarting the slide.",
    "Fei survived the launch shock and eventually clawed back to parity, then removed direct incentives entirely in a V2 redesign. But the deeper problem, that PCV is not the same thing as guaranteed redeemability, was never fully resolved. After Fei merged with Rari Capital to form Tribe DAO and an $80M reentrancy exploit drained the merged lending markets in April 2022, governance fractured. In August 2022, in the aftermath of Terra's collapse, Fei Labs proposed winding the project down; by late September, the redemption path was active and the asset was effectively abandoned.",
  ],
  takeaways: [
    "Reflexive incentives are fragile peg defenses: FEI's burn penalty on sub-peg sells trapped holders instead of creating buyers, and each algorithmic reweight became the best moment to dump: it depegged to ~$0.73 within days of launch.",
    "Protocol Controlled Value is not redeemability: owning reserves is not the same as giving every holder a clean, guaranteed claim to par.",
    "Merger complexity compounds failure: binding the stablecoin to Rari's Fuse lending markets meant an $80M reentrancy exploit became an existential question for the peg.",
    "When a governance vote, not a market, decides an asset's fate, the signal is the politics of loss allocation: Tribe DAO chose to wind down and redeem FEI 1:1 for DAI in August 2022.",
  ],
  archetype: "algorithmic",
  outcome: "died",
  eventDateLabel: "2021-2022",
  eventWindow: {
    startISO: "2021-04-03",
    endISO: "2022-09-22",
    lowPrice: 0.73,
  },
  cemeteryId: "fei-fei-usd-2022-08",
  timeline: [
    {
      dateISO: "2021-04-03",
      headline: "Genesis closes with ~639K ETH raised, and the peg breaks within days",
      body: "Fei's three-day genesis event ended on 3 April 2021 with roughly 639,000 ETH committed, around $1.3B at the time. Demand far exceeded what the bonding-curve design anticipated. FEI slid below a dollar almost immediately, with CoinGecko showing a low near $0.73 on 7 April and the asset staying well below peg for much of the month.",
      severity: "high",
    },
    {
      dateISO: "2021-04-07",
      headline: "Direct incentives trap holders rather than defend the peg",
      body: "The burn penalty on sub-peg sells made exiting punitive, while algorithmic reweights paradoxically created the most favorable moment to sell. Each reweight prompted a fresh rush for the door, knocking FEI off peg again. Over a billion dollars of contributed ETH sat effectively locked behind the penalty.",
      severity: "high",
    },
    {
      dateISO: "2021-10-06",
      headline: "Fei V2 announced, dropping direct incentives and reweights",
      body: "Conceding the original peg-maintenance design was unsustainable, the team unveiled Fei V2. It abandoned direct incentives and reweights and made FEI redeemable one-to-one against PCV reserves, shifting the model from reflexive deterrence toward collateral backing. The redesign rolled out in stages, with the main components going live that December.",
      severity: "med",
    },
    {
      dateISO: "2021-12-21",
      headline: "Fei merges with Rari Capital to form Tribe DAO",
      body: "On 21 December 2021, after approval votes passed on both sides, Fei Protocol combined with the Rari Capital lending platform under a single Tribe DAO governance structure, commanding roughly $2B in combined value. The merger entangled the stablecoin's treasury and governance with Rari's permissionless Fuse lending pools.",
      severity: "low",
    },
    {
      dateISO: "2022-04-30",
      headline: "$80M reentrancy exploit drains Rari Fuse pools",
      body: "An attacker exploited a reentrancy bug in Rari's Fuse markets, re-entering via exitMarket() to bypass a global lock that an April patch had failed to extend to that function. More than $80M was drained across several pools. The protocol offered to let the attacker keep $10M as a bounty; the offer went unanswered and the funds were laundered.",
      severity: "high",
      href: "https://www.coindesk.com/business/2022/04/30/defi-lender-rari-capitalfei-loses-80m-in-hack",
    },
    {
      dateISO: "2022-08-19",
      headline: "Fei Labs proposes a wind-down",
      body: "Citing mounting technical, financial, and regulatory risk in the post-Terra climate, Fei Labs proposed dissolving Tribe DAO. The proposal sketched one-to-one FEI redemption for DAI, pro rata PCV distribution to TRIBE holders, and a contentious compromise over Rari hack reimbursement.",
      severity: "high",
      href: "https://www.axios.com/2022/08/25/algorithmic-stablecoin-tribedao-fei",
    },
    {
      dateISO: "2022-09-22",
      headline: "Redemption plan passes and the protocol enters wind-down",
      body: "After another round of governance, Tribe DAO moved ahead with hack repayment and the wind-down path. FEI became redeemable one-to-one for DAI, TRIBE holders could redeem against remaining PCV, and most protocol functions were effectively suspended.",
      severity: "high",
      href: "https://blockworks.co/news/fei-flips-again-repays-crypto-hack-victims",
    },
  ],
  sections: [
    {
      heading: "The direct-incentive experiment",
      paragraphs: [
        "Fei's central claim was that a stablecoin could hold its peg without a bank account full of dollars and without locking up far more crypto collateral than the coins it issued. FEI minted along a bonding curve against ETH, and the protocol kept the ETH it received as Protocol Controlled Value, reserves owned by the protocol rather than by individual depositors who could withdraw at will.",
        "Direct incentives were the enforcement layer. Trades that pushed FEI below a dollar paid a burn penalty that grew with the size of the deviation; trades that pushed it back toward a dollar earned a reward. The theory was elegant: make defection costly and the rational trader defends the peg for you. It is a reflexive design, leaning on the assumption that participants will respond to incentives the way the model predicts.",
        "Pharos classifies Fei under the algorithmic archetype precisely because its peg defense rested on protocol-enforced incentives and supply mechanics rather than on a redemption claim against safe, liquid reserves. That classification is the lens for everything that followed.",
      ],
    },
    {
      heading: "Why it depegged at birth",
      paragraphs: [
        "The genesis event raised far more than the mechanism was tuned for. A large cohort of participants had bought FEI below a dollar expecting it to converge upward, and many also wanted their ETH back. When FEI failed to snap to a dollar, those holders tried to leave at once.",
        "The burn penalty meant selling sub-peg was expensive, so it did not stop the selling, it just punished it and trapped the people who could not afford the hit. Worse, the algorithmic reweights, intended to nudge price back to a dollar, became the most attractive moment to exit, because that was when a seller could get the best available price. Each reweight therefore triggered a fresh wave of selling that knocked FEI off peg again. FEI bottomed in the low-$0.70s, with CoinGecko marking roughly $0.73 on 7 April, and stayed well below a dollar for much of April 2021 before slowly recovering.",
        "This is the structural lesson of the launch: an incentive engine that assumes orderly behavior can amplify a panic instead of damping it. Reflexive peg defense works when confidence is high and fails exactly when it is most needed.",
      ],
    },
    {
      heading: "The Rari hack and the end",
      paragraphs: [
        "Fei removed direct incentives in its V2 redesign in late 2021 and made FEI redeemable one-to-one against PCV, a meaningful move toward genuine backing. It then merged with Rari Capital to form Tribe DAO, binding the stablecoin's treasury and governance to Rari's Fuse lending pools.",
        "On 30 April 2022 an attacker exploited a reentrancy bug in those pools, a variant of the long-known Compound-fork vulnerability, re-entering through the exitMarket() function that an earlier patch had left unprotected. Roughly $80M was drained. A $10M bounty went unanswered as the proceeds were laundered, leaving Tribe DAO to decide who would bear the loss.",
        "That decision split the community. An initial vote to fully repay depositors was overridden, and the reimbursement fight bled into the broader collapse of confidence after Terra. In August 2022 Fei Labs proposed a wind-down, and by late September Tribe DAO had moved ahead with redemption: FEI holders could redeem one-to-one for DAI and remaining assets would be distributed to TRIBE holders. The protocol that raised $1.3B to reinvent the stablecoin chose to dissolve itself. The on-chain unwind and contract closures stretched on well past the vote.",
      ],
    },
    {
      heading: "Lessons",
      paragraphs: [
        "Reflexive incentives are fragile peg defenses. A penalty that punishes sellers does not create buyers; under stress it traps holders and can intensify the very flight it was meant to prevent. Fei demonstrated this within days of launch, before any external shock.",
        "Protocol Controlled Value is not the same as redeemability. Holding reserves the protocol owns is not equivalent to giving every holder a clean, guaranteed claim to par. Fei's eventual one-to-one DAI redemption in the wind-down showed the asset was redeemable in the end, but the value of that promise depended entirely on a solvent treasury and a governance willing to honor it.",
        "Governance and merger complexity compound failure. The Rari merger meant a smart-contract exploit in a lending product became an existential question for the stablecoin, and the dispute over who absorbed the loss eroded the trust a peg ultimately runs on. When the engineering, the treasury, and the politics are all entangled, a single break can take down the whole structure.",
      ],
    },
  ],
  watchpoints: [
    "Treat incentive-based peg defense as conditional on confidence. Burn penalties and reweights help when sentiment is calm and can backfire when holders are already trying to leave.",
    "Distinguish reserves owned by a protocol from a redemption claim held by users. PCV-style backing is only as good as the path from holder to par, and the governance willing to honor it.",
    "Watch for entanglement risk when a stablecoin issuer merges with or operates a separate lending or yield product, since a failure there can become the stablecoin's problem.",
    "When a governance vote, rather than a market or a redemption window, becomes the deciding event for an asset's fate, the relevant signal is the politics of loss allocation, not the peg chart.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/algorithmic/", label: "Mechanism: Algorithmic stablecoins" },
    { href: "/learn/case-studies/terra-ust-2022/", label: "Case study: Terra, the algorithmic collapse that followed" },
    { href: "/learn/case-studies/iron-titan-2021/", label: "Case study: IRON Finance's fractional-algo run" },
    { href: "/cemetery/", label: "Stablecoin Cemetery" },
  ],
  sources: [
    {
      label: "Cointelegraph: Fei Labs raises 639K ETH in genesis event",
      href: "https://cointelegraph.com/news/fei-labs-raises-639k-eth-in-genesis-event",
    },
    {
      label: "CoinDesk: $1B Fei Stablecoin's Rocky Start Is a Wake-Up Call for DeFi Investors",
      href: "https://www.coindesk.com/markets/2021/04/07/1b-fei-stablecoins-rocky-start-is-a-wake-up-call-for-defi-investors",
    },
    {
      label: "CoinDesk: DeFi Lender Rari Capital/Fei Loses $80M in Hack",
      href: "https://www.coindesk.com/business/2022/04/30/defi-lender-rari-capitalfei-loses-80m-in-hack",
    },
    {
      label: "CertiK: Revisiting the FEI Protocol Incident (exitMarket reentrancy analysis)",
      href: "https://www.certik.com/ko/blog/revisiting-fei-protocol-incident",
    },
    {
      label: "Axios: Another algorithmic stablecoin looks like it is giving up",
      href: "https://www.axios.com/2022/08/25/algorithmic-stablecoin-tribedao-fei",
    },
    {
      label: "The Defiant: Fei Community Up In Arms Over Dissolution Plan",
      href: "https://thedefiant.io/news/defi/fei-shutdown-uproar",
    },
    {
      label: "Blockworks: Fei flips again, repays crypto hack victims",
      href: "https://blockworks.co/news/fei-flips-again-repays-crypto-hack-victims",
    },
  ],
  metaDescription:
    "Fei raised $1.3B and defended its peg with reflexive incentives and PCV. It depegged at launch, took an $80M hack, and Tribe DAO voted to wind it down.",
  datePublished: "2026-05-23",
};
