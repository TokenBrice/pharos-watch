import { unixNowSec } from "@shared/lib/time-constants";
import { isYieldBenchmarkFixingEffective, YIELD_BENCHMARK_RECORD_MAX_AGE_SEC } from "@shared/lib/yield-benchmark-freshness";
import { BANXICO_CETES_28D_URL } from "./shared";
import { USER_AGENT } from "../../lib/constants";
import {
  fetchAndParseBenchmark,
  type BenchmarkResponseDiagnostic,
  isValidBenchmarkRate,
  parseRate,
  parseSlashDmyToIso,
} from "./shared";

/**
 * Parse a Banxico SIE response. Shape:
 *   { bmx: { series: [{ datos: [{ fecha: "DD/MM/YYYY", dato: "11.43" }] }] } }
 * Dates use `DD/MM/YYYY` (Banxico) — normalize to ISO `YYYY-MM-DD`.
 */
export function parseBanxicoSeries(json: string, nowSec = unixNowSec()): { recordDate: string; rate: number } | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const bmx = parsed.bmx as Record<string, unknown> | undefined;
    const series = (bmx?.series as Array<Record<string, unknown>> | undefined)?.[0];
    const datos = series?.datos as Array<{ fecha?: unknown; dato?: unknown }> | undefined;
    if (!Array.isArray(datos) || datos.length === 0) return null;
    let latest: { recordDate: string; rate: number } | null = null;
    for (const row of datos) {
      const rate = parseRate(typeof row?.dato === "string" ? row.dato : null);
      const fechaRaw = typeof row?.fecha === "string" ? row.fecha : null;
      if (!fechaRaw || !isValidBenchmarkRate(rate)) continue;
      const recordDate = parseSlashDmyToIso(fechaRaw);
      if (!recordDate || !isYieldBenchmarkFixingEffective("MXN", recordDate, nowSec)) continue;
      if (!latest || recordDate >= latest.recordDate) latest = { rate, recordDate };
    }
    return latest;
  } catch {
    return null;
  }
}

export async function tryBanxicoCetes(
  banxicoToken: string | null,
  signal?: AbortSignal,
  onDiagnostic?: (diagnostic: BenchmarkResponseDiagnostic) => void,
): Promise<{ rate: number; recordDate: string } | null> {
  if (!banxicoToken) return null;
  const nowSec = unixNowSec();
  const startDate = new Date((nowSec - YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.MXN) * 1_000).toISOString().slice(0, 10);
  const endDate = new Date(nowSec * 1_000).toISOString().slice(0, 10);
  return fetchAndParseBenchmark({
    // A short range keeps the last effective result visible when a new placement is advertised early.
    url: `${BANXICO_CETES_28D_URL}/${startDate}/${endDate}`,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Bmx-Token": banxicoToken,
    },
    parse: (json) => parseBanxicoSeries(json, nowSec),
    warnLabel: "Banxico CETES",
    signal,
    onDiagnostic,
  });
}
