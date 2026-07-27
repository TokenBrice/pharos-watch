import { REPORT_CARD_GRADE_COLORS, gradeRange, type ReportCardGradeRange } from "@shared/lib/report-cards";
import type { ReportCardGrade } from "@shared/types";

export type SafetyGradeRange = ReportCardGradeRange;

export interface SafetyGradeRangeMetadata {
  barClassName: string;
  interactiveBarClassName: string;
  sectionSwatchClassName: string;
  pillClassName: string;
  pulse: {
    ringClassName: string;
    bgClassName: string;
    accentClassName: string;
    tagline: string;
  };
  glowColor: string;
  borderColor: string;
  radarColor: string;
  sectionDescription: string;
}

const SAFETY_GRADE_RANGE_METADATA: Record<SafetyGradeRange, SafetyGradeRangeMetadata> = {
  A: {
    barClassName: "bg-emerald-500",
    interactiveBarClassName: "bg-emerald-500 hover:bg-emerald-400",
    sectionSwatchClassName: "bg-emerald-500",
    pillClassName: "border-emerald-600/35 bg-emerald-500/15 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300",
    pulse: {
      ringClassName: "border-emerald-500/35",
      bgClassName: "bg-emerald-500/10",
      accentClassName: "text-emerald-700 dark:text-emerald-300",
      tagline: "High-grade assets dominate the market mix.",
    },
    glowColor: "oklch(0.5 0.2 145 / 0.53)",
    borderColor: "oklch(0.65 0.22 145 / 0.6)",
    radarColor: "#10b981",
    sectionDescription: "Top tier - strong across all dimensions",
  },
  B: {
    barClassName: "bg-blue-500",
    interactiveBarClassName: "bg-blue-500 hover:bg-blue-400",
    sectionSwatchClassName: "bg-blue-500",
    pillClassName: "border-blue-600/35 bg-blue-500/15 text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-300",
    pulse: {
      ringClassName: "border-blue-500/35",
      bgClassName: "bg-blue-500/10",
      accentClassName: "text-blue-700 dark:text-blue-300",
      tagline: "Safety profile is balanced with moderate fragility.",
    },
    glowColor: "oklch(0.5 0.16 250 / 0.45)",
    borderColor: "oklch(0.6 0.18 250 / 0.55)",
    radarColor: "#3b82f6",
    sectionDescription: "Above average - solid fundamentals with minor gaps",
  },
  C: {
    barClassName: "bg-amber-500",
    interactiveBarClassName: "bg-amber-500 hover:bg-amber-400",
    sectionSwatchClassName: "bg-amber-500",
    pillClassName: "border-amber-600/35 bg-amber-500/15 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300",
    pulse: {
      ringClassName: "border-amber-500/35",
      bgClassName: "bg-amber-500/10",
      accentClassName: "text-amber-700 dark:text-amber-300",
      tagline: "Quality mix is split; watch weaker structures.",
    },
    glowColor: "oklch(0.55 0.18 85 / 0.45)",
    borderColor: "oklch(0.65 0.2 85 / 0.55)",
    radarColor: "#f59e0b",
    sectionDescription: "Middle ground - meets baseline but has weaknesses",
  },
  D: {
    barClassName: "bg-orange-500",
    interactiveBarClassName: "bg-orange-500 hover:bg-orange-400",
    sectionSwatchClassName: "bg-orange-500",
    pillClassName: "border-orange-600/35 bg-orange-500/15 text-orange-700 dark:border-orange-500/40 dark:bg-orange-500/15 dark:text-orange-300",
    pulse: {
      ringClassName: "border-orange-500/35",
      bgClassName: "bg-orange-500/10",
      accentClassName: "text-orange-700 dark:text-orange-300",
      tagline: "Risk pressure is elevated in lower-grade tiers.",
    },
    glowColor: "oklch(0.55 0.2 55 / 0.53)",
    borderColor: "oklch(0.6 0.22 55 / 0.6)",
    radarColor: "#f97316",
    sectionDescription: "Below average - significant risk in multiple areas",
  },
  F: {
    barClassName: "bg-red-500",
    interactiveBarClassName: "bg-red-500 hover:bg-red-400",
    sectionSwatchClassName: "bg-red-500",
    pillClassName: "border-red-600/35 bg-red-500/15 text-red-700 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300",
    pulse: {
      ringClassName: "border-red-500/35",
      bgClassName: "bg-red-500/10",
      // Unlike the other grades' softened dark accents, F stays a bright alarm
      // red in dark mode — red-300 reads as pink at display sizes.
      accentClassName: "text-red-600 dark:text-red-500",
      tagline: "Failure-prone segment is meaningfully outsized.",
    },
    glowColor: "oklch(0.5 0.22 25 / 0.6)",
    borderColor: "oklch(0.55 0.24 25 / 0.65)",
    radarColor: "#ef4444",
    sectionDescription: "Critical - major concerns across dimensions",
  },
  NR: {
    barClassName: "bg-zinc-500",
    interactiveBarClassName: "bg-muted-foreground/40 hover:bg-muted-foreground/50",
    sectionSwatchClassName: "bg-muted-foreground/40",
    pillClassName: "border-zinc-600/30 bg-zinc-500/15 text-zinc-700 dark:border-zinc-500/40 dark:bg-zinc-500/15 dark:text-zinc-300",
    pulse: {
      ringClassName: "border-zinc-500/35",
      bgClassName: "bg-zinc-500/10",
      accentClassName: "text-zinc-700 dark:text-zinc-300",
      tagline: "Data coverage is incomplete for a full pulse read.",
    },
    glowColor: "oklch(0.5 0 0 / 0.35)",
    borderColor: "transparent",
    radarColor: "#71717a",
    sectionDescription: "Not yet rated - insufficient data",
  },
};

function getSafetyGradeRange(grade: ReportCardGrade): SafetyGradeRange {
  return gradeRange(grade);
}

export function getSafetyGradeMetadata(grade: ReportCardGrade | SafetyGradeRange): SafetyGradeRangeMetadata {
  const range = getSafetyGradeRange(grade as ReportCardGrade);
  return SAFETY_GRADE_RANGE_METADATA[range];
}

export function getSafetyGradeBadgeClassName(grade: ReportCardGrade): string {
  return REPORT_CARD_GRADE_COLORS[grade];
}
