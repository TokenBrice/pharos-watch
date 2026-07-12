import { formatScore } from "@shared/lib/format";
import { clampScore } from "@shared/lib/math";
import { computePsiDepegContribution } from "@shared/lib/psi-contribution";
import { PSI_BAND_CLASSES, PSI_HEX_COLORS, type ConditionBand } from "@shared/lib/psi-colors";
import type { PsiChartPoint } from "@shared/lib/psi-view-model";
import type { StabilityContributor } from "@/hooks/api-hooks";
import { BAND_ZONES, PSI_EVENTS } from "@/lib/psi-history-events";

const HISTORY_WINDOW_DAYS = 30;
const SCORE_DECIMAL_PLACES = 1;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

export type PsiHistoryPoint = { date: number; score: number; band: string };
export type { PsiChartPoint };

export interface HistoryStatItem {
  label: string;
  value: string;
  band: string;
  sub: string | null;
}

export interface PsiEventTimelineRow {
  label: string;
  dateStr: string;
  links: Array<{ title: string; url: string }>;
  psi: number | null;
  psiBand: string;
  psiColor: string;
  dotHex: string;
}

export interface PsiContributorRow extends StabilityContributor {
  severity: number;
  breadth: number;
  total: number;
}

export interface PsiComponentPoint {
  ts: number;
  severity: number;
  breadth: number;
  stressBreadth: number;
  trend: number;
}

export type PsiBeamDimmerKey = "severity" | "breadth" | "stressBreadth" | "trend";

export interface PsiBeamDimmerLane {
  key: PsiBeamDimmerKey;
  label: string;
  value: number;
  delta: number | null;
  pressurePct: number;
  max: number;
  role: "penalty" | "support" | "drag";
  detail: string;
}

const PSI_BEAM_DIMMER_DETAIL: Record<PsiBeamDimmerKey, { label: string; max: number; detail: string }> = {
  severity: {
    label: "Severity",
    max: 68,
    detail: "Current depeg depth penalty",
  },
  breadth: {
    label: "Breadth",
    max: 17,
    detail: "Current active depeg spread",
  },
  stressBreadth: {
    label: "Stress breadth",
    max: 5,
    detail: "Current DEWS warning-band pressure",
  },
  trend: {
    label: "Trend",
    max: 5,
    detail: "7-day market-cap momentum",
  },
};

function clampPct(value: number, max: number): number {
  if (max <= 0) return 0;
  return clampScore((value / max) * 100);
}

export function buildPsiComponentData(
  history:
    | Array<{
        date: number;
        components?: { severity?: number; breadth?: number; stressBreadth?: number; trend?: number } | null;
      }>
    | undefined,
  current:
    | {
        computedAt: number;
        components: { severity: number; breadth: number; stressBreadth?: number | null; trend: number };
      }
    | null
    | undefined,
): PsiComponentPoint[] {
  if (!current || !history) return [];
  const reversed = [...history].filter((point) => point.components).reverse();
  return [
    ...reversed.map((point) => ({
      ts: point.date * 1000,
      severity: point.components?.severity ?? 0,
      breadth: point.components?.breadth ?? 0,
      stressBreadth: point.components?.stressBreadth ?? 0,
      trend: point.components?.trend ?? 0,
    })),
    {
      ts: current.computedAt * 1000,
      severity: current.components.severity,
      breadth: current.components.breadth,
      stressBreadth: current.components.stressBreadth ?? 0,
      trend: current.components.trend,
    },
  ];
}

export function buildPsiBeamDimmers<
  T extends { severity: number; breadth: number; stressBreadth: number; trend: number },
>(componentData: readonly T[] | undefined): PsiBeamDimmerLane[] {
  if (!componentData?.length) return [];
  const current = componentData[componentData.length - 1];
  const previous = componentData.length > 1 ? componentData[componentData.length - 2] : null;
  const keys: PsiBeamDimmerKey[] = ["severity", "breadth", "stressBreadth", "trend"];

  return keys.map((key) => {
    const config = PSI_BEAM_DIMMER_DETAIL[key];
    const value = current[key];
    const previousValue = previous?.[key] ?? null;
    const pressureValue = key === "trend" ? Math.max(0, -value) : Math.max(0, value);
    const role = key === "trend" ? (value >= 0 ? "support" : "drag") : "penalty";
    return {
      key,
      label: config.label,
      value,
      delta: previousValue === null ? null : Math.round((value - previousValue) * 10) / 10,
      pressurePct: clampPct(pressureValue, config.max),
      max: config.max,
      role,
      detail: config.detail,
    };
  });
}

export function buildPsiHistoryStats(history: PsiHistoryPoint[]): HistoryStatItem[] {
  if (!history.length) return [];
  const last30 = history.slice(0, HISTORY_WINDOW_DAYS);
  const scores = last30.map((point) => point.score);
  const high30 = scores.reduce((max, score) => Math.max(max, score), -Infinity);
  const low30 = scores.reduce((min, score) => Math.min(min, score), Infinity);
  const factor = 10 ** SCORE_DECIMAL_PLACES;
  const avg30 = Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * factor) / factor;
  const avg30Band = BAND_ZONES.find((zone) => avg30 >= zone.y1)?.label ?? "";
  const high30Band = last30.find((point) => point.score === high30)?.band ?? "";
  const low30Band = last30.find((point) => point.score === low30)?.band ?? "";
  return [
    { label: "30d High", value: formatScore(high30), band: high30Band, sub: null },
    { label: "30d Low", value: formatScore(low30), band: low30Band, sub: null },
    { label: "30d Avg", value: formatScore(avg30), band: avg30Band, sub: null },
  ];
}

export function buildPsiEventTimelineRows(data: PsiChartPoint[]): PsiEventTimelineRow[] {
  return [...PSI_EVENTS].reverse().map((event) => {
    const startDate = new Date(event.date);
    const formatter: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
    const dateStr = event.dateEnd
      ? (() => {
          const endDate = new Date(event.dateEnd);
          const sameYear = startDate.getFullYear() === endDate.getFullYear();
          const start = startDate.toLocaleDateString(
            "en-US",
            sameYear ? { month: "short", day: "numeric" } : formatter,
          );
          const end = endDate.toLocaleDateString("en-US", formatter);
          return `${start} – ${end}`;
        })()
      : startDate.toLocaleDateString("en-US", formatter);
    const rangeEnd = event.dateEnd ?? event.date + THREE_DAYS_MS;
    const nearby = data.filter(
      (point) => point.ts >= event.date - THREE_DAYS_MS && point.ts <= rangeEnd + THREE_DAYS_MS,
    );
    const worst =
      nearby.length > 0 ? nearby.reduce((lowest, point) => (point.score < lowest.score ? point : lowest)) : null;
    const psi = worst ? worst.score : null;
    const psiBand = psi !== null ? (BAND_ZONES.find((zone) => psi >= zone.y1)?.label ?? "") : "";
    return {
      label: event.label,
      dateStr,
      links: [...event.links],
      psi,
      psiBand,
      psiColor: psiBand
        ? (PSI_BAND_CLASSES[psiBand as ConditionBand] ?? "text-muted-foreground")
        : "text-muted-foreground",
      dotHex: psiBand
        ? (PSI_HEX_COLORS[psiBand as ConditionBand] ?? "var(--muted-foreground)")
        : "var(--muted-foreground)",
    };
  });
}

export function buildPsiContributorRows(
  contributors: StabilityContributor[],
  totalMcapUsd: number,
): PsiContributorRow[] {
  if (!contributors.length) return [];
  return contributors
    .map((contributor) => {
      const contribution = computePsiDepegContribution({
        bps: contributor.bps,
        mcapUsd: contributor.mcapUsd,
        totalMcapUsd,
        factor: contributor.factor,
      });
      return { ...contributor, ...contribution };
    })
    .sort((a, b) => b.total - a.total);
}
