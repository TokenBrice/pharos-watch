import { BCB_SELIC_URL, BCB_SELIC_ANNUALIZED_URL, USER_AGENT } from "../../lib/constants";
import {
  fetchAndParseBenchmark,
  isValidBenchmarkRate,
  parseIsoDateMs,
  parseSlashDmyToIso,
  type BenchmarkResponseDiagnostic,
} from "./shared";

const BCB_SELIC_ANNUALIZATION_BUSINESS_DAYS = 252;
// /ultimos/1 is one small observation; bound error pages as well as valid JSON.
const BCB_SELIC_MAX_RESPONSE_BYTES = 16 * 1024;

function annualizeDailyPercentageRate(rate: number, businessDays: number): number {
  return ((1 + rate / 100) ** businessDays - 1) * 100;
}

type SelicUnit = "daily-percent" | "annual-percent-base-252";

function parseSelicSeries(
  json: string,
  unit: SelicUnit,
  onUpstreamError?: (status?: number) => void,
): { recordDate: string; rate: number } | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      if (parsed !== null && typeof parsed === "object" && "erro" in parsed) {
        const error = parsed.erro;
        const status = error !== null && typeof error === "object" && "statusCode" in error
          ? error.statusCode : undefined;
        onUpstreamError?.(typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
          ? status : undefined);
      }
      return null;
    }
    if (parsed.length === 0) return null;
    for (let i = parsed.length - 1; i >= 0; i--) {
      const row = parsed[i];
      const value = typeof row?.valor === "string" ? row.valor.trim() : "";
      // SGS uses decimal percentages, never fractions, exponents or numeric prefixes.
      if (!/^\d+(?:[.,]\d+)?$/.test(value)) continue;
      const rate = Number(value.replace(",", "."));
      if (!Number.isFinite(rate) || rate <= 0) continue;
      const dataRaw = typeof row?.data === "string" ? row.data : null;
      const annualizedRate = unit === "daily-percent"
        ? annualizeDailyPercentageRate(rate, BCB_SELIC_ANNUALIZATION_BUSINESS_DAYS)
        : rate;
      if (!dataRaw || !isValidBenchmarkRate(annualizedRate)) continue;
      const recordDate = parseSlashDmyToIso(dataRaw);
      // Date.parse normalizes impossible dates (e.g. February 30); reject those.
      const timestamp = recordDate ? parseIsoDateMs(recordDate) : Number.NaN;
      if (!recordDate || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== recordDate) continue;
      return { rate: annualizedRate, recordDate };
    }
    return null;
  } catch {
    return null;
  }
}

/** SGS11 effective overnight Selic, compounded over 252 business days. */
export function parseBcbSelicSeries(
  json: string,
  onUpstreamError?: (status?: number) => void,
) {
  return parseSelicSeries(json, "daily-percent", onUpstreamError);
}

/** SGS1178 is the same effective Selic, already annualized; never compound twice. */
export function parseBcbSelicAnnualizedSeries(
  json: string,
  onUpstreamError?: (status?: number) => void,
) {
  return parseSelicSeries(json, "annual-percent-base-252", onUpstreamError);
}

async function fetchSelic(
  url: string,
  parse: typeof parseBcbSelicSeries,
  signal?: AbortSignal,
  onDiagnostic?: (diagnostic: BenchmarkResponseDiagnostic) => void,
): Promise<{ rate: number; recordDate: string } | null> {
  let upstreamError = false;
  let upstreamStatus: number | undefined;
  let htmlBody = false;
  return fetchAndParseBenchmark({
    url,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    maxResponseBytes: BCB_SELIC_MAX_RESPONSE_BYTES,
    parse: body => {
      htmlBody = /^\s*</.test(body);
      return parse(body, status => { upstreamError = true; upstreamStatus = status; });
    },
    warnLabel: "BCB SELIC",
    signal,
    onDiagnostic: diagnostic => onDiagnostic?.({
      ...diagnostic,
      ...(htmlBody && diagnostic.failure === "parse-failed" ? { failure: "html-body" as const } : {}),
      ...(upstreamError ? { failure: "upstream-error" as const, ...(upstreamStatus != null ? { upstreamStatus } : {}) } : {}),
    }),
  });
}

export function tryBcbSelic(
  signal?: AbortSignal,
  onDiagnostic?: (diagnostic: BenchmarkResponseDiagnostic) => void,
) {
  return fetchSelic(BCB_SELIC_URL, parseBcbSelicSeries, signal, onDiagnostic);
}

export function tryBcbSelicAnnualized(
  signal?: AbortSignal,
  onDiagnostic?: (diagnostic: BenchmarkResponseDiagnostic) => void,
) {
  return fetchSelic(BCB_SELIC_ANNUALIZED_URL, parseBcbSelicAnnualizedSeries, signal, onDiagnostic);
}
