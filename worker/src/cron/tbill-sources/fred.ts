import { ALFRED_SONIA_COMPOUNDED_INDEX_CSV_URL, FRED_SONIA_COMPOUNDED_INDEX_CSV_URL, USER_AGENT } from "../../lib/constants";
import {
  fetchAndParseBenchmark,
  isValidBenchmarkRate,
  parseIsoDateMs,
  parseRate,
} from "./shared";
import { deriveSoniaCompoundedRate } from "./boe";

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
    headers: { "User-Agent": USER_AGENT },
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

  return deriveSoniaCompoundedRate(observations);
}

export async function tryFredSoniaCompoundedIndex(
  signal?: AbortSignal,
): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: FRED_SONIA_COMPOUNDED_INDEX_CSV_URL,
    headers: { "User-Agent": USER_AGENT },
    parse: parseFredSoniaCompoundedIndexCsv,
    warnLabel: "FRED SONIA Compounded Index CSV",
    signal,
  });
}

export async function tryAlfredSoniaCompoundedIndex(
  signal?: AbortSignal,
): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: ALFRED_SONIA_COMPOUNDED_INDEX_CSV_URL,
    headers: { "User-Agent": USER_AGENT },
    parse: parseFredSoniaCompoundedIndexCsv,
    warnLabel: "ALFRED SONIA Compounded Index CSV",
    signal,
  });
}
