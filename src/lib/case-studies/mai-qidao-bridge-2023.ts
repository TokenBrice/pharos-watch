import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "mai-qidao-bridge-2023",
  eyebrow: "Bridge bad debt",
  title: "MAI: the bridge that broke the peg",
  subtitle:
    "QiDao's overcollateralized stablecoin lost its dollar in 2023, not because its collateral fell, but because the Multichain bridge collapse stranded the assets backing the MAI minted on Fantom and seeded bad debt that the multichain footprint propagated.",
  lead: [
    "MAI (miMATIC) is a collateralized debt position stablecoin: borrowers lock crypto in QiDao vaults and mint MAI against it, overcollateralized, redeemable by repaying the loan. By 2023 it was deployed across more than a dozen chains, and that breadth, sold as a feature, was the vector. A CDP coin spread thin across many chains depends on bridges to keep liquidity and collateral coherent across them, and one of those bridges was Multichain.",
    "On July 6, 2023, roughly $125M drained out of Multichain's Fantom bridge. The collateral that backed the MAI minted on Fantom lost its value, but the MAI itself had already been bridged out to other chains. There was now more MAI in circulation than there was collateral standing behind it: bad debt, stranded on the chains that had imported the tokens. QiDao isolated Fantom quickly, but the hole had already opened, and a bank run dynamic drove holders to dump MAI wherever it still had liquidity.",
    "The result was not a clean break but a long bleed. MAI slipped a few percent in July, then drifted lower through the autumn (trading near $0.88 in early October and touching roughly $0.72 mid-month) before clawing back. Risk managers moved to wall it off: Gauntlet recommended Aave begin deprecating the MAI markets. QiDao spent months buying and burning supply against its treasury to close the bad debt, settling the last ~$668K on Polygon in February 2024 while the token still traded near $0.88. MAI is studied here as wounded, not dead: a CDP stablecoin that survived but carries the scar of a dependency it never controlled.",
  ],
  takeaways: [
    "MAI depegged in 2023 because of bridge failure, not collateral price: the Multichain Fantom hack (~$125M) destroyed the collateral while the MAI minted against it had already been bridged to other chains, leaving bad debt.",
    "A CDP stablecoin's multichain footprint turned a single-chain loss into a system-wide sub-peg: holders ran to dump MAI wherever liquidity remained, and the deviation spread rather than staying contained on Fantom.",
    "The drift was slow and deep: a few percent in July, near $0.88 in early October, a low around $0.72 mid-month; by Q1 2024 the average trade price was roughly $0.53 (per Messari).",
    "Risk managers walled it off: Gauntlet recommended Aave deprecate the MAI markets (LTV to 0, raise borrow rates) in October 2023; QiDao burned treasury assets to clear the bad debt, settling the last ~$668K on Polygon in February 2024. The peg has since largely recovered.",
  ],
  primaryCoinId: "mai-qidao",
  archetype: "cdp",
  outcome: "wounded",
  eventDateLabel: "2023-2024",
  eventWindow: {
    startISO: "2023-07-06",
    endISO: "2024-02-22",
    peakDeviationBps: -2800,
    lowPrice: 0.72,
  },
  timeline: [
    {
      dateISO: "2023-07-06",
      headline: "Multichain's Fantom bridge drains; MAI's Fantom collateral is gutted",
      body: "Roughly $125M drained from Multichain's Fantom bridge in a single burst of abnormal outflows. QiDao's own contracts were not exploited, but the bridged assets used as collateral for MAI vaults on Fantom lost their value. The MAI minted against that collateral had already been bridged to other chains, so the loss became bad debt stranded elsewhere.",
      severity: "high",
    },
    {
      dateISO: "2023-07-08",
      headline: "Fantom run and initial sub-peg; QiDao isolates the chain",
      body: "With nearly every asset on Fantom suddenly worthless, holders ran on the MAI liquidity that remained, draining it to sell on other chains. MAI slipped roughly 3.5% below its dollar. QiDao moved to red alert, shut down the Multichain route, and isolated Fantom to contain the impact, but the unbacked MAI was already loose on other chains.",
      severity: "med",
    },
    {
      dateISO: "2023-10-02",
      headline: "The drift deepens through the autumn",
      body: "MAI never cleanly regained par. By early October it was trading around $0.88, the sustained sub-peg now visibly a function of the unresolved bad debt rather than a transient liquidity shock.",
      severity: "med",
    },
    {
      dateISO: "2023-10-13",
      headline: "Low near $0.72; Gauntlet recommends Aave deprecate MAI",
      body: "After MAI fell to roughly $0.72 over 24 hours and given its inability to regain peg for months, Gauntlet recommended Aave begin deprecating the MAI/MIMATIC markets across Polygon, Avalanche, Arbitrum, and Optimism: setting loan-to-value toward zero and raising borrow rates to force repayment, an estimated ~$70K in forced liquidations.",
      severity: "high",
      href: "https://governance.aave.com/t/arfc-gauntlet-recommendation-for-mai-mimatic-deprecation/15119",
    },
    {
      dateISO: "2024-02-22",
      headline: "QiDao settles the last bad debt; recovery is partial",
      body: "QiDao's community voted to burn treasury assets to cover the remaining bad debt, settling roughly $668K on Polygon via buy-and-burn. The token still traded near $0.88 at settlement, a point-in-time print, while Messari's broader Q1 average was much lower near $0.53. The peg recovered toward par over the following period, but liquidity stayed fragmented and some chain-specific MAI representations continued to trade well below a dollar.",
      severity: "low",
      href: "https://www.dlnews.com/articles/defi/qidao-settles-bad-debt-on-polygon-to-save-stablecoin/",
    },
  ],
  sections: [
    {
      id: "what-happened",
      heading: "What happened",
      paragraphs: [
        "MAI is a CDP stablecoin issued by QiDao: a borrower locks crypto collateral in a vault and mints MAI against it, overcollateralized, and recovers the collateral by repaying. The system is supposed to be fully backed because every MAI in circulation traces to a vault holding more value than it minted. That invariant held chain by chain, as long as the collateral in each chain's vaults remained worth what the oracle said.",
        "On July 6, 2023, Multichain's Fantom bridge was drained of roughly $125M. The bridged assets that sat as collateral inside QiDao's Fantom vaults were suddenly worthless, but the MAI those vaults had minted did not evaporate with them; it had already been bridged to Polygon and other chains and was circulating freely. The result was that the protocol now had more MAI outstanding than collateral backing it: bad debt, and crucially, bad debt that lived on chains other than the one where the collateral failed.",
        "QiDao reacted fast, shutting the Multichain route and isolating Fantom to stop the bleed. But isolation came after the tokens had already escaped. The undercollateralization translated directly into price: MAI slipped a few percent in July, and as the market absorbed that the shortfall was structural rather than transient, the deviation widened through the autumn to a low near $0.72 in mid-October.",
      ],
    },
    {
      id: "bridge-dependency-as-a-depeg-vector",
      heading: "Bridge dependency as a depeg vector",
      paragraphs: [
        "The instructive part of this case is the causal chain. MAI did not depeg because crypto collateral prices fell, the usual way a CDP stablecoin breaks. It depegged because a bridge failed. The collateral inside the Fantom vaults was destroyed not by a market move but by the disappearance of the bridge that held the assets backing those collateral tokens. The CDP mechanism behaved correctly given its inputs; the inputs were corrupted by infrastructure QiDao did not run.",
        "This is the distinction worth holding against the wrapped-asset bridge story. When Multichain collapsed, the Fantom-bridged USDC.m, a wrapper that was nothing but a claim on the bridge, fell to roughly $0.22 and died, because it had no backing of its own once the bridge emptied. MAI is a different animal: a sovereign CDP stablecoin with vaults and collateral on many chains. The bridge failure did not zero it. It punched a hole in one chain's collateral and let the multichain footprint carry the damage outward, producing a sustained sub-peg rather than a wrapper's total collapse.",
        "The lesson is that for a multichain CDP coin, every bridge it relies on to keep collateral and liquidity coherent is part of its risk surface, indistinguishable in effect from a collateral oracle. A bridge that strands or destroys backing on one chain mints bad debt the same way a bad price feed would, and the broader the deployment, the more places that bad debt can hide and the longer it takes to find and burn.",
      ],
    },
    {
      id: "cross-chain-bad-debt",
      heading: "Cross-chain bad debt",
      paragraphs: [
        "Bad debt confined to one chain is a contained accounting problem; bad debt smeared across a dozen is a slow-motion one. The MAI minted on Fantom had been bridged elsewhere, so the chains that imported it were holding tokens with no collateral standing behind them, and there was no single ledger where the shortfall sat to be cleared in one motion. QiDao had to find the unbacked supply and retire it chain by chain.",
        "A bank-run dynamic made it worse before it got better. On Fantom, where nearly everything else had become worthless, MAI was briefly the only liquid escape, so holders drained the remaining MAI pools to sell the tokens on Polygon and elsewhere, exporting the sell pressure to exactly the chains that still had functioning markets. The deviation propagated along the same rails the protocol had used to grow.",
        "Clearing it was a treasury exercise stretched over months. QiDao bought MAI back and burned it, funded by a treasury holding over $7M in crypto, shrinking the circulating supply on the affected chains until outstanding MAI again matched real collateral. The Polygon supply fell sharply over the period, and the protocol added a peg-stability module in January 2024 to firm up redemption. The final tranche, roughly $668K of bad debt on Polygon, was settled in February 2024, more than half a year after the bridge failed.",
      ],
    },
    {
      id: "deprecation-pressure",
      heading: "Deprecation pressure",
      paragraphs: [
        "A sustained sub-peg is not only a problem for holders; it is a problem for every lending market that listed the coin as collateral or as a borrowable asset. MAI had been integrated into Aave v3 across several chains. As the deviation persisted and deepened, the risk managers who parameterize those markets moved to limit the protocol's exposure rather than wait for a recovery that kept not arriving.",
        "On October 13, 2023, with MAI down near $0.72 and unable to hold peg for months, Gauntlet formally recommended that Aave begin deprecating the MAI/MIMATIC listings on Polygon, Avalanche, Arbitrum, and Optimism. The mechanism was the standard wind-down: drive loan-to-value toward zero and raise borrow rates so positions are pushed to repay and the market can be retired, an estimated ~$70K in forced liquidations to unwind. Earlier in the year, after the first July wobble, risk managers had already tightened MAI's supply and borrow caps; the October step escalated containment to deprecation.",
        "Deprecation pressure is its own kind of scar. Even after a coin claws back toward par, the integrations it lost do not automatically return: a market that was wound down and a risk team that flagged the asset both leave a coin smaller and less trusted than it was. That is much of what 'wounded' means here: the peg recovered, but the standing did not fully.",
      ],
    },
    {
      id: "lessons",
      heading: "Lessons",
      paragraphs: [
        "First, a CDP stablecoin's collateral risk is not only price risk. Anything that can corrupt the value of vault collateral (a bridge that holds the underlying assets, a wrapper that can be drained, an oracle that can be manipulated) is a depeg vector, even when crypto prices never move against the borrower. For MAI, the failure was an infrastructure dependency, not a market one, and a collateral-price lens alone would have missed it entirely.",
        "Second, a multichain deployment is a double-edged footprint. The same breadth that grows a stablecoin spreads its bad debt: tokens minted against failed collateral on one chain were already loose on others, so the shortfall could not be quarantined and the cleanup ran chain by chain over months. Broad deployment widens both the addressable market and the surface where damage can hide.",
        "Third, mind the difference between dying and being wounded. The wrapped USDC.m on the same bridge had no backing of its own and went to roughly $0.22 and zero recovery; MAI, a sovereign CDP coin, took a sustained sub-peg and a wave of deprecation but bought back its bad debt and recovered toward par. Survival is the better outcome, but the lost integrations, the months below peg, and the fragmented chain-by-chain liquidity are the durable cost of depending on infrastructure you do not control.",
      ],
    },
  ],
  dataWidgets: [
    {
      kind: "peg-deviation",
      coinId: "mai-qidao",
      caption:
        "MAI's daily peg history on Pharos. The curated marker pins the mid-2023 Multichain fallout that opened the sustained sub-peg. The drift bottomed near $0.72 in October 2023 before a slow, partial recovery.",
    },
  ],
  watchpoints: [
    "Bridge dependencies behind a multichain CDP coin: every bridge that custodies or moves collateral assets is part of the collateral risk surface; a bridge failure can mint bad debt the same way a bad oracle would, without any move in crypto prices.",
    "Multichain footprint and where the supply lives: tokens minted against failed collateral on one chain may already be circulating on others, so bad debt cannot be quarantined and cleanup runs chain by chain.",
    "Sustained (not spike) sub-peg: a coin that drifts below par for weeks and months signals structural bad debt rather than a transient liquidity shock, and invites lending-market deprecation.",
    "Lending-market deprecation pressure: when risk managers (e.g. Gauntlet on Aave) move to set LTV toward zero and force repayment, the lost integrations persist even after the peg recovers.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/cdp/", label: "How CDP stablecoins work" },
    { href: "/stablecoin/mai-qidao/", label: "MAI live data and risk" },
    { href: "/learn/case-studies/multichain-usdc-2023/", label: "Case study: the bridge whose failure rippled here" },
    { href: "/dependency-map/", label: "Stablecoin dependency map" },
  ],
  sources: [
    {
      label: "DL News: How DeFi protocol QiDao set fire to $668,000 to save its stablecoin",
      href: "https://www.dlnews.com/articles/defi/qidao-settles-bad-debt-on-polygon-to-save-stablecoin/",
    },
    {
      label: "Aave governance: [ARFC] Gauntlet recommendation for MAI / MIMATIC deprecation (Oct 13, 2023)",
      href: "https://governance.aave.com/t/arfc-gauntlet-recommendation-for-mai-mimatic-deprecation/15119",
    },
    {
      label: "The Block: Gauntlet proposes deprecating Mai on Aave as stablecoin depegs to $0.72",
      href: "https://www.theblock.co/post/256499/gauntlet-proposes-deprecating-mai-on-aave-as-stablecoin-depegs-to-0-72",
    },
    {
      label: "Messari: QiDao Q1 2024 Brief (Q1 average trade price ~$0.53)",
      href: "https://messari.io/report/qidao-q1-2024-brief",
    },
    {
      label: "Aave governance: Add MAI on Aave V3 (original listing context)",
      href: "https://governance.aave.com/t/add-mai-on-aave-v3/7630",
    },
  ],
  metaDescription:
    "QiDao's MAI lost its peg in 2023: the Multichain bridge collapse stranded Fantom collateral and seeded cross-chain bad debt. A CDP coin wounded, not killed.",
  datePublished: "2026-06-15",
};
