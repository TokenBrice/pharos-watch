import { BCB_SELIC_URL, USER_AGENT } from "../../lib/constants";
import {
  fetchAndParseBenchmark,
  isValidBenchmarkRate,
  parseRate,
  parseSlashDmyToIso,
  type BenchmarkResponseDiagnostic,
} from "./shared";

const BCB_SELIC_ANNUALIZATION_BUSINESS_DAYS = 252;
const BCB_SELIC_MIN_DAILY_PERCENTAGE_RATE = 0;

function isValidBcbSelicDailyRate(rate: number): boolean {
  return Number.isFinite(rate) && rate > BCB_SELIC_MIN_DAILY_PERCENTAGE_RATE;
}

function annualizeDailyPercentageRate(rate: number, businessDays: number): number {
  return ((1 + rate / 100) ** businessDays - 1) * 100;
}

/**
 * Parse a BCB SGS response. Shape:
 *   [{ data: "DD/MM/YYYY", valor: "0.050747" }]
 * BCB SGS series 11 returns SELIC over as a daily percentage, so annualize it
 * before storing the BRL benchmark alongside the other APY-compatible rates.
 */
export function parseBcbSelicSeries(
  json: string,
  onUpstreamError?: (status: number) => void,
): { recordDate: string; rate: number } | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      if (parsed !== null && typeof parsed === "object" && "erro" in parsed &&
        parsed.erro !== null && typeof parsed.erro === "object" && "statusCode" in parsed.erro &&
        typeof parsed.erro.statusCode === "number" && Number.isInteger(parsed.erro.statusCode) &&
        parsed.erro.statusCode >= 400 && parsed.erro.statusCode <= 599) {
        onUpstreamError?.(parsed.erro.statusCode);
      }
      return null;
    }
    if (parsed.length === 0) return null;
    for (let i = parsed.length - 1; i >= 0; i--) {
      const row = parsed[i];
      const rate = parseRate(typeof row?.valor === "string" ? row.valor : null);
      const dataRaw = typeof row?.data === "string" ? row.data : null;
      if (!isValidBcbSelicDailyRate(rate)) continue;
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

export async function tryBcbSelic(
  signal?: AbortSignal,
  onDiagnostic?: (diagnostic: BenchmarkResponseDiagnostic) => void,
): Promise<{ rate: number; recordDate: string } | null> {
  let upstreamStatus: number | undefined;
  return fetchAndParseBenchmark({
    url: BCB_SELIC_URL,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    parse: body => parseBcbSelicSeries(body, status => { upstreamStatus = status; }),
    warnLabel: "BCB SELIC",
    signal,
    onDiagnostic: onDiagnostic ? diagnostic => onDiagnostic(
      upstreamStatus === undefined ? diagnostic : { ...diagnostic, failure: "upstream-error", upstreamStatus },
    ) : undefined,
  });
}
