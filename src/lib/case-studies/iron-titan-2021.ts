import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "iron-titan-2021",
  eyebrow: "Algorithmic collapse",
  title: "IRON Finance & TITAN: the algorithmic prequel to Terra",
  subtitle:
    "A partially collateralized stablecoin whose redemption loop minted its own share token into oblivion: crypto's first large-scale bank run, eleven months before UST.",
  lead: [
    "IRON was a dollar stablecoin on Polygon, built as a fork of the Frax fractional-algorithmic design. Each unit was redeemable for a mix of USDC and TITAN, the protocol's volatile share token, with the split governed by a target collateral ratio that had been ratcheted down to roughly 75% USDC and 25% TITAN. While confidence held, the arbitrage between minting and redemption kept IRON close to a dollar.",
    "On 16 June 2021 that arbitrage inverted. Large holders pulled liquidity and sold, IRON slipped below peg, and the redemption path began minting fresh TITAN into a falling market. A lagging ten-minute price oracle valued TITAN higher than its collapsing spot price, handing arbitrageurs a guaranteed spread that they pressed relentlessly. TITAN's supply hyperinflated from a planned cap toward tens of trillions of tokens and its price ran from the mid-sixties to effectively zero within a single trading session.",
    "Total value locked had crested in the multi-billion-dollar range days earlier, and losses were widely cited at around $2 billion, though that headline figure mostly reflected vaporized paper gains rather than dollars paid in. Mark Cuban, who described himself as a liquidity provider rather than a backer, was among those caught in the collapse, which pushed the failure into mainstream coverage. The team described it in their post-mortem as the world's first large-scale crypto bank run. It was also, in hindsight, a near-exact rehearsal of the reflexive death spiral that would destroy TerraUSD and LUNA the following May, a warning the wider market largely ignored.",
  ],
  takeaways: [
    "IRON's redemption minted its volatile share token TITAN rather than transferring it, so sub-peg selling printed fresh TITAN into a falling market: a reflexive loop with no floor above zero.",
    "A lagging ten-minute price oracle valued TITAN above spot during a fast crash, handing arbitrageurs a guaranteed spread that drained the system; oracle design was part of the attack surface, not a detail.",
    "Partial collateralization softened the landing (the USDC reserve let IRON holders still redeem ~$0.74-$0.75), but it did not remove the reflexive core that took TITAN to zero.",
    "The morning wave's recovery was the trap: surviving a tremor only reloaded the same mechanism, eleven months before the same structure destroyed UST and LUNA.",
  ],
  archetype: "algorithmic",
  outcome: "died",
  eventDateLabel: "June 2021",
  eventWindow: {
    startISO: "2021-06-16",
    endISO: "2021-06-17",
    peakDeviationBps: -2600,
    lowPrice: 0.74,
  },
  cemeteryId: "iron-iron-2021-06",
  timeline: [
    {
      dateISO: "2021-05-20",
      headline: "Polygon launch fuels parabolic growth",
      body: "After expanding to Polygon, IRON Finance drew capital with farming rewards advertised in the hundreds and thousands of percent APR. Total value locked climbed from tens of millions in mid-May toward billions within weeks as TITAN appreciated more than a hundredfold from its launch price.",
      severity: "low",
    },
    {
      dateISO: "2021-06-15",
      headline: "TVL peaks above $3 billion",
      body: "Protocol deposits crested over $3 billion and TITAN traded near its all-time high in the mid-sixties of dollars. The target collateral ratio sat near 75% USDC, leaving roughly a quarter of each redemption backed by the volatile TITAN share token.",
      severity: "med",
    },
    {
      dateISO: "2021-06-16",
      headline: "First wave: a wobble that recovered",
      body: "Around 10:00 UTC, large liquidity providers withdrew from the IRON/USDC pool and sold, knocking IRON off peg. TITAN fell from roughly $65 to about $30 within two hours, then recovered toward $52 as IRON returned to a dollar, an early-warning tremor the protocol survived.",
      severity: "high",
    },
    {
      dateISO: "2021-06-16",
      headline: "Second wave: the death spiral",
      body: "Near 15:00 UTC big holders sold again, triggering panic redemptions. Because the redemption price relied on a ten-minute time-weighted average, the oracle reported a stale, higher TITAN value than spot; arbitrageurs bought sub-dollar IRON and redeemed it, minting ever more TITAN into a collapsing market. TITAN's supply ballooned past its intended cap and its price ran toward zero.",
      severity: "high",
    },
    {
      dateISO: "2021-06-17",
      headline: "Redemptions freeze, then settle on the USDC floor",
      body: "As TITAN approached zero the redemption contract began reverting; the team queued a fix to reopen USDC redemptions at 17:00 UTC on 17 June. With TITAN worthless, the residual claim was the USDC reserve: IRON holders were left able to redeem roughly $0.74 to $0.75 per token against the remaining collateral, the share still backed by cash.",
      severity: "high",
    },
  ],
  sections: [
    {
      heading: "What happened",
      paragraphs: [
        "IRON Finance ran a fractional-algorithmic stablecoin on Polygon, modeled on Frax. Minting one IRON required depositing USDC plus an amount of TITAN set by the target collateral ratio; redeeming one IRON returned the same split of value. The design had walked the ratio down from fully collateralized toward roughly 75% USDC and 25% TITAN, so a meaningful slice of every redemption settled in a token whose only support was protocol demand.",
        "The collapse came in two waves on 16 June 2021. The morning sell-off pushed IRON off peg and TITAN from the mid-sixties toward $30 before both recovered, which read as an ordinary correction. The afternoon wave did not recover. Renewed selling drove sustained sub-dollar redemptions, and within hours TITAN had gone from a mid-sixties dollar price to effectively zero, with supply expanding far beyond its planned ceiling.",
        "The economic damage tracked the run-up: value commonly cited at roughly $2 billion evaporated against a multi-billion-dollar peak in total value locked, with much of that headline loss representing unrealized TITAN gains rather than fresh dollars committed. IRON itself did not vanish (its USDC reserve survived), but TITAN's destruction made the share token worthless and left IRON redeemable only for the cash leg, around $0.74 to $0.75. The protocol was decommissioned. Pharos shadow-tracks IRON for Pharos Stability Index calibration without surfacing a public coin page.",
      ],
    },
    {
      heading: "The fractional-algorithmic redemption loop",
      paragraphs: [
        "The fatal property was that redemption did not merely transfer TITAN: it minted it. When IRON traded below a dollar, anyone could buy the discounted stablecoin and redeem it for roughly $0.75 in USDC plus $0.25 in newly issued TITAN, then sell that TITAN immediately. Each pass through the loop printed fresh supply into a market that was already falling, so the more aggressively arbitrageurs closed the discount, the faster TITAN diluted toward zero.",
        "A lagging oracle turned the loop reflexive. The redemption price for TITAN used a ten-minute time-weighted average, so during a fast decline the contract valued TITAN well above its spot price. That gap was a guaranteed spread: redeem at the stale, higher oracle value, sell at the lower live price, and pocket the difference. On Polygon, where blocks clear in seconds, a ten-minute average lagged badly enough that the spread persisted as long as anyone kept selling.",
        "The result was a self-reinforcing feedback loop with no natural floor above zero. Falling TITAN meant each redemption had to mint more TITAN to deliver the fixed dollar value, which depressed the price further, which widened the oracle spread, which invited more redemptions. Supply that was meant to be capped near a billion tokens expanded into the trillions. Only the hard USDC reserve, the part that was never algorithmic, set a real floor under IRON itself.",
      ],
    },
    {
      heading: "Why it was the Terra prequel",
      paragraphs: [
        "TITAN was to IRON what LUNA would become to UST: a volatile share token absorbing the stablecoin's demand shocks through a mint-and-burn redemption mechanism. In both systems the stabilizing arbitrage was symmetric only in calm markets. Once confidence broke and redemptions ran one way, the mechanism that was supposed to defend the peg instead minted the share token into hyperinflation: the same reflexive death spiral, differing mainly in scale and in the absence of an oracle lag in Terra's case.",
        "IRON ran the experiment first, in June 2021, roughly eleven months before UST broke in May 2022. It was smaller and partially collateralized, so it kept a USDC backstop that Terra lacked, but the failure mode was identical in structure: a token whose supply is endogenous to its own price cannot anchor a peg through a panic. The lesson was available, documented in a public post-mortem, and largely set aside as a Polygon-specific accident rather than a category warning.",
        "For Pharos this is why IRON is preserved rather than discarded. Its series is one of the inputs used to calibrate how the Pharos Stability Index scores reflexive, share-token-backed designs, alongside the later and far larger Terra collapse. The two events bracket the same structural flaw, and reading them together makes the pattern legible rather than treating each as a one-off.",
      ],
    },
    {
      heading: "Lessons",
      paragraphs: [
        "A stablecoin whose collateral includes its own protocol's share token carries the peg's stress directly into that token's supply. When the share token is minted on redemption, selling pressure on the stablecoin becomes inflationary pressure on the share token, and the two reinforce each other downward. Partial collateralization softens the landing (IRON holders kept a cash claim), but it does not remove the reflexive core.",
        "Oracle design is not a detail in these systems; it is part of the attack surface. A time-weighted average chosen for manipulation resistance can, in a fast crash on a fast chain, hand arbitrageurs a standing spread between stale redemption prices and live spot. The same averaging window that protects against a single malicious block can subsidize an orderly drain when the whole market is moving one direction.",
        "Finally, the first wave's recovery was the trap. The morning bounce on 16 June read as resilience and bought the system credibility hours before the afternoon wave proved that the recovery had only reloaded the same mechanism. A design that survives a tremor is not proven safe; it has merely not yet met selling large and sustained enough to keep the loop spinning past the point of return.",
      ],
    },
  ],
  watchpoints: [
    "Stablecoins whose collateral basket includes the issuing protocol's own volatile share or governance token, especially where redemption mints that token rather than transferring existing supply.",
    "Redemption or peg-defense oracles that use a time-weighted average long enough to lag spot price during a fast decline, creating an arbitrage spread that drains the system.",
    "Uncapped or effectively uncapped share-token supply, where the mechanism can mint without limit to honor a fixed dollar redemption value as the token falls.",
    "A peg that recovers from an initial sell-off being treated as proof of resilience rather than a reload of the same untested mechanism.",
  ],
  crossLinks: [
    {
      href: "/learn/mechanisms/algorithmic/",
      label: "Mechanism: algorithmic stablecoins",
    },
    {
      href: "/cemetery/",
      label: "Stablecoin cemetery",
    },
    {
      href: "/learn/case-studies/terra-ust-2022/",
      label: "Case study: Terra / UST (the sequel)",
    },
  ],
  sources: [
    {
      label: "Iron Finance: Post-Mortem (17 June 2021)",
      href: "https://ironfinance.medium.com/iron-finance-post-mortem-17-june-2021-6a4e9ccf23f5",
    },
    {
      label: "CoinDesk: Iron Finance says it suffered crypto's first large-scale bank run",
      href: "https://www.coindesk.com/markets/2021/06/17/in-token-crash-postmortem-iron-finance-says-it-suffered-cryptos-first-large-scale-bank-run",
    },
    {
      label: "Federal Reserve: Runs on Algorithmic Stablecoins: Evidence from Iron, Titan, and Steel",
      href: "https://www.federalreserve.gov/econres/notes/feds-notes/runs-on-algorithmic-stablecoins-evidence-from-iron-titan-and-steel-20220602.html",
    },
    {
      label: "Finematics: Bank Run in DeFi: Iron Finance Explained",
      href: "https://finematics.com/bank-run-in-defi-iron-finance-explained/",
    },
    {
      label: "Forkast: Iron Finance's DeFi bank run, and why Mark Cuban got rekted",
      href: "https://forkast.news/iron-finances-defi-bank-run-why-mark-cuban-got-rekted/",
    },
  ],
  metaDescription:
    "How IRON Finance's fractional-algorithmic stablecoin collapsed in June 2021: a reflexive redemption loop that minted TITAN to zero, the prequel to Terra.",
  datePublished: "2026-05-23",
};
