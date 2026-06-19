import { TREASURY_YIELD_XML_URL, USER_AGENT } from "../../lib/constants";
import { fetchAndParseBenchmark, isValidBenchmarkRate } from "./shared";

/** Parse the latest 3-month yield from Treasury.gov yield curve XML. */
export function parseTreasuryYieldXml(xml: string): { recordDate: string; rate: number } | null {
  const blockPattern =
    /<G_NEW_DATE>[\s\S]*?<BC_3MONTH>([\d.]+)<\/BC_3MONTH>[\s\S]*?<NEW_DATE>([\d/-]+)<\/NEW_DATE>[\s\S]*?<\/G_NEW_DATE>/g;
  let lastRate: number | null = null;
  let lastDateRaw: string | null = null;

  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(xml)) !== null) {
    const rate = parseFloat(match[1]);
    if (isValidBenchmarkRate(rate)) {
      lastRate = rate;
      lastDateRaw = match[2];
    }
  }

  if (lastRate == null || lastDateRaw == null) return null;

  const parts = lastDateRaw.split("-");
  if (parts.length !== 3) return null;
  const recordDate = `${parts[2]}-${parts[0]}-${parts[1]}`;

  return { recordDate, rate: lastRate };
}

export async function tryTreasuryXml(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: TREASURY_YIELD_XML_URL,
    headers: { "User-Agent": USER_AGENT },
    retries: 1,
    parse: parseTreasuryYieldXml,
    warnLabel: "Treasury XML",
    signal,
  });
}
