import { RBA_F1_MONEY_MARKET_CSV_URL, USER_AGENT } from "../../lib/constants";
import {
  fetchAndParseBenchmark,
  isValidBenchmarkRate,
  parseEnglishDate,
  parseRate,
  type BenchmarkFetchResult,
} from "./shared";

export function parseRbaF1MoneyMarketCsv(csv: string): BenchmarkFetchResult | null {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !/^\d{2}-[A-Za-z]{3}-\d{4},/.test(line)) continue;
    const columns = line.split(",");
    const recordDate = parseEnglishDate((columns[0] ?? "").replace(/-/g, " "));
    const cashRateTarget = parseRate(columns[1]);
    const interbankOvernightRate = parseRate(columns[3]);
    const usesTarget = isValidBenchmarkRate(cashRateTarget);
    const rate = usesTarget ? cashRateTarget : interbankOvernightRate;
    if (!recordDate || !isValidBenchmarkRate(rate)) continue;
    return {
      recordDate,
      rate,
      source: usesTarget ? "rba-cash-rate-target" : "rba-interbank-overnight",
    };
  }
  return null;
}

export async function tryRbaCashRateTarget(signal?: AbortSignal): Promise<BenchmarkFetchResult | null> {
  return fetchAndParseBenchmark({
    url: RBA_F1_MONEY_MARKET_CSV_URL,
    headers: { "User-Agent": USER_AGENT },
    parse: parseRbaF1MoneyMarketCsv,
    warnLabel: "RBA F1 money-market CSV",
    signal,
  });
}
