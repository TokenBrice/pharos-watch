import { getMechanismArchetypeLabel, getMechanismArchetypeOneLiner } from "@shared/lib/classification";

export const metadata = {
  title: "Delta-Neutral Stablecoins, Explained",
  description: "Delta-neutral stablecoins offset economic exposures through perp-short or on-chain borrow-and-stake strategies. Read how each variant works and where its risks differ.",
  publishedAt: "2026-05-16T00:00:00Z",
  jsonLdHeadline: `${getMechanismArchetypeLabel("synthetic-delta-neutral")} stablecoins, explained`,
  jsonLdDescription: getMechanismArchetypeOneLiner("synthetic-delta-neutral"),
};
