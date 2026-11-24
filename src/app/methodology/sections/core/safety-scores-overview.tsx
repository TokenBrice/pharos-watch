import Link from "next/link";
import { SAFETY_SCORES_SECTION_CONTENT } from "@/lib/methodology-content";
import { REPORT_CARD_GRADE_RANGE_METADATA } from "@shared/lib/classification";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { ReportCardGradeRange } from "@shared/types/report-card-grade";
import { cn } from "@/lib/utils";
import {
  METHODOLOGY_LINK_CLASS,
  MethodologyDetails,
  MethodologyFacts,
  MethodologyPreconditions,
} from "../../methodology-shared";

const GRADE_THRESHOLDS = V9_CANDIDATE_POLICY_V1.policy.semantic.formula.gradeThresholds;

interface SafetyGradeScaleTier {
  tier: ReportCardGradeRange;
  range: string;
  subgrades: string;
  meaning: string;
}

function buildTierSummary(tier: Exclude<ReportCardGradeRange, "NR">): { range: string; subgrades: string } {
  const matching = GRADE_THRESHOLDS.flatMap((threshold, index) => {
    if (threshold.grade[0] !== tier) return [];
    const maxScore = index === 0 ? 100 : GRADE_THRESHOLDS[index - 1]!.minScore - 1;
    return [{ grade: threshold.grade, minScore: threshold.minScore, maxScore }];
  });
  const highest = matching[0]!;
  const lowest = matching.at(-1)!;
  return {
    range: `${lowest.minScore}-${highest.maxScore}`,
    subgrades: matching.length > 1 ? matching.map((entry) => `${entry.grade} ${entry.minScore}+`).join(" · ") : `${lowest.minScore}-${highest.maxScore}`,
  };
}

export const SAFETY_GRADE_SCALE_TIERS: readonly SafetyGradeScaleTier[] = [
  { tier: "A", ...buildTierSummary("A"), meaning: "Strong backing, exit, and control" },
  { tier: "B", ...buildTierSummary("B"), meaning: "Solid fundamentals with minor gaps" },
  { tier: "C", ...buildTierSummary("C"), meaning: "Meets baseline with notable weaknesses" },
  { tier: "D", ...buildTierSummary("D"), meaning: "Elevated structural or peg risk" },
  { tier: "F", ...buildTierSummary("F"), meaning: "Severe impairment or defunct" },
  { tier: "NR", range: "Unrated", subgrades: "Evidence unavailable", meaning: "Missing required inputs, not a low score" },
];

/** Compact 6-tier explained scale bar (A through F plus NR). */
export function SafetyGradeScaleBar() {
  return (
    <div className="space-y-3" data-testid="safety-grade-scale-bar">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted/50" aria-hidden="true">
        {SAFETY_GRADE_SCALE_TIERS.map(({ tier }) => (
          <div key={tier} className={cn("flex-1 border-r border-background/70 last:border-r-0", REPORT_CARD_GRADE_RANGE_METADATA[tier].barClassName)} />
        ))}
      </div>
      <ol className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        {SAFETY_GRADE_SCALE_TIERS.map((entry) => {
          const meta = REPORT_CARD_GRADE_RANGE_METADATA[entry.tier];
          return (
            <li key={entry.tier} className="pharos-inset flex flex-col gap-1.5 px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-xs font-semibold", meta.pillClassName)}>
                  {entry.tier}
                </span>
                <span className="pharos-numeric text-xs font-medium text-foreground">{entry.range}</span>
              </div>
              <p className="text-xs leading-snug text-foreground/90">{entry.meaning}</p>
              <p className="pharos-numeric mt-auto text-3xs text-muted-foreground">{entry.subgrades}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function SafetyScoresOverview() {
  const { markdownParagraphs, historyLinks } = SAFETY_SCORES_SECTION_CONTENT;

  return (
    <>
      <p>{markdownParagraphs[0]}</p>
      <p className="text-xs text-muted-foreground">
        See also:{" "}
        <Link href="/methodology/scoring-changelog/" className={METHODOLOGY_LINK_CLASS}>Safety Score changelog</Link>
        {" · "}
        <a href="#pegscore-dews-methodology" className={METHODOLOGY_LINK_CLASS}>PegScore + DEWS</a>
        {" · "}
        <a href="#liquidity-methodology" className={METHODOLOGY_LINK_CLASS}>Liquidity Score</a>
        {" · "}
        <a href="#infrastructure-methodology" className={METHODOLOGY_LINK_CLASS}>Infrastructure</a>
      </p>
      <MethodologyFacts
        facts={[
          { label: "Model shape", value: "3 pillars + bounded aggregation" },
          { label: "Grade output", value: "A+ to F; NR and Pipeline gap are distinct" },
          { label: "Publication state", value: "Current or held; never legacy fallback" },
        ]}
      />
      <MethodologyPreconditions
        facts={[
          { label: "Minimum data", value: "At least two usable evidenced pillars; price an unavailable third at C/U with original weights" },
          { label: "Required sources", value: "Backing, exit, control, peg, dependency, and evidence-provenance inputs" },
          {
            label: "Failure behavior",
            value: "Technical gaps have no score/grade; NR requires genuine unavailability (or tokenized-fund non-grading), never a low score; global failures hold accepted state",
          },
        ]}
      />
      <MethodologyDetails summary="Current evidence rules and admission constraints">
        {markdownParagraphs.slice(1).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
      </MethodologyDetails>
      <MethodologyDetails summary="Canonical release evidence and replay history">
        <p>Release chronology, calibration examples and replay results belong to the structured scoring history.</p>
        <ul className="list-disc list-inside space-y-1">
          {historyLinks.map(({ label, href }) => (
            <li key={href}><Link href={href} className={METHODOLOGY_LINK_CLASS}>{label}</Link></li>
          ))}
        </ul>
      </MethodologyDetails>
    </>
  );
}
