import { BOC_CORRA_URL, USER_AGENT } from "../../lib/constants";
import { fetchAndParseBenchmark, isValidBenchmarkRate, parseRate } from "./shared";

/**
 * Parse a Bank of Canada Valet observations response. Shape:
 *   { observations: [{ d: "YYYY-MM-DD", V122530: { v: "4.75" } }] }
 */
export function parseBocValetSeries(
  json: string,
  seriesCode: string,
): { recordDate: string; rate: number } | null {
  try {
    const parsed = JSON.parse(json) as { observations?: Array<Record<string, unknown>> };
    const observations = parsed.observations;
    if (!Array.isArray(observations) || observations.length === 0) return null;
    for (let i = observations.length - 1; i >= 0; i--) {
      const obs = observations[i];
      const d = typeof obs?.d === "string" ? obs.d : null;
      const cell = obs?.[seriesCode] as { v?: unknown } | undefined;
      const rate = parseRate(typeof cell?.v === "string" ? cell.v : null);
      if (!d || !isValidBenchmarkRate(rate)) continue;
      return { rate, recordDate: d };
    }
    return null;
  } catch {
    return null;
  }
}

export async function tryBocCorra(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: BOC_CORRA_URL,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    parse: (body) => parseBocValetSeries(body, "V122530"),
    warnLabel: "BoC Valet CORRA",
    signal,
  });
}
