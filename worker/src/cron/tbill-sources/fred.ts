import {
  ALFRED_SONIA_COMPOUNDED_INDEX_CSV_URL,
  FRED_SONIA_COMPOUNDED_INDEX_CSV_URL,
} from "../../lib/constants";
import {
  fetchAndParseBenchmark,
  type BenchmarkResponseDiagnostic,
  isValidBenchmarkRate,
  parseIsoDateMs,
  parseRate,
} from "./shared";
import { deriveSoniaCompoundedRate } from "./boe";

const ST_LOUIS_FED_SONIA_MAX_OBSERVATION_AGE_DAYS = 140;
const ST_LOUIS_FED_SONIA_MAX_FUTURE_SKEW_DAYS = 1;
// The graph edge returns HTTP 520 to generic and browser user agents from
// Workers. A contact-bearing product UA is accepted by both FRED and ALFRED.
const ST_LOUIS_FED_USER_AGENT = "Pharos/1.0 (+https://pharos.watch)";
const DAY_MS = 24 * 60 * 60 * 1000;

function parseFredLatest(csv: string): { recordDate: string; rate: number } | null {
  const lines = csv.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const [recordDate, rateRaw] = line.split(",");
    if (!recordDate || !rateRaw) continue;
    const rate = parseRate(rateRaw);
    if (!isValidBenchmarkRate(rate)) continue;
    return { recordDate, rate };
  }
  return null;
}

export async function tryFredCsv(
  url: string,
  signal?: AbortSignal,
): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url,
    headers: { "User-Agent": ST_LOUIS_FED_USER_AGENT },
    parse: parseFredLatest,
    warnLabel: "FRED CSV",
    signal,
  });
}

// The St. Louis Fed graph CSV mirrors for IUDZOS2 expose the BoE SONIA
// Compounded Index with ISO dates (`YYYY-MM-DD,<index>`); the header and
// missing-value (".") rows fail the finite/positive checks and drop out. The
// derived rate is identical to the BoE source because it is the same index
// series and derivation window.
function parseFredSoniaCompoundedIndexCsv(csv: string): { recordDate: string; rate: number } | null {
  const observations = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [recordDate, indexRaw] = line.split(",");
      const indexValue = parseRate(indexRaw);
      const timestampMs = recordDate ? parseIsoDateMs(recordDate) : Number.NaN;
      return recordDate && Number.isFinite(timestampMs) && Number.isFinite(indexValue) && indexValue > 0
        ? [{ recordDate, indexValue, timestampMs }]
        : [];
    });

  const derived = deriveSoniaCompoundedRate(observations);
  if (!derived) return null;

  // The St. Louis Fed graph endpoints are unbounded historical CSVs; reject
  // stale/future latest observations so they trigger the next GBP fallback
  // instead of being stamped as a fresh market benchmark for this cron run.
  const latestTimestampMs = parseIsoDateMs(derived.recordDate);
  const nowMs = Date.now();
  const oldestAllowedMs = nowMs - ST_LOUIS_FED_SONIA_MAX_OBSERVATION_AGE_DAYS * DAY_MS;
  const newestAllowedMs = nowMs + ST_LOUIS_FED_SONIA_MAX_FUTURE_SKEW_DAYS * DAY_MS;
  if (
    !Number.isFinite(latestTimestampMs) ||
    latestTimestampMs < oldestAllowedMs ||
    latestTimestampMs > newestAllowedMs
  ) {
    return null;
  }

  return derived;
}

export async function tryFredSoniaCompoundedIndex(
  signal?: AbortSignal,
  onDiagnostic?: (diagnostic: BenchmarkResponseDiagnostic) => void,
): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: FRED_SONIA_COMPOUNDED_INDEX_CSV_URL,
    headers: { "User-Agent": ST_LOUIS_FED_USER_AGENT },
    parse: parseFredSoniaCompoundedIndexCsv,
    warnLabel: "FRED SONIA Compounded Index CSV",
    signal,
    onDiagnostic,
  });
}

export async function tryAlfredSoniaCompoundedIndex(
  signal?: AbortSignal,
  onDiagnostic?: (diagnostic: BenchmarkResponseDiagnostic) => void,
): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: ALFRED_SONIA_COMPOUNDED_INDEX_CSV_URL,
    headers: { "User-Agent": ST_LOUIS_FED_USER_AGENT },
    parse: parseFredSoniaCompoundedIndexCsv,
    warnLabel: "ALFRED SONIA Compounded Index CSV",
    signal,
    onDiagnostic,
  });
}
