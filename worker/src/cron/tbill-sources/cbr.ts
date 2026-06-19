import { CBR_DAILY_INFO_SOAP_URL, USER_AGENT } from "../../lib/constants";
import {
  addDays,
  fetchAndParseBenchmark,
  isValidBenchmarkRateForKey,
  parseRate,
} from "./shared";

export function parseCbrKeyRateXml(xml: string): { recordDate: string; rate: number } | null {
  const rows = xml.match(/<KR\b[\s\S]*?<\/KR>/gu) ?? [];
  let latest: { recordDate: string; rate: number } | null = null;

  for (const row of rows) {
    const dt = row.match(/<DT>([^<]+)<\/DT>/u)?.[1]?.trim() ?? null;
    const rateRaw = row.match(/<Rate>([^<]+)<\/Rate>/u)?.[1]?.trim() ?? null;
    const recordDate = dt?.match(/^(\d{4}-\d{2}-\d{2})/u)?.[1] ?? null;
    const rate = parseRate(rateRaw);
    if (!recordDate || !isValidBenchmarkRateForKey("RUB", rate)) continue;
    if (!latest || recordDate > latest.recordDate) {
      latest = { recordDate, rate };
    }
  }

  return latest;
}

function formatCbrSoapDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}T00:00:00`;
}

function buildCbrKeyRateSoapBody(now = new Date()): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
    "<soap:Body>",
    '<KeyRateXML xmlns="http://web.cbr.ru/">',
    `<fromDate>${formatCbrSoapDate(addDays(now, -14))}</fromDate>`,
    `<ToDate>${formatCbrSoapDate(now)}</ToDate>`,
    "</KeyRateXML>",
    "</soap:Body>",
    "</soap:Envelope>",
  ].join("");
}

export async function tryCbrKeyRate(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: CBR_DAILY_INFO_SOAP_URL,
    method: "POST",
    body: buildCbrKeyRateSoapBody(),
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/xml",
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: '"http://web.cbr.ru/KeyRateXML"',
    },
    parse: parseCbrKeyRateXml,
    warnLabel: "CBR key rate",
    signal,
  });
}
