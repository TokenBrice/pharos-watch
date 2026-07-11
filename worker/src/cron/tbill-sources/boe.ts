import { BOE_SONIA_CSV_BASE_URL, USER_AGENT } from "../../lib/constants";
import { DAY_MS } from "@shared/lib/time-constants";
import {
  addDays,
  type BenchmarkResponseDiagnostic,
  fetchAndParseBenchmark,
  isValidBenchmarkRate,
  parseEnglishDate,
  parseIsoDateMs,
  parseRate,
} from "./shared";

const BOE_SONIA_COMPOUNDED_INDEX_SERIES_CODE = "IUDZOS2";
const BOE_COMPOUNDED_SONIA_WINDOW_DAYS = 90;
const BOE_COMPOUNDED_SONIA_LOOKBACK_DAYS = 140;

// Spot-SONIA fallback parser, currently not wired into production: GBP resolves
// via parseBoeSoniaCompoundedIndexCsv. Retained (covered only by its own test).
export function parseBoeSoniaCsv(csv: string): { recordDate: string; rate: number } | null {
  const lines = csv.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const [dateRaw, rateRaw] = line.split(",");
    const recordDate = dateRaw ? parseEnglishDate(dateRaw) : null;
    const rate = parseRate(rateRaw);
    if (!recordDate || !isValidBenchmarkRate(rate)) continue;
    return { recordDate, rate };
  }
  return null;
}

export interface SoniaCompoundedObservation {
  recordDate: string;
  indexValue: number;
  timestampMs: number;
}

/**
 * Derive the trailing ~3-month annualized SONIA rate from a series of SONIA
 * Compounded Index observations. Source-agnostic: callers parse their own CSV
 * format (BoE IADB or St. Louis Fed IUDZOS2 graph mirrors) into observations.
 */
export function deriveSoniaCompoundedRate(
  observations: readonly SoniaCompoundedObservation[],
): { recordDate: string; rate: number } | null {
  const sorted = [...observations].sort((a, b) => a.timestampMs - b.timestampMs);

  const latest = sorted[sorted.length - 1];
  if (!latest) return null;

  const targetStartMs = latest.timestampMs - BOE_COMPOUNDED_SONIA_WINDOW_DAYS * DAY_MS;
  const start = [...sorted].reverse().find((entry) => entry.timestampMs <= targetStartMs);
  if (!start || start.indexValue <= 0) return null;

  const dayCount = (latest.timestampMs - start.timestampMs) / DAY_MS;
  if (!Number.isFinite(dayCount) || dayCount < 80) return null;

  const rate = ((latest.indexValue / start.indexValue - 1) * 365 / dayCount) * 100;
  if (!isValidBenchmarkRate(rate)) return null;

  return { recordDate: latest.recordDate, rate };
}

export function parseBoeSoniaCompoundedIndexCsv(csv: string): { recordDate: string; rate: number } | null {
  const observations = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [dateRaw, indexRaw] = line.split(",");
      const recordDate = dateRaw ? parseEnglishDate(dateRaw) : null;
      const indexValue = parseRate(indexRaw);
      const timestampMs = recordDate ? parseIsoDateMs(recordDate) : Number.NaN;
      return recordDate && Number.isFinite(timestampMs) && Number.isFinite(indexValue) && indexValue > 0
        ? [{ recordDate, indexValue, timestampMs }]
        : [];
    });

  return deriveSoniaCompoundedRate(observations);
}

function formatBoeRequestDate(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(date.getUTCDate()).padStart(2, "0")}/${months[date.getUTCMonth()]}/${date.getUTCFullYear()}`;
}

function buildBoeIadbCsvUrl(seriesCode: string, now = new Date(), lookbackDays = 21): string {
  const url = new URL(BOE_SONIA_CSV_BASE_URL);
  url.searchParams.set("csv.x", "yes");
  url.searchParams.set("Datefrom", formatBoeRequestDate(addDays(now, -lookbackDays)));
  url.searchParams.set("Dateto", formatBoeRequestDate(now));
  url.searchParams.set("SeriesCodes", seriesCode);
  url.searchParams.set("UsingCodes", "Y");
  url.searchParams.set("VPD", "Y");
  url.searchParams.set("VFD", "N");
  return url.toString();
}

function buildBoeSoniaCompoundedIndexCsvUrl(now = new Date()): string {
  return buildBoeIadbCsvUrl(
    BOE_SONIA_COMPOUNDED_INDEX_SERIES_CODE,
    now,
    BOE_COMPOUNDED_SONIA_LOOKBACK_DAYS,
  );
}

export async function tryBoeSoniaCompoundedIndex(
  signal?: AbortSignal,
  onDiagnostic?: (diagnostic: BenchmarkResponseDiagnostic) => void,
): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: buildBoeSoniaCompoundedIndexCsvUrl(),
    headers: { "User-Agent": USER_AGENT },
    parse: parseBoeSoniaCompoundedIndexCsv,
    warnLabel: "BoE SONIA Compounded Index CSV",
    signal,
    onDiagnostic,
  });
}
