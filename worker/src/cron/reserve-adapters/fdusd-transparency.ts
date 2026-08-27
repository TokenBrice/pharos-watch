import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decodeHtmlEntities,
  fetchPrimaryHtmlInput,
  freshnessMetadataFromTimestamp,
  htmlLayoutChangedError,
  parseTimestampLikeToUnixSeconds,
  slicesFromValues,
} from "./helpers";
import { fetchBinaryWithRetry } from "./request";
import { buildDocumentedRedemptionTelemetry } from "./redemption";

const ADAPTER_NAME = "fdusd-transparency";

const FDUSD_LABEL_MAP: Record<string, string> = {
  "US Treasury Bills": "U.S. Treasury Bills",
  "Treasury Bills": "U.S. Treasury Bills",
  Cash: "Cash",
  "Bank Deposits": "Bank Deposits",
  "Fixed Deposit": "Fixed Deposit",
  "Fixed Deposits": "Fixed Deposit",
  "Reverse Repos": "Overnight Reverse Repos",
};

interface FdusdReportLink {
  href: string;
  reportPeriod: string;
  sortTimestamp: number;
}

function monthTimestamp(label: string): number | null {
  const timestamp = Date.parse(`1 ${label} UTC`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function selectNewestFdusdSignedReport(html: string): FdusdReportLink {
  const reports: FdusdReportLink[] = [];
  const itemRegex =
    /<div role="listitem" class="transparency-report_item[^\"]*">\s*<div>\s*([^<]+?)\s*<\/div>\s*<a\b[^>]*href="([^"]+\.pdf)"/gi;

  for (const match of html.matchAll(itemRegex)) {
    const reportPeriod = decodeHtmlEntities(match[1] ?? "").trim();
    const href = decodeHtmlEntities(match[2] ?? "").trim();
    let decodedHref: string;
    try {
      decodedHref = decodeURIComponent(href);
    } catch {
      continue;
    }
    const sortTimestamp = monthTimestamp(reportPeriod);
    const isLegacySignedReport =
      /FDUSD[ _]+Reserve[ _]+accounts?[ _]+Report/i.test(decodedHref)
      && /(?:signed|final)/i.test(decodedHref);
    const isIsae3000ReserveReport =
      /ISAE[ _-]*3000[\s\S]*Attestation[ _]+Report[\s\S]*Reserve(?:s)?[ _]+Accounts?/i.test(decodedHref);
    if (
      sortTimestamp != null
      && (isLegacySignedReport || isIsae3000ReserveReport)
    ) {
      reports.push({ href, reportPeriod, sortTimestamp });
    }
  }

  reports.sort((left, right) => right.sortTimestamp - left.sortTimestamp);
  if (!reports[0]) {
    throw htmlLayoutChangedError(ADAPTER_NAME, "no dated signed FDUSD reserve-account report links found in HTML");
  }
  return reports[0];
}

function parseUsdAmount(raw: string): number {
  const value = Number(raw.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(value) || value <= 0) {
    throw htmlLayoutChangedError(ADAPTER_NAME, `invalid reserve-report amount: ${raw}`);
  }
  return value;
}

function parseCompactIsae3000Composition(normalized: string): {
  entries: Array<{ name: string; value: number }>;
  totalReserveUsd: number;
} | null {
  const compact = normalized.replace(/\s+/g, "");
  // eslint-disable-next-line security/detect-unsafe-regex -- fixed ISAE3000 aggregate label followed by one bounded-format monetary token in the compact report view.
  const treasuryMatch = compact.match(/\(A\)Sub-total:(?:US)?\$?([\d,]+(?:\.\d{2})?)/i);
  // eslint-disable-next-line security/detect-unsafe-regex -- fixed ISAE3000 aggregate label followed by one bounded-format monetary token in the compact report view.
  const fixedDepositMatch = compact.match(/\(B\)Sub-total:(?:US)?\$?([\d,]+(?:\.\d{2})?)/i);
  // eslint-disable-next-line security/detect-unsafe-regex -- fixed ISAE3000 custody label followed by one bounded-format monetary token in the compact report view.
  const cashMatch = compact.match(/\(C\)(?:US)?\$heldincustodyaccounts:(?:US)?\$?([\d,]+(?:\.\d{2})?)/i);
  const totalMatch = compact.match(
    // eslint-disable-next-line security/detect-unsafe-regex -- fixed ISAE3000 total label followed by one bounded-format monetary token in the compact report view.
    /\(A\)\+\(B\)\+\(C\)TotalassetsheldinReserveAccounts:(?:US)?\$?([\d,]+(?:\.\d{2})?)/i,
  );
  if (!treasuryMatch?.[1] || !fixedDepositMatch?.[1] || !cashMatch?.[1] || !totalMatch?.[1]) {
    return null;
  }

  return {
    entries: [
      { name: "U.S. Treasury Bills", value: parseUsdAmount(treasuryMatch[1]) },
      { name: "Cash", value: parseUsdAmount(cashMatch[1]) },
      { name: "Fixed Deposit", value: parseUsdAmount(fixedDepositMatch[1]) },
    ],
    totalReserveUsd: parseUsdAmount(totalMatch[1]),
  };
}

export function adaptFdusdReserveReport(reportText: string, reportUrl?: string): AdapterResult {
  const normalized = reportText.replace(/\s+/g, " ").trim();
  const legacyDateMatch = normalized.match(
    // eslint-disable-next-line security/detect-unsafe-regex -- runs on whitespace-collapsed report text, so the single-space word matcher cannot backtrack ambiguously.
    /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})\s+at\s+\d{1,2}:\d{2}\s*(?:am|pm)?(?:\s[A-Za-z]+)*/i,
  );
  const compactDateMatch = normalized.replace(/\s+/g, "").match(
    /(?:As)?of(\d{1,2})(January|February|March|April|May|June|July|August|September|October|November|December)(\d{4})at\d{1,2}:\d{2}(?:am|pm)/i,
  );
  const asOf = legacyDateMatch?.[1]
    ?? (compactDateMatch
      ? `${compactDateMatch[2]} ${compactDateMatch[1]}, ${compactDateMatch[3]}`
      : null);
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(asOf);
  if (!asOf || sourceTimestamp == null) {
    throw htmlLayoutChangedError(ADAPTER_NAME, "signed reserve report did not expose a parseable report-period date");
  }

  const holdingsStart = normalized.search(/comprised of the following asset holdings/i);
  // eslint-disable-next-line security/detect-unsafe-regex -- runs on whitespace-collapsed report text, so the adjacent \s quantifiers cannot backtrack ambiguously.
  const totalMatch = normalized.match(/Total Reserve Accounts\s+(?:US)?\$?\s*([\d,]+(?:\.\d{2})?)/i);
  const entries: Array<{ name: string; value: number }> = [];
  let totalReserveUsd: number | null = null;
  if (holdingsStart >= 0 && totalMatch?.[1]) {
    const totalOffset = totalMatch.index ?? -1;
    if (totalOffset <= holdingsStart) {
      throw htmlLayoutChangedError(ADAPTER_NAME, "signed reserve report holdings table was incomplete");
    }

    const holdings = normalized.slice(holdingsStart, totalOffset);
    const entryRegex =
      // eslint-disable-next-line security/detect-unsafe-regex -- fixed label alternation plus a lazy 180-char bounded gap over the adapter's own report text; no unbounded backtracking path.
      /(US Treasury Bills|Treasury Bills|Cash|Bank Deposits|Fixed Deposits?|Reverse Repos)[\s\S]{0,180}?(?:US)?\$\s*([\d,]+(?:\.\d{2})?)/gi;
    for (const match of holdings.matchAll(entryRegex)) {
      const rawName = match[1];
      const rawValue = match[2];
      if (!rawName || !rawValue) continue;
      const name = FDUSD_LABEL_MAP[rawName] ?? rawName;
      const value = parseUsdAmount(rawValue);
      const existing = entries.find((entry) => entry.name === name);
      if (existing) existing.value += value;
      else entries.push({ name, value });
    }
    totalReserveUsd = parseUsdAmount(totalMatch[1]);
  }

  if (entries.length === 0 || totalReserveUsd == null) {
    const compactComposition = parseCompactIsae3000Composition(normalized);
    if (!compactComposition) {
      throw htmlLayoutChangedError(ADAPTER_NAME, "signed reserve report did not expose its holdings table and total");
    }
    entries.push(...compactComposition.entries);
    totalReserveUsd = compactComposition.totalReserveUsd;
  }

  const compositionTotal = entries.reduce((sum, entry) => sum + entry.value, 0);
  if (Math.abs(compositionTotal - totalReserveUsd) > 0.01) {
    throw htmlLayoutChangedError(
      ADAPTER_NAME,
      `signed reserve report composition ${compositionTotal} did not reconcile to total ${totalReserveUsd}`,
    );
  }

  return {
    slices: slicesFromValues(
      entries.map((entry) => ({ ...entry, risk: "very-low" as const })),
    ),
    metadata: {
      sliceCount: entries.length,
      asOf,
      totalReserveUsd,
      ...(reportUrl ? { reportUrl } : {}),
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "signed-reserve-report",
        "FDUSD signed reserve report did not expose a parseable report-period timestamp",
      ),
      redemption: buildDocumentedRedemptionTelemetry(sourceTimestamp),
    },
  };
}

function decodePdfLiteral(raw: string): string {
  return raw.replace(/\\([0-7]{1,3}|[nrtbf()\\])/g, (_match, escaped: string) => {
    if (/^[0-7]/.test(escaped)) return String.fromCharCode(Number.parseInt(escaped, 8));
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[escaped] ?? escaped;
  });
}

function decodePdfHex(raw: string, unicodeMap: Map<string, string>): string {
  const compact = raw.replace(/\s+/g, "").toUpperCase();
  let mapped = "";
  for (let offset = 0; offset < compact.length;) {
    const width = unicodeMap.has(compact.slice(offset, offset + 4)) ? 4 : 2;
    const code = compact.slice(offset, offset + width);
    mapped += unicodeMap.get(code) ?? String.fromCharCode(Number.parseInt(code, 16));
    offset += width;
  }
  return mapped;
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const decoder = new TextDecoder("latin1");
  const raw = decoder.decode(bytes);
  if (!raw.startsWith("%PDF-")) return new TextDecoder().decode(bytes);

  const streams: string[] = [];
  const streamRegex = /stream\r?\n/g;
  for (const match of raw.matchAll(streamRegex)) {
    const start = (match.index ?? 0) + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    const dictionaryStart = raw.lastIndexOf("<<", match.index);
    const dictionary = raw.slice(Math.max(0, dictionaryStart), match.index);
    let streamEnd = end;
    if (raw[streamEnd - 1] === "\n") streamEnd -= 1;
    if (raw[streamEnd - 1] === "\r") streamEnd -= 1;
    let streamBytes = bytes.slice(start, streamEnd);
    if (/\/FlateDecode/.test(dictionary)) {
      try {
        const decompressed = new Response(
          new Blob([streamBytes]).stream().pipeThrough(new DecompressionStream("deflate")),
        );
        streamBytes = new Uint8Array(await decompressed.arrayBuffer());
      } catch {
        continue;
      }
    } else if (/\/Filter\b/.test(dictionary)) {
      continue;
    }
    streams.push(decoder.decode(streamBytes));
  }

  const unicodeMap = new Map<string, string>();
  for (const stream of streams) {
    if (!/beginbf(?:char|range)/.test(stream)) continue;
    for (const match of stream.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const source = match[1]?.toUpperCase();
      const destination = match[2];
      if (!source || !destination || destination.length % 4 !== 0) continue;
      let value = "";
      for (let offset = 0; offset < destination.length; offset += 4) {
        value += String.fromCharCode(Number.parseInt(destination.slice(offset, offset + 4), 16));
      }
      unicodeMap.set(source, value);
    }
    for (const match of stream.matchAll(/<([0-9A-Fa-f]+)>[ \t]+<([0-9A-Fa-f]+)>[ \t]+<([0-9A-Fa-f]+)>/g)) {
      const startCode = Number.parseInt(match[1] ?? "", 16);
      const endCode = Number.parseInt(match[2] ?? "", 16);
      const destination = Number.parseInt(match[3] ?? "", 16);
      const width = match[1]?.length ?? 0;
      if (!Number.isFinite(startCode) || !Number.isFinite(endCode) || !Number.isFinite(destination) || width === 0) continue;
      for (let code = startCode; code <= endCode; code += 1) {
        unicodeMap.set(code.toString(16).toUpperCase().padStart(width, "0"), String.fromCharCode(destination + code - startCode));
      }
    }
  }

  const text: string[] = [];
  for (const stream of streams) {
    if (!/\bBT\b[\s\S]*\bET\b/.test(stream)) continue;
    for (const match of stream.matchAll(/\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]+)>/g)) {
      const value = match[1] != null
        ? decodePdfLiteral(match[1])
        : decodePdfHex(match[2] ?? "", unicodeMap);
      if (value.trim()) text.push(value);
    }
  }
  if (text.length === 0) {
    throw htmlLayoutChangedError(ADAPTER_NAME, "signed reserve PDF did not expose extractable text");
  }
  return text.join(" ");
}

async function fetchFdusdReportText(
  url: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<string> {
  const body = await fetchBinaryWithRetry(url, signal, 15_000, ctx, {
    headers: { Accept: "application/pdf" },
  });
  return extractPdfText(body);
}

export async function fetchFdusdTransparencyReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const html = await fetchPrimaryHtmlInput(config, ADAPTER_NAME, signal, ctx);
  const report = selectNewestFdusdSignedReport(html);
  const primaryUrl = config.inputs.primary.kind === "http-html" ? config.inputs.primary.url : "";
  const reportUrl = new URL(report.href, primaryUrl).toString();
  const reportText = await fetchFdusdReportText(reportUrl, signal, ctx);
  return adaptFdusdReserveReport(reportText, reportUrl);
}
