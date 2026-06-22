import { NYFED_EFFR_JSON_URL, USER_AGENT } from "../../lib/constants";
import {
  fetchAndParseBenchmark,
  isValidBenchmarkRateForKey,
  parseRate,
} from "./shared";
import type { BenchmarkFetchResult } from "./shared";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseNyFedEffrJson(json: string): BenchmarkFetchResult | null {
  try {
    const parsed = JSON.parse(json) as {
      refRates?: Array<{
        effectiveDate?: unknown;
        type?: unknown;
        percentRate?: unknown;
      }>;
    };
    const observations = parsed.refRates;
    if (!Array.isArray(observations) || observations.length === 0) return null;

    const effrObservations = observations.filter((entry) => {
      const type = typeof entry.type === "string" ? entry.type.toUpperCase() : "";
      return type === "" || type === "EFFR";
    });

    for (let i = effrObservations.length - 1; i >= 0; i--) {
      const entry = effrObservations[i];
      const recordDate = typeof entry.effectiveDate === "string" && ISO_DATE_RE.test(entry.effectiveDate)
        ? entry.effectiveDate
        : null;
      const rate = parseRate(entry.percentRate as string | number | null | undefined);
      if (!recordDate || !isValidBenchmarkRateForKey("USD_EFFR", rate)) continue;
      return { recordDate, rate, source: "nyfed-effr" };
    }
    return null;
  } catch {
    return null;
  }
}

export async function tryNyFedEffr(signal?: AbortSignal): Promise<BenchmarkFetchResult | null> {
  return fetchAndParseBenchmark({
    url: NYFED_EFFR_JSON_URL,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    parse: parseNyFedEffrJson,
    warnLabel: "NY Fed EFFR JSON",
    signal,
  });
}
