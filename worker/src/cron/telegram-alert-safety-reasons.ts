import {
  getReportCardGradeRank,
  UNKNOWN_REPORT_CARD_GRADE_RANK,
} from "@shared/lib/report-card-core";
import type { SafetyChange } from "../lib/telegram-alerts";
import type {
  AlertSafetyV9SourceRow,
  AlertSafetyV9ExplainSnapshot,
} from "../lib/alert-safety-source-cache";
import type { SafetySnapshot } from "./telegram-alert-snapshots";

export type SafetyChangeWithExplain = SafetyChange;

type Direction = "upgrade" | "downgrade" | "mixed" | "flat";

function ensureSentence(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function capitalize(value: string): string {
  return value.length === 0
    ? value
    : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function compareGradeOrScore(
  previousGrade: string,
  currentGrade: string,
  previousScore: number | null,
  currentScore: number | null,
): Direction {
  // One grade-rank ladder. The local list this replaced also carried phantom
  // `D-`/`D+` grades the V9 vocabulary has never produced; unknown grades still
  // rank strictly below NR, so every comparison below is unchanged.
  const previousRank = getReportCardGradeRank(previousGrade, UNKNOWN_REPORT_CARD_GRADE_RANK)!;
  const currentRank = getReportCardGradeRank(currentGrade, UNKNOWN_REPORT_CARD_GRADE_RANK)!;
  const gradeDirection =
    currentRank > previousRank
      ? "upgrade"
      : currentRank < previousRank
        ? "downgrade"
        : "flat";
  const scoreDirection =
    previousScore === null || currentScore === null
      ? "flat"
      : currentScore > previousScore
        ? "upgrade"
        : currentScore < previousScore
          ? "downgrade"
          : "flat";
  if (gradeDirection === "flat") return scoreDirection;
  if (scoreDirection === "flat" || scoreDirection === gradeDirection) {
    return gradeDirection;
  }
  return "mixed";
}

function largestPillarMovement(
  current: AlertSafetyV9ExplainSnapshot["pillars"],
  previous: AlertSafetyV9ExplainSnapshot["pillars"] | undefined,
  overallDirection: Direction,
): {
  pillar: keyof AlertSafetyV9ExplainSnapshot["pillars"];
  current: number;
  previous: number;
} | null {
  if (!previous) return null;
  const movements = (["backing", "exit", "control"] as const).flatMap(
    (pillar) => {
      const currentScore = current[pillar].score;
      const previousScore = previous[pillar].score;
      return currentScore === null ||
        previousScore === null ||
        currentScore === previousScore
        ? []
        : [{ pillar, current: currentScore, previous: previousScore }];
    },
  );
  const directional =
    overallDirection === "upgrade"
      ? movements.filter((movement) => movement.current > movement.previous)
      : overallDirection === "downgrade"
        ? movements.filter(
            (movement) => movement.current < movement.previous,
          )
        : [];
  return (directional.length > 0 ? directional : movements).sort(
    (left, right) =>
      Math.abs(right.current - right.previous) -
      Math.abs(left.current - left.previous),
  )[0] ?? null;
}

export function buildV9SafetyReason(
  current: Pick<AlertSafetyV9SourceRow, "grade" | "score" | "v9Explain">,
  previous?: Pick<
    AlertSafetyV9SourceRow,
    "grade" | "score" | "v9Explain"
  >,
): string {
  if (
    current.v9Explain.bindingCap &&
    (
      current.v9Explain.bindingCap.reason !==
        previous?.v9Explain.bindingCap?.reason ||
      current.v9Explain.bindingCap.kind !==
        previous?.v9Explain.bindingCap?.kind ||
      current.v9Explain.bindingCap.limit !==
        previous?.v9Explain.bindingCap?.limit
    )
  ) {
    return `Reason: ${ensureSentence(
      current.v9Explain.bindingCap.reason,
    )}`;
  }

  const overallDirection = compareGradeOrScore(
    previous?.grade ?? current.grade,
    current.grade,
    previous?.score ?? null,
    current.score,
  );
  const pillarMovement = largestPillarMovement(
    current.v9Explain.pillars,
    previous?.v9Explain.pillars,
    overallDirection,
  );
  if (pillarMovement) {
    const direction =
      pillarMovement.current > pillarMovement.previous ? "improved" : "fell";
    return `Reason: ${capitalize(
      pillarMovement.pillar,
    )} pillar ${direction} from ${Math.round(
      pillarMovement.previous,
    )} to ${Math.round(pillarMovement.current)}.`;
  }

  const previousReasons = new Set(
    previous?.v9Explain.reasons.map(
      (reason) => reason.code || reason.message,
    ) ?? [],
  );
  const reason =
    current.v9Explain.reasons.find(
      (candidate) =>
        !previousReasons.has(candidate.code || candidate.message),
    )?.message ?? current.v9Explain.reasons[0]?.message;
  if (reason) return `Reason: ${ensureSentence(reason)}`;
  if (current.v9Explain.weakestPillar) {
    return `Reason: Weakest pillar is ${
      current.v9Explain.weakestPillar.pillar
    } (${Math.round(current.v9Explain.weakestPillar.score)}).`;
  }
  return `Reason: Safety Score is ${current.grade}${
    current.score === null ? "." : ` (${Math.round(current.score)}).`
  }`;
}

export function addSafetyReasonLines(
  changes: readonly SafetyChange[],
  currentSafetySnapshot: SafetySnapshot | null,
  previousSafetySnapshot: SafetySnapshot | null,
  _currentContextLines: ReadonlyMap<string, string> = new Map(),
): SafetyChangeWithExplain[] {
  return changes.map((change) => {
    const current = currentSafetySnapshot?.[change.stablecoinId];
    if (!current?.v9Explain) return change;
    const previous = previousSafetySnapshot?.[change.stablecoinId];
    return {
      ...change,
      contextLine: buildV9SafetyReason(
        current as AlertSafetyV9SourceRow,
        previous?.v9Explain
          ? (previous as AlertSafetyV9SourceRow)
          : undefined,
      ),
    };
  });
}
