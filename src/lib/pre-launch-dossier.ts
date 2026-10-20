import { formatUtcDayLabel } from "@shared/lib/format";
import type { DateHistoryEntry, LaunchMilestone, StablecoinMeta } from "@shared/types";
import { LAUNCH_PHASE_LABELS } from "@shared/lib/classification/pre-launch";
import {
  dateScore,
  formatFuzzyDate,
  getDriftStatus,
  parseFuzzyDate,
  parseFuzzyDeadline,
  resolveDriftDisplay,
  type DriftDisplayStatus,
} from "@/lib/pre-launch";

/**
 * View models for the pre-launch dossier (`PreLaunchDetail`). Everything here
 * reads registry facts only: no market figure, no invented date. Functions
 * that take `nowMs` are clock-dependent and run after mount (static export).
 */

const DAY_MS = 86_400_000;

export type FuzzyPrecision = "day" | "month" | "quarter" | "half" | "year";

/** A fuzzy registry date as a UTC window: `start` inclusive, `end` exclusive. */
export interface FuzzyRange {
  start: Date;
  end: Date;
  precision: FuzzyPrecision;
}

function fuzzyPrecision(raw: string): FuzzyPrecision | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "day";
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return "month";
  if (/^\d{4}-Q[1-4]$/.test(raw)) return "quarter";
  if (/^\d{4}-H[1-2]$/.test(raw)) return "half";
  if (/^\d{4}$/.test(raw)) return "year";
  return null;
}

/** `2026-Q4` → [Oct 1, Jan 1); `2026-03-22` → [Mar 22, Mar 23). */
export function parseFuzzyRange(raw: string): FuzzyRange | null {
  const precision = fuzzyPrecision(raw);
  const last = parseFuzzyDate(raw);
  const end = parseFuzzyDeadline(raw);
  if (!precision || !last || !end) return null;
  const year = last.getUTCFullYear();
  const month = last.getUTCMonth();
  const start =
    precision === "day"
      ? last
      : precision === "month"
        ? new Date(Date.UTC(year, month, 1))
        : precision === "quarter"
          ? new Date(Date.UTC(year, month - 2, 1))
          : precision === "half"
            ? new Date(Date.UTC(year, month - 5, 1))
            : new Date(Date.UTC(year, 0, 1));
  return { start, end, precision };
}

export function formatPhaseLabel(coin: Pick<StablecoinMeta, "launchPhase">): string {
  return coin.launchPhase ? LAUNCH_PHASE_LABELS[coin.launchPhase] : "Unphased";
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Newest first; equal dates keep registry order. */
export function sortMilestonesNewestFirst(milestones: readonly LaunchMilestone[] | undefined): LaunchMilestone[] {
  return [...(milestones ?? [])].sort((a, b) => dateScore(b.date) - dateScore(a.date));
}

/**
 * Drift that needs no clock: without a current target `getDriftStatus` never
 * reads `nowMs`, so a retired-only history resolves at build
 * time (`no-current-target`). Null when there is neither a target nor a retired one.
 */
export function resolveTargetlessDrift(
  coin: Pick<StablecoinMeta, "expectedLaunchDate" | "dateHistory">,
): DriftDisplayStatus | null {
  if (coin.expectedLaunchDate) return null;
  const display = resolveDriftDisplay(getDriftStatus(coin.dateHistory, undefined, 0), undefined);
  return display === "no-current-target" ? display : null;
}

/**
 * The Launch path verdict (≤ 25 words), built from structured fields only:
 * phase, current target and its moves, then the activity count.
 */
export function buildLaunchVerdict(
  coin: Pick<StablecoinMeta, "launchPhase" | "expectedLaunchDate" | "dateHistory" | "milestones" | "announcedDate">,
): string {
  const phase = coin.launchPhase ? `${LAUNCH_PHASE_LABELS[coin.launchPhase]} phase` : "No published phase";
  const moves = coin.dateHistory?.length ?? 0;
  const target = coin.expectedLaunchDate
    ? `targeting ${formatFuzzyDate(coin.expectedLaunchDate)}${moves > 0 ? ` after ${pluralize(moves, "target move")}` : " on its first target"}`
    : resolveTargetlessDrift(coin) === "no-current-target"
      ? "earlier target retired, none set"
      : "no target date";
  const count = coin.milestones?.length ?? 0;
  const activity =
    count === 0
      ? "no activity logged yet"
      : `${pluralize(count, "milestone")} logged${coin.announcedDate ? ` since ${formatFuzzyDate(coin.announcedDate)}` : ""}`;
  return `${phase}, ${target}; ${activity}.`;
}

/** Superseded targets, oldest first, each with the day Pharos retired it. */
export function describeTargetHistory(dateHistory: readonly DateHistoryEntry[] | undefined) {
  return [...(dateHistory ?? [])]
    .sort((a, b) => a.setOn.localeCompare(b.setOn))
    .map((entry) => ({
      key: `${entry.date}-${entry.setOn}`,
      target: formatFuzzyDate(entry.date),
      retiredOn: formatUtcDayLabel(new Date(`${entry.setOn}T00:00:00Z`)),
    }));
}

// ---------------------------------------------------------------------------
// Clock-dependent readings (after mount)
// ---------------------------------------------------------------------------

export type LaunchWindowState = "before" | "open" | "passed";

export interface LaunchClock {
  /** Null when the registry carries no target date. */
  windowState: LaunchWindowState | null;
  /** Whole days until the window opens (`before`), until it closes (`open`) or since it closed (`passed`). */
  windowDays: number | null;
  /** Shared drift vocabulary (`resolveDriftDisplay`); null with neither a current nor a retired target. */
  drift: DriftDisplayStatus | null;
  /** Whole days since the start of the announcement period; null when undated. */
  daysSinceAnnounced: number | null;
  /** The announcement date is a month/quarter/year, so the count is approximate. */
  announcedIsApproximate: boolean;
}

export function computeLaunchClock(
  coin: Pick<StablecoinMeta, "announcedDate" | "expectedLaunchDate" | "dateHistory">,
  nowMs: number,
): LaunchClock {
  const target = coin.expectedLaunchDate ? parseFuzzyRange(coin.expectedLaunchDate) : null;
  let windowState: LaunchWindowState | null = null;
  let windowDays: number | null = null;
  if (target) {
    if (nowMs < target.start.getTime()) {
      windowState = "before";
      windowDays = Math.ceil((target.start.getTime() - nowMs) / DAY_MS);
    } else if (nowMs < target.end.getTime()) {
      windowState = "open";
      windowDays = Math.ceil((target.end.getTime() - nowMs) / DAY_MS);
    } else {
      windowState = "passed";
      windowDays = Math.floor((nowMs - target.end.getTime()) / DAY_MS);
    }
  }
  const announced = coin.announcedDate ? parseFuzzyRange(coin.announcedDate) : null;
  return {
    windowState,
    windowDays,
    drift: target
      ? resolveDriftDisplay(getDriftStatus(coin.dateHistory, coin.expectedLaunchDate, nowMs), coin.expectedLaunchDate)
      : resolveTargetlessDrift(coin),
    daysSinceAnnounced: announced ? Math.max(0, Math.floor((nowMs - announced.start.getTime()) / DAY_MS)) : null,
    announcedIsApproximate: announced != null && announced.precision !== "day",
  };
}

/** "Opens in 12 d" · "Open · closes in 40 d" · "Closed 19 d ago". */
export function describeLaunchWindow(clock: LaunchClock, precision: FuzzyPrecision | null): string | null {
  if (clock.windowState == null || clock.windowDays == null) return null;
  const point = precision === "day";
  if (clock.windowState === "before") return point ? `In ${clock.windowDays} d` : `Window opens in ${clock.windowDays} d`;
  if (clock.windowState === "open") return point ? "Today" : `Window open · closes in ${clock.windowDays} d`;
  return point ? `Passed ${clock.windowDays} d ago` : `Window closed ${clock.windowDays} d ago`;
}

// ---------------------------------------------------------------------------
// Launch path chart model
// ---------------------------------------------------------------------------

export interface LaunchPathTick {
  pct: number;
  label: string;
  /** Year boundaries draw a stronger gridline. */
  major: boolean;
  /** Year boundaries and the first tick carry the year and keep their label on narrow screens. */
  withYear: boolean;
}

export interface LaunchPathBand {
  key: string;
  startPct: number;
  endPct: number;
  label: string;
}

export interface LaunchPathMarker {
  key: string;
  pct: number;
  /** Milestones that share this position at chart resolution. */
  items: { date: string; title: string; type: LaunchMilestone["type"] }[];
  /** Any delay in the cluster draws the delay glyph. */
  hasDelay: boolean;
}

export interface LaunchPathModel {
  ticks: LaunchPathTick[];
  current: LaunchPathBand | null;
  /** Oldest retirement first; the last entry is the most recently retired target. */
  retired: (LaunchPathBand & { retiredOn: string })[];
  markers: LaunchPathMarker[];
  todayPct: number;
  announcedPct: number | null;
}

const MIN_SPAN_MS = 75 * DAY_MS;
const EDGE_PAD = 0.04;
/** Default cluster gap before the plot is measured: markers closer than this many percentage points share one glyph. */
export const DEFAULT_CLUSTER_PCT = 2.5;

function quarterLabel(date: Date): string {
  return `Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function buildTicks(startMs: number, endMs: number, toPct: (ms: number) => number): LaunchPathTick[] {
  const spanDays = (endMs - startMs) / DAY_MS;
  const stepMonths = spanDays > 900 ? 12 : spanDays > 240 ? 3 : 1;
  const first = new Date(startMs);
  let cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - (first.getUTCMonth() % stepMonths) + stepMonths, 1));
  const ticks: LaunchPathTick[] = [];
  while (cursor.getTime() < endMs) {
    const major = cursor.getUTCMonth() === 0;
    // The first tick names its year too, so an axis without a January still dates itself.
    const withYear = major || ticks.length === 0;
    const period = stepMonths === 3
      ? quarterLabel(cursor)
      : cursor.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    const year = String(cursor.getUTCFullYear());
    const label = major ? year : withYear ? `${period} ${year}` : period;
    ticks.push({ pct: toPct(cursor.getTime()), label, major, withYear });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + stepMonths, 1));
  }
  return ticks;
}

export function buildLaunchPathModel(
  coin: Pick<StablecoinMeta, "announcedDate" | "expectedLaunchDate" | "dateHistory" | "milestones">,
  nowMs: number,
  clusterPct: number = DEFAULT_CLUSTER_PCT,
): LaunchPathModel {
  const current = coin.expectedLaunchDate ? parseFuzzyRange(coin.expectedLaunchDate) : null;
  const announced = coin.announcedDate ? parseFuzzyRange(coin.announcedDate) : null;
  const retired = (coin.dateHistory ?? [])
    .map((entry) => ({ entry, range: parseFuzzyRange(entry.date) }))
    .filter((row): row is { entry: DateHistoryEntry; range: FuzzyRange } => row.range != null)
    // Oldest retirement first, so the last band is the most recent target.
    .sort((a, b) => a.entry.setOn.localeCompare(b.entry.setOn));
  const milestones = (coin.milestones ?? [])
    .map((milestone) => ({ milestone, range: parseFuzzyRange(milestone.date) }))
    .filter((row): row is { milestone: LaunchMilestone; range: FuzzyRange } => row.range != null)
    .sort((a, b) => a.range.start.getTime() - b.range.start.getTime());

  const points = [nowMs];
  if (announced) points.push(announced.start.getTime());
  if (current) points.push(current.start.getTime(), current.end.getTime());
  for (const { range } of retired) points.push(range.start.getTime(), range.end.getTime());
  for (const { range } of milestones) points.push(range.start.getTime());

  let minMs = Math.min(...points);
  let maxMs = Math.max(...points);
  if (maxMs - minMs < MIN_SPAN_MS) {
    const grow = (MIN_SPAN_MS - (maxMs - minMs)) / 2;
    minMs -= grow;
    maxMs += grow;
  }
  const pad = (maxMs - minMs) * EDGE_PAD;
  const domainStart = minMs - pad;
  const domainEnd = maxMs + pad;
  const toPct = (ms: number) => Math.min(100, Math.max(0, ((ms - domainStart) / (domainEnd - domainStart)) * 100));

  const markers: LaunchPathMarker[] = [];
  for (const { milestone, range } of milestones) {
    const pct = toPct(range.start.getTime());
    const item = { date: milestone.date, title: milestone.title, type: milestone.type };
    const last = markers.at(-1);
    if (last && pct - last.pct < clusterPct) {
      last.items.push(item);
      last.hasDelay ||= milestone.type === "delay";
    } else {
      markers.push({ key: `${milestone.date}-${markers.length}`, pct, items: [item], hasDelay: milestone.type === "delay" });
    }
  }

  return {
    ticks: buildTicks(domainStart, domainEnd, toPct),
    current:
      current && coin.expectedLaunchDate
        ? {
            key: coin.expectedLaunchDate,
            startPct: toPct(current.start.getTime()),
            endPct: toPct(current.end.getTime()),
            label: formatFuzzyDate(coin.expectedLaunchDate),
          }
        : null,
    retired: retired.map(({ entry, range }) => ({
      key: `${entry.date}-${entry.setOn}`,
      startPct: toPct(range.start.getTime()),
      endPct: toPct(range.end.getTime()),
      label: formatFuzzyDate(entry.date),
      retiredOn: formatUtcDayLabel(new Date(`${entry.setOn}T00:00:00Z`)),
    })),
    markers,
    todayPct: toPct(nowMs),
    announcedPct: announced ? toPct(announced.start.getTime()) : null,
  };
}
