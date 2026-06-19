import { BOJ_CALL_RATE_JSON_BASE_URL, USER_AGENT } from "../../lib/constants";
import {
  addDays,
  fetchAndParseBenchmark,
  isValidBenchmarkRate,
  parseCompactDate,
  parseRate,
} from "./shared";

export function parseBojCallRateJson(json: string): { recordDate: string; rate: number } | null {
  try {
    const parsed = JSON.parse(json) as {
      RESULTSET?: Array<{
        SERIES_CODE?: unknown;
        VALUES?: {
          SURVEY_DATES?: Array<number | string>;
          VALUES?: Array<number | string | null>;
        };
      }>;
    };
    const series = parsed.RESULTSET?.find((entry) => entry.SERIES_CODE === "STRDCLUCON") ?? parsed.RESULTSET?.[0];
    const dates = series?.VALUES?.SURVEY_DATES;
    const values = series?.VALUES?.VALUES;
    if (!Array.isArray(dates) || !Array.isArray(values)) return null;
    for (let i = Math.min(dates.length, values.length) - 1; i >= 0; i--) {
      const recordDate = parseCompactDate(dates[i]);
      const rate = parseRate(values[i]);
      if (!recordDate || !isValidBenchmarkRate(rate)) continue;
      return { recordDate, rate };
    }
    return null;
  } catch {
    return null;
  }
}

function buildBojCallRateJsonUrl(now = new Date()): string {
  const start = addDays(now, -45);
  const url = new URL(BOJ_CALL_RATE_JSON_BASE_URL);
  url.searchParams.set("format", "json");
  url.searchParams.set("lang", "en");
  url.searchParams.set("db", "FM01");
  url.searchParams.set("code", "STRDCLUCON");
  url.searchParams.set(
    "startDate",
    `${start.getUTCFullYear()}${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
  );
  return url.toString();
}

export async function tryBojCallRate(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: buildBojCallRateJsonUrl(),
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    parse: parseBojCallRateJson,
    warnLabel: "BOJ call-rate JSON",
    signal,
  });
}
