import { BANXICO_CETES_28D_URL, USER_AGENT } from "../../lib/constants";
import {
  fetchAndParseBenchmark,
  isValidBenchmarkRate,
  parseRate,
  parseSlashDmyToIso,
} from "./shared";

/**
 * Parse a Banxico SIE response. Shape:
 *   { bmx: { series: [{ datos: [{ fecha: "DD/MM/YYYY", dato: "11.43" }] }] } }
 * Dates use `DD/MM/YYYY` (Banxico) — normalize to ISO `YYYY-MM-DD`.
 */
export function parseBanxicoSeries(json: string): { recordDate: string; rate: number } | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const bmx = parsed.bmx as Record<string, unknown> | undefined;
    const series = (bmx?.series as Array<Record<string, unknown>> | undefined)?.[0];
    const datos = series?.datos as Array<{ fecha?: unknown; dato?: unknown }> | undefined;
    if (!Array.isArray(datos) || datos.length === 0) return null;
    for (let i = datos.length - 1; i >= 0; i--) {
      const row = datos[i];
      const rate = parseRate(typeof row?.dato === "string" ? row.dato : null);
      const fechaRaw = typeof row?.fecha === "string" ? row.fecha : null;
      if (!fechaRaw || !isValidBenchmarkRate(rate)) continue;
      const recordDate = parseSlashDmyToIso(fechaRaw);
      if (!recordDate) continue;
      return { rate, recordDate };
    }
    return null;
  } catch {
    return null;
  }
}

export async function tryBanxicoCetes(
  banxicoToken: string | null,
  signal?: AbortSignal,
): Promise<{ rate: number; recordDate: string } | null> {
  if (!banxicoToken) return null;
  return fetchAndParseBenchmark({
    url: BANXICO_CETES_28D_URL,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Bmx-Token": banxicoToken,
    },
    parse: parseBanxicoSeries,
    warnLabel: "Banxico CETES",
    signal,
  });
}
