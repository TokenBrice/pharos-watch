import type { SafetyScorePublicationIdentity, SafetyScoreV9Card } from "@shared/types";
import { median } from "@shared/lib/stats";
import {
  safetyScoreV9IdentitiesMatch,
  type V9ConsumerIdentity,
  type V9ConsumerResult,
} from "@/lib/safety-score-v9-consumers";

const V9_PILLARS = ["backing", "exit", "control"] as const;
type V9Pillar = (typeof V9_PILLARS)[number];

const V9_PILLAR_LABELS: Record<V9Pillar, string> = {
  backing: "Backing",
  exit: "Exit",
  control: "Control",
};

export interface V9RadarSeries {
  card: SafetyScoreV9Card;
  identity: SafetyScorePublicationIdentity;
  color: string;
}

export interface V9RadarDataset {
  identity: V9ConsumerIdentity;
  rows: Array<Record<string, string | number>>;
  cohortMedians: Record<V9Pillar, number> | null;
}

export function buildV9RadarDataset(
  series: readonly V9RadarSeries[],
  cohortSeries: readonly V9RadarSeries[] = series,
): V9ConsumerResult<V9RadarDataset> {
  const anchor = series[0]?.identity;
  if (!anchor || anchor.model !== "v9") return { status: "unavailable", reason: "invalid-v9-response" };
  const combined = [...series, ...cohortSeries];
  if (combined.some((entry) => !safetyScoreV9IdentitiesMatch(anchor, entry.identity))) {
    return { status: "unavailable", reason: "identity-mismatch" };
  }
  if (
    series.some((entry) => V9_PILLARS.some((pillar) => entry.card.pillars[pillar].score === null))
  ) {
    return { status: "unavailable", reason: "card-unavailable" };
  }

  const cohortMedians = cohortSeries.length < 3
    ? null
    : Object.fromEntries(
        V9_PILLARS.map((pillar) => [
          pillar,
          median(
            cohortSeries.flatMap((entry) => {
              const score = entry.card.pillars[pillar].score;
              return score === null ? [] : [score];
            }),
          ),
        ]),
      ) as Record<V9Pillar, number | null>;

  const completeMedians = cohortMedians && Object.values(cohortMedians).every((score) => score !== null)
    ? cohortMedians as Record<V9Pillar, number>
    : null;

  return {
    status: "available",
    identity: anchor,
    value: {
      identity: anchor,
      rows: V9_PILLARS.map((pillar) => ({
        pillar: V9_PILLAR_LABELS[pillar],
        fullMark: 100,
        ...Object.fromEntries(series.map((entry) => [entry.card.id, entry.card.pillars[pillar].score ?? 0])),
        ...(completeMedians ? { __cohortMedian: completeMedians[pillar] } : {}),
      })),
      cohortMedians: completeMedians,
    },
  };
}
