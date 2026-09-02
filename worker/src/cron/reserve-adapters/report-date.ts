export const MONTH_LABEL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const MONTH_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  MONTH_LABEL.map((label, index) => [label.toLowerCase(), index]),
);

const MONTH_INDEX_BY_PREFIX: Readonly<Record<string, number>> = Object.fromEntries(
  MONTH_LABEL.map((label, index) => [label.slice(0, 3).toLowerCase(), index]),
);

function monthIndexFromLabel(rawMonth: string): number | null {
  const key = rawMonth.toLowerCase().replace(/[^a-z]/g, "").slice(0, 3);
  return MONTH_INDEX_BY_PREFIX[key] ?? null;
}

export function monthNumberFromLabel(rawMonth: string): number | null {
  const monthIndex = monthIndexFromLabel(rawMonth);
  return monthIndex == null ? null : monthIndex + 1;
}

export function lastDayOfMonth(year: number, month: number): number | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function formatValidIsoDate(
  year: number,
  month: number,
  day: number,
  minimumYear = 0,
): string | null {
  const lastDay = lastDayOfMonth(year, month);
  if (!Number.isInteger(day) || year < minimumYear || lastDay == null || day < 1 || day > lastDay) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export type ReportDatePrecision = "day" | "month";

export type ReportDateParserEntry =
  | { kind: "day"; regex: RegExp; year: number; month: number; day: number; monthIsName?: boolean }
  | { kind: "month"; regex: RegExp; year: number; month: number; monthIsName?: boolean };

export interface ParsedReportDateCandidate {
  sourceTimestamp: number;
  reportDate: string;
  reportDateLabel: string;
  reportDatePrecision: ReportDatePrecision;
  reportPeriod?: string;
}

export function parseReportDateCandidates(
  value: string,
  parsers: readonly ReportDateParserEntry[],
): ParsedReportDateCandidate[] {
  const candidates: ParsedReportDateCandidate[] = [];
  for (const parser of parsers) {
    for (const match of value.matchAll(parser.regex)) {
      const monthRaw = match[parser.month] ?? "";
      const month = parser.monthIsName ? monthNumberFromLabel(monthRaw) : Number(monthRaw);
      if (month == null || Number.isNaN(month)) continue;
      const yearRaw = match[parser.year] ?? "";
      const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
      const day = parser.kind === "day"
        ? Number(match[parser.day])
        : lastDayOfMonth(year, month);
      if (day == null) continue;
      const reportDate = formatValidIsoDate(year, month, day);
      if (reportDate == null) continue;
      const monthLabel = MONTH_LABEL[month - 1];
      if (!monthLabel) continue;
      candidates.push({
        sourceTimestamp: Date.UTC(year, month - 1, day) / 1000,
        reportDate,
        reportDateLabel: `${monthLabel} ${day}, ${year}`,
        reportDatePrecision: parser.kind,
        ...(parser.kind === "month" ? { reportPeriod: `${monthLabel} ${year}` } : {}),
      });
    }
  }
  return candidates;
}
