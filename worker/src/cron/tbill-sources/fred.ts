import { USER_AGENT } from "../../lib/constants";
import {
  fetchAndParseBenchmark,
  isValidBenchmarkRate,
  parseRate,
} from "./shared";

export function parseFredLatest(csv: string): { recordDate: string; rate: number } | null {
  const lines = csv.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const [recordDate, rateRaw] = line.split(",");
    if (!recordDate || !rateRaw) continue;
    const rate = parseRate(rateRaw);
    if (!isValidBenchmarkRate(rate)) continue;
    return { recordDate, rate };
  }
  return null;
}

export async function tryFredCsv(
  url: string,
  signal?: AbortSignal,
): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url,
    headers: { "User-Agent": USER_AGENT },
    parse: parseFredLatest,
    warnLabel: "FRED CSV",
    signal,
  });
}
