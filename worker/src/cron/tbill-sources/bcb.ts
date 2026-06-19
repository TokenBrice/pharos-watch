import { BCB_SELIC_URL, USER_AGENT } from "../../lib/constants";
import {
  fetchAndParseBenchmark,
  isValidBenchmarkRate,
  parseRate,
  parseSlashDmyToIso,
} from "./shared";

const BCB_SELIC_ANNUALIZATION_BUSINESS_DAYS = 252;

function annualizeDailyPercentageRate(rate: number, businessDays: number): number {
  return ((1 + rate / 100) ** businessDays - 1) * 100;
}

/**
 * Parse a BCB SGS response. Shape:
 *   [{ data: "DD/MM/YYYY", valor: "0.050747" }]
 * BCB SGS series 11 returns SELIC over as a daily percentage, so annualize it
 * before storing the BRL benchmark alongside the other APY-compatible rates.
 */
export function parseBcbSelicSeries(json: string): { recordDate: string; rate: number } | null {
  try {
    const parsed = JSON.parse(json) as Array<{ data?: unknown; valor?: unknown }>;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    for (let i = parsed.length - 1; i >= 0; i--) {
      const row = parsed[i];
      const rate = parseRate(typeof row?.valor === "string" ? row.valor : null);
      const dataRaw = typeof row?.data === "string" ? row.data : null;
      const annualizedRate = annualizeDailyPercentageRate(rate, BCB_SELIC_ANNUALIZATION_BUSINESS_DAYS);
      if (!dataRaw || !isValidBenchmarkRate(annualizedRate)) continue;
      const recordDate = parseSlashDmyToIso(dataRaw);
      if (!recordDate) continue;
      return { rate: annualizedRate, recordDate };
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
