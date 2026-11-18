/**
 * What a sealed dated-scorecard edition draws: the mapping from its metadata
 * to the template cards, shared by the Worker renderer and its tests.
 */
import registeredLogos from "../../../data/logos.json";
import type { SocialScorecardMetadata } from "../../types/social-scorecard";
import type { SocialScorecardCard } from "./spec";

/** The overview edition: the accepted cohort's mean rated score and counts, never an aggregate letter grade. */
export interface SocialScorecardOverviewCard {
  meanScore: number;
  rated: number;
  notRated: number;
  unavailable: number;
  asOf: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The observation's UTC calendar day as the image prints it ("17 Nov 2026"); no locale data, so both runtimes agree. */
function asOfDay(asOfSec: number): string {
  const date = new Date(asOfSec * 1000);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * The card an edition draws. Metadata carries no pillar scores, so a coin card
 * has none. A not-rated coin, or an overview with nothing rated, has no card:
 * the route answers those as unavailable before rendering.
 */
export function socialScorecardCard(metadata: SocialScorecardMetadata):
  | { kind: "stablecoin"; card: SocialScorecardCard }
  | { kind: "overview"; card: SocialScorecardOverviewCard }
  | null {
  const asOf = asOfDay(metadata.asOfSec);
  const subject = metadata.subject;
  if (subject.kind === "overview") {
    if (subject.averageScore === null) return null;
    return { kind: "overview", card: { meanScore: subject.averageScore, rated: subject.ratedCount, notRated: subject.notRatedCount, unavailable: subject.unavailableCount, asOf } };
  }
  if (subject.ratingStatus !== "rated" || subject.score === null) return null;
  const logoPath = (registeredLogos as Readonly<Record<string, string | undefined>>)[subject.id];
  return {
    kind: "stablecoin",
    card: { identity: { symbol: subject.symbol, name: subject.name, ...(logoPath ? { logoPath } : {}) }, grade: subject.grade, score: subject.score, pillars: [], asOf },
  };
}
