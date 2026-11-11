import { getMechanismArchetypeLabel, getMechanismArchetypeOneLiner } from "@shared/lib/classification";

export const metadata = {
  title: "Protocol Position Stablecoins, Explained",
  description: "Protocol position dollars rely on bridge, vault or module claims. Learn how local custody, circular exposures and recovery remain distinct from underlying stablecoin reserves.",
  publishedAt: "2026-10-02T00:00:00Z",
  jsonLdHeadline: `${getMechanismArchetypeLabel("protocol-position")} stablecoins, explained`,
  jsonLdDescription: getMechanismArchetypeOneLiner("protocol-position"),
};
