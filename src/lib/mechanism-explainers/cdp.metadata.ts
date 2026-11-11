import { getMechanismArchetypeLabel, getMechanismArchetypeOneLiner } from "@shared/lib/classification";

export const metadata = {
  title: "CDP Stablecoins: Collateralized Debt Positions",
  description: "CDP stablecoins are minted as debt against onchain collateral, then kept on peg through liquidations and rate fees. Read how the design works and where it breaks.",
  publishedAt: "2026-05-16T00:00:00Z",
  jsonLdHeadline: `${getMechanismArchetypeLabel("cdp")} stablecoins, explained`,
  jsonLdDescription: getMechanismArchetypeOneLiner("cdp"),
};
