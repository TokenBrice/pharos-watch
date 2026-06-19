import { BCB_SELIC_URL, USER_AGENT } from "../../lib/constants";
import {
  fetchAndParseBenchmark,
  isValidBenchmarkRate,
  parseRate,
  parseSlashDmyToIso,
} from "./shared";

/**
 * Parse a BCB SGS response. Shape:
 *   [{ data: "DD/MM/YYYY", valor: "12.75" }]
 * BCB returns SELIC over as a daily rate; we treat it directly as a daily APY proxy.
 */
export function parseBcbSelicSeries(json: string): { recordDate: string; rate: number } | null {
  try {
    const parsed = JSON.parse(json) as Array<{ data?: unknown; valor?: unknown }>;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    for (let i = parsed.length - 1; i >= 0; i--) {
      const row = parsed[i];
      const rate = parseRate(typeof row?.valor === "string" ? row.valor : null);
      const dataRaw = typeof row?.data === "string" ? row.data : null;
      if (!dataRaw || !isValidBenchmarkRate(rate)) continue;
      const recordDate = parseSlashDmyToIso(dataRaw);
      if (!recordDate) continue;
      return { rate, recordDate };
    }
    return null;
  } catch {
    return null;
  }
}

export async function tryBcbSelic(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: BCB_SELIC_URL,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    parse: parseBcbSelicSeries,
    warnLabel: "BCB SELIC",
    signal,
  });
}
