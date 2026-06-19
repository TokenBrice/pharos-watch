import {
  CBRT_EVDS_FE_URL,
  CBRT_TLREF_SERIES_CODE,
  USER_AGENT,
} from "../../lib/constants";
import {
  addDays,
  fetchAndParseBenchmark,
  isValidBenchmarkRateForKey,
  parseRate,
  parseSlashDmyToIso,
} from "./shared";

function parseCbrtEvdsDate(dateRaw: string): string | null {
  const trimmed = dateRaw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const slashDmy = parseSlashDmyToIso(trimmed);
  if (slashDmy) return slashDmy;

  const match = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return null;
  // EVDS3 returns this shape as MM-DD-YYYY when dateFormat=1 and lang=en.
  return `${match[3]}-${match[1]}-${match[2]}`;
}

export function parseCbrtEvdsSeries(
  json: string,
  seriesCode = CBRT_TLREF_SERIES_CODE,
): { recordDate: string; rate: number } | null {
  try {
    const parsed = JSON.parse(json) as { items?: Array<Record<string, unknown>> };
    const items = parsed.items;
    if (!Array.isArray(items) || items.length === 0) return null;

    const seriesField = seriesCode.replace(/\./g, "_");
    let latest: { recordDate: string; rate: number } | null = null;
    for (const row of items) {
      const dateRaw = typeof row?.Tarih === "string"
        ? row.Tarih
        : typeof row?.DATE === "string"
          ? row.DATE
          : null;
      const valueRaw = row?.[seriesField];
      const rate = parseRate(
        typeof valueRaw === "string" || typeof valueRaw === "number" ? valueRaw : null,
      );
      const recordDate = dateRaw ? parseCbrtEvdsDate(dateRaw) : null;
      if (!recordDate || !isValidBenchmarkRateForKey("TRY", rate)) continue;
      if (!latest || recordDate > latest.recordDate) {
        latest = { recordDate, rate };
      }
    }
    return latest;
  } catch {
    return null;
  }
}

function formatCbrtEvdsRequestDate(date: Date): string {
  return `${String(date.getUTCDate()).padStart(2, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${date.getUTCFullYear()}`;
}

export async function tryCbrtTlref(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  const now = new Date();
  const body = JSON.stringify({
    type: "json",
    series: CBRT_TLREF_SERIES_CODE,
    aggregationTypes: "avg",
    formulas: "0",
    startDate: formatCbrtEvdsRequestDate(addDays(now, -14)),
    endDate: formatCbrtEvdsRequestDate(now),
    frequency: "2",
    decimalSeperator: ".",
    decimal: "2",
    dateFormat: "1",
    lang: "en",
    yon: "desc",
    sira: "Tarih",
    ozelFormuller: [],
    groupSeperator: true,
    isRaporSayfasi: false,
  });

  return fetchAndParseBenchmark({
    url: CBRT_EVDS_FE_URL,
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Content-Type": "application/json;charset=UTF-8",
      Origin: "https://evds3.tcmb.gov.tr",
      Referer: "https://evds3.tcmb.gov.tr/",
    },
    body,
    parse: (responseBody) => parseCbrtEvdsSeries(responseBody, CBRT_TLREF_SERIES_CODE),
    warnLabel: "CBRT EVDS TLREF",
    signal,
  });
}
