import { RBA_F1_MONEY_MARKET_CSV_URL, USER_AGENT } from "../../lib/constants";
import {
  fetchAndParseBenchmark,
  isValidBenchmarkRate,
  parseEnglishDate,
  parseRate,
} from "./shared";

export function parseRbaF1MoneyMarketCsv(csv: string): { recordDate: string; rate: number } | null {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !/^\d{2}-[A-Za-z]{3}-\d{4},/.test(line)) continue;
    const columns = line.split(",");
    const recordDate = parseEnglishDate((columns[0] ?? "").replace(/-/g, " "));
    const cashRateTarget = parseRate(columns[1]);
    const interbankOvernightRate = parseRate(columns[3]);
    const rate = isValidBenchmarkRate(cashRateTarget) ? cashRateTarget : interbankOvernightRate;
    if (!recordDate || !isValidBenchmarkRate(rate)) continue;
    return { recordDate, rate };
  }
  return null;
}

export async function tryRbaCashRateTarget(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: RBA_F1_MONEY_MARKET_CSV_URL,
    headers: { "User-Agent": USER_AGENT },
    parse: parseRbaF1MoneyMarketCsv,
    warnLabel: "RBA F1 money-market CSV",
    signal,
  });
}
