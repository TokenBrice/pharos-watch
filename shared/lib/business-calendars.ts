import { REVIEWED_BUSINESS_CALENDARS } from "../data/business-calendars/reviewed";
import type { ReviewedBusinessCalendar } from "../types/business-calendars";
import { RedemptionBusinessDayTermsSchema, type RedemptionBusinessDayTerms } from "../types/redemption";
import { isValidIsoDateOnly } from "../types/date-primitives";
import { V9_CANDIDATE_RESERVE_BOUND_POLICY } from "./safety-score-v9/reserve-bound-policy";

/** One authority for the admissible submission horizon and reviewed-calendar age. */
export const BUSINESS_CALENDAR_BOUND_POLICY = {
  submissionHorizonDays: 365,
  reviewedMaxAgeSec: V9_CANDIDATE_RESERVE_BOUND_POLICY.reviewedResearchMaxAgeSec,
} as const;
export type BusinessCalendarBound =
  | { state: "known"; maximumElapsedSec: number; completionDate: string; worstSubmissionDate: string; calendarId: string; calendarReviewedAt: string; sourceUrls: readonly string[] }
  | { state: "unknown"; reason: "conditional-terms" | "target-not-guarantee" | "cutoff-unreviewed" | "calendar-mismatch" | "calendar-review-future" | "calendar-review-stale" | "coverage-exceeded" | "invalid-terms" | "timezone-transition-unresolved" };
type CalendarWalkContext = {
  from: number; to: number; cutoff: string;
  parts: (sec: number) => { date: string; time: string };
  instant: (day: number, time: string) => number | null;
  businessDay: (day: number) => boolean;
  complete: (submissionDay: number, afterCutoff: boolean) => number | null;
};

const DAY_MS = 86_400_000; // Civil-date indexing only; elapsed time always uses timezone-bound instants.
function dateAt(index: number): string { return new Date(index * DAY_MS).toISOString().slice(0, 10); }
function dayIndex(date: string): number { return Date.parse(`${date}T00:00:00Z`) / DAY_MS; }

function calendarWalker(
  terms: RedemptionBusinessDayTerms, calendar: ReviewedBusinessCalendar, clockSec: number,
): CalendarWalkContext | { error: Extract<BusinessCalendarBound, { state: "unknown" }>["reason"] } {
  const parsed = RedemptionBusinessDayTermsSchema.safeParse(terms);
  if (!parsed.success || !Number.isFinite(clockSec)) return { error: "invalid-terms" as const };
  if (terms.conditional) return { error: "conditional-terms" as const };
  if (terms.assurance !== "binding-guarantee") return { error: "target-not-guarantee" as const };
  if (terms.cutoff.time === null) return { error: "cutoff-unreviewed" as const };
  if (calendar.id !== terms.calendarId || calendar.timezone !== terms.cutoff.timezone) return { error: "calendar-mismatch" as const };
  const reviewedSec = Date.parse(`${calendar.reviewedAt}T00:00:00Z`) / 1_000;
  if (reviewedSec > clockSec) return { error: "calendar-review-future" as const };
  if (clockSec - reviewedSec > BUSINESS_CALENDAR_BOUND_POLICY.reviewedMaxAgeSec) return { error: "calendar-review-stale" as const };
  const from = dayIndex(calendar.coverage.from), to = dayIndex(calendar.coverage.to);
  const holidays = new Set(calendar.holidays);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: calendar.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const parts = (sec: number) => {
    const values: Record<string, string> = {};
    for (const part of formatter.formatToParts(sec * 1_000)) values[part.type] = part.value;
    return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}:${values.second}` };
  };
  // Offsets sampled on both sides of the local date handle DST without fixed-offset arithmetic.
  // Ambiguous/nonexistent local cutoffs fail closed rather than choosing the favorable occurrence.
  const instants = new Map<string, number | null>();
  const instant = (day: number, time: string): number | null => {
    const key = `${day}:${time}`;
    if (instants.has(key)) return instants.get(key)!;
    const wall = Date.parse(`${dateAt(day)}T${time}:00Z`) / 1_000;
    const candidates = new Set<number>();
    for (const delta of [-DAY_MS, 0, DAY_MS]) {
      const sample = wall + delta / 1_000;
      const local = parts(sample);
      const offset = Date.parse(`${local.date}T${local.time}Z`) / 1_000 - sample;
      const candidate = wall - offset;
      const match = parts(candidate);
      if (match.date === dateAt(day) && match.time === `${time}:00`) candidates.add(candidate);
    }
    const result = candidates.size === 1 ? [...candidates][0]! : null;
    instants.set(key, result);
    return result;
  };
  const businessDay = (day: number) => !calendar.weekendDays.includes(new Date(day * DAY_MS).getUTCDay()) && !holidays.has(dateAt(day));
  const complete = (submissionDay: number, afterCutoff: boolean) => {
    if (submissionDay < from || submissionDay > to) return null;
    let day = submissionDay;
    if (afterCutoff && businessDay(day)) day++;
    while (day <= to && !businessDay(day)) day++;
    for (let remaining = terms.businessDays; remaining > 0 && day <= to; remaining--) {
      do { day++; } while (day <= to && !businessDay(day));
    }
    return day <= to ? day : null;
  };
  return { from, to, parts, instant, businessDay, complete, cutoff: terms.cutoff.time };
}

/** Latest end-of-day completion for one submission; T is the first accepted processing day. */
export function walkBusinessDaySettlement(
  terms: RedemptionBusinessDayTerms, submittedAtSec: number, clockSec: number,
  calendar = REVIEWED_BUSINESS_CALENDARS[terms.calendarId],
): BusinessCalendarBound {
  const walker = calendarWalker(terms, calendar, clockSec);
  if ("error" in walker) return { state: "unknown", reason: walker.error };
  if (!Number.isFinite(submittedAtSec)) return { state: "unknown", reason: "invalid-terms" };
  const date = walker.parts(submittedAtSec).date, day = dayIndex(date);
  const cutoff = walker.instant(day, walker.cutoff);
  if (cutoff === null) return { state: "unknown", reason: "timezone-transition-unresolved" };
  const completion = walker.complete(day, submittedAtSec >= cutoff);
  if (completion === null) return { state: "unknown", reason: "coverage-exceeded" };
  const end = walker.instant(completion + 1, "00:00");
  if (end === null) return { state: "unknown", reason: "timezone-transition-unresolved" };
  return { state: "known", maximumElapsedSec: Math.ceil(end - submittedAtSec), completionDate: dateAt(completion), worstSubmissionDate: date, calendarId: calendar.id, calendarReviewedAt: calendar.reviewedAt, sourceUrls: calendar.sourceUrls };
}

/**
 * Exhaustive maximum over every admissible submission date, including closed days.
 * Within each before/after-cutoff interval completion is fixed: its earliest instant
 * maximizes elapsed time. The cutoff instant is the conservative supremum of requests
 * just after cutoff. No holiday clusters are approximated or independently maximized.
 */
export function maximumBusinessDaySettlement(
  terms: RedemptionBusinessDayTerms, clockSec: number,
  submissionWindow?: { from: string; to: string },
  calendar = REVIEWED_BUSINESS_CALENDARS[terms.calendarId],
): BusinessCalendarBound {
  const walker = calendarWalker(terms, calendar, clockSec);
  if ("error" in walker) return { state: "unknown", reason: walker.error };
  const start = submissionWindow?.from ?? walker.parts(clockSec).date;
  const first = dayIndex(start);
  const end = submissionWindow?.to ?? dateAt(first + BUSINESS_CALENDAR_BOUND_POLICY.submissionHorizonDays - 1);
  const last = dayIndex(end);
  if (!isValidIsoDateOnly(start) || !isValidIsoDateOnly(end) || first > last) return { state: "unknown", reason: "invalid-terms" };
  if (first < walker.from || last > walker.to) return { state: "unknown", reason: "coverage-exceeded" };
  let maximum = -1, worstDay = first, completionDay = first;
  for (let day = first; day <= last; day++) {
    const midnight = walker.instant(day, "00:00"), cutoff = walker.instant(day, walker.cutoff);
    if (midnight === null || cutoff === null) return { state: "unknown", reason: "timezone-transition-unresolved" };
    for (const afterCutoff of [false, true]) {
      const submitted = afterCutoff ? cutoff : midnight;
      // A closed day has one completion branch and its midnight dominates its cutoff.
      if (afterCutoff && !walker.businessDay(day)) continue;
      const completion = walker.complete(day, afterCutoff);
      if (completion === null) return { state: "unknown", reason: "coverage-exceeded" };
      const completed = walker.instant(completion + 1, "00:00");
      if (completed === null) return { state: "unknown", reason: "timezone-transition-unresolved" };
      if (completed - submitted > maximum) { maximum = completed - submitted; worstDay = day; completionDay = completion; }
    }
  }
  return { state: "known", maximumElapsedSec: Math.ceil(maximum), completionDate: dateAt(completionDay), worstSubmissionDate: dateAt(worstDay), calendarId: calendar.id, calendarReviewedAt: calendar.reviewedAt, sourceUrls: calendar.sourceUrls };
}
