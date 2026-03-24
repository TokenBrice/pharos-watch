"use client";

import { useMemo, useState } from "react";
import { GradeBadge } from "@/components/grade-badge";
import {
  computeOverallGrade,
  DIMENSION_LABELS,
  DIMENSION_WEIGHTS,
  PEG_MULTIPLIER_EXPONENT,
} from "@shared/lib/report-cards";
import type { DimensionKey, ReportCardDimension } from "@shared/types";

const CALCULATOR_DIMENSIONS: { key: DimensionKey; defaultValue: number }[] = [
  { key: "pegStability", defaultValue: 95 },
  { key: "liquidity", defaultValue: 65 },
  { key: "resilience", defaultValue: 55 },
  { key: "decentralization", defaultValue: 50 },
  { key: "dependencyRisk", defaultValue: 60 },
];

const INITIAL_VALUES = Object.fromEntries(
  CALCULATOR_DIMENSIONS.map((d) => [d.key, d.defaultValue]),
) as Record<DimensionKey, number>;

function makeDimension(score: number): ReportCardDimension {
  // grade field is unused by computeOverallGrade — only score matters.
  return { grade: "NR", score, detail: "interactive" };
}

export function SafetyScoreCalculator() {
  const [values, setValues] = useState<Record<DimensionKey, number>>(INITIAL_VALUES);

  const result = useMemo(() => {
    const dimensions = Object.fromEntries(
      Object.entries(values).map(([key, score]) => [key, makeDimension(score)]),
    ) as Record<DimensionKey, ReportCardDimension>;
    return computeOverallGrade(dimensions);
  }, [values]);

  return (
    <div className="space-y-4 rounded-2xl border border-border/60 bg-background/45 p-4">
      <div className="flex items-center justify-between">
        <p className="pharos-kicker">Interactive: Try your own inputs</p>
        <button
          onClick={() => setValues(INITIAL_VALUES)}
          className="pharos-focus-ring rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Reset
        </button>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Scores below use the same formula, weights, and thresholds as production.
        In practice each dimension is derived from on-chain data, not chosen
        directly — use this to explore how the grading math works, not to predict
        a specific coin&apos;s grade.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CALCULATOR_DIMENSIONS.map((dim) => {
          const weight = DIMENSION_WEIGHTS[dim.key];
          const weightLabel =
            weight > 0
              ? `${(weight * 100).toFixed(0)}% weight`
              : `×(v/100)^${PEG_MULTIPLIER_EXPONENT} multiplier`;
          return (
            <div key={dim.key} className="space-y-1.5">
              <label className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {DIMENSION_LABELS[dim.key]}{" "}
                  <span className="text-muted-foreground/60">({weightLabel})</span>
                </span>
                <span className="font-mono tabular-nums text-foreground">{values[dim.key]}</span>
              </label>
              <input
                type="range"
                min={0}
                max={100}
                value={values[dim.key]}
                onChange={(e) =>
                  setValues((prev) => ({ ...prev, [dim.key]: Number(e.target.value) }))
                }
                className="w-full accent-[var(--brand-accent)]"
                aria-label={`${DIMENSION_LABELS[dim.key]} score`}
              />
            </div>
          );
        })}
      </div>

      {result.score !== null && (
        <div className="flex flex-wrap items-center gap-3 border-t border-border/50 pt-3">
          <span className="text-sm text-muted-foreground">Computed grade:</span>
          <GradeBadge grade={result.grade} score={result.score} />
          <span className="font-mono tabular-nums text-sm text-foreground">
            {result.score} / 100
          </span>
          {result.baseScore !== null && result.baseScore !== result.score && (
            <span className="text-xs text-muted-foreground">
              (base {result.baseScore.toFixed(1)}, peg multiplier applied)
            </span>
          )}
        </div>
      )}
    </div>
  );
}
