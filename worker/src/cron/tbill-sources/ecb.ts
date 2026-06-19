import { ECB_ESTR_3M_CSV_URL, USER_AGENT } from "../../lib/constants";
import {
  fetchAndParseBenchmark,
  isValidBenchmarkRate,
  parseRate,
} from "./shared";

export function parseEcbCompoundedEstrCsv(csv: string): { recordDate: string; rate: number } | null {
  const lines = csv.split(/\r?\n/);
  const header = lines.find((line) => line.trim().length > 0);
  if (!header) return null;

  const headers = header.split(",").map((value) => value.trim());
  const dateIndex = headers.indexOf("TIME_PERIOD");
  const rateIndex = headers.indexOf("OBS_VALUE");
  if (dateIndex === -1 || rateIndex === -1) return null;

  const headerIndex = lines.indexOf(header);
  for (let i = lines.length - 1; i > headerIndex; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;

    const columns = line.split(",");
    const recordDate = columns[dateIndex]?.trim();
    const rate = parseRate(columns[rateIndex]?.trim());
    if (!recordDate || !isValidBenchmarkRate(rate)) continue;

    return { recordDate, rate };
  }

  return null;
}

export async function tryEcbCompoundedEstrCsv(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: ECB_ESTR_3M_CSV_URL,
    headers: { "User-Agent": USER_AGENT },
    parse: parseEcbCompoundedEstrCsv,
    warnLabel: "ECB 3M compounded €STR CSV",
    signal,
  });
}
