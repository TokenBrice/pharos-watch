import { isRecord } from "@shared/lib/type-guards";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import { DEPENDENCY_TYPE_VALUES } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decodeHtmlEntities,
  fetchPrimaryHtmlInput,
  fetchTextWithRetry,
  htmlLayoutChangedError,
  readHtmlAttribute,
  requireHtmlInput,
  slicesFromPercentages,
  stripTags,
  verifiedFreshnessMetadata,
  isReserveRisk,
} from "./helpers";
import { buildBrowserHeaders, HTML_ACCEPT_HEADER, NEUTRAL_ADAPTER_HEADERS } from "./request";
import { buildDocumentedRedemptionTelemetry } from "./redemption";

const ADAPTER_NAME = "attestation-pdf-index";
const COMPOSITION_MODE = "configured-static-slices";
const COMPOSITION_NOTE =
  "Reserve composition is emitted from adapter params; the selected PDF is used for report and freshness metadata only until full PDF parsing is implemented.";
const NEUTRAL_FIRST_HTML_HOSTS = new Set(["schuman.io", "www.schuman.io"]);

function shouldUseNeutralHtmlHeadersFirst(url: string): boolean {
  try {
    return NEUTRAL_FIRST_HTML_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function buildBrowserHtmlHeaders(url: string): HeadersInit {
  return {
    Accept: HTML_ACCEPT_HEADER,
    ...buildBrowserHeaders(new URL(url).origin, url),
  };
}

function buildNeutralHtmlHeaders(): HeadersInit {
  return {
    Accept: HTML_ACCEPT_HEADER,
    ...NEUTRAL_ADAPTER_HEADERS,
  };
}

async function fetchAttestationIndexHtml(
  config: LiveReservesConfig,
  inputUrl: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<string> {
  if (shouldUseNeutralHtmlHeadersFirst(inputUrl)) {
    return fetchTextWithRetry(inputUrl, signal, 15_000, ctx, { headers: buildNeutralHtmlHeaders() });
  }

  try {
    return await fetchPrimaryHtmlInput(
      config,
      ADAPTER_NAME,
      signal,
      ctx,
      15_000,
      { headers: buildBrowserHtmlHeaders(inputUrl) },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    return fetchTextWithRetry(inputUrl, signal, 15_000, ctx, { headers: buildNeutralHtmlHeaders() });
  }
}

// Full-name month index for adapters that encounter full lowercase month names (e.g. "january").
export const MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

const MONTH_INDEX_BY_PREFIX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export const MONTH_LABEL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export interface AttestationPdfIndexParams {
  slices: ReserveSlice[];
}

interface AttestationPdfIndexAdaptOptions {
  indexUrl?: string;
}

type ReportDatePrecision = "day" | "month";
type ReportDateSource = "href" | "text";

interface ReportDateCandidate {
  sourceTimestamp: number;
  reportDate: string;
  reportDateLabel: string;
  reportDatePrecision: ReportDatePrecision;
  reportPeriod?: string;
  dateSource: ReportDateSource;
}

interface PdfLinkCandidate {
  href: string;
  text: string;
  date: ReportDateCandidate;
}

function decodeUrlish(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isPdfHref(href: string): boolean {
  return /\.pdf(?:[?#]|$)/i.test(href);
}

function isAttestationReportLink(href: string, text: string): boolean {
  const normalized = decodeUrlish(`${href} ${text}`)
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
  if (/(?:^| )whitepapers?(?: |$)/.test(normalized)) {
    return false;
  }
  return /(?:^| )(?:attestations?|audits?|reports?)(?: |$)/.test(normalized);
}

function readConfiguredSlices(rawSlices: unknown): ReserveSlice[] {
  if (!Array.isArray(rawSlices) || rawSlices.length === 0) {
    throw new Error(`${ADAPTER_NAME} adapter params invalid.slices: expected a non-empty array`);
  }

  return slicesFromPercentages(
    rawSlices.map((rawSlice, index) => {
      if (!isRecord(rawSlice)) {
        throw new Error(`${ADAPTER_NAME} adapter params invalid.slices[${index}]: expected an object`);
      }

      const name = rawSlice.name;
      if (typeof name !== "string" || !name.trim()) {
        throw new Error(`${ADAPTER_NAME} adapter params invalid.slices[${index}].name: expected a non-empty string`);
      }

      const pct = rawSlice.pct;
      if (typeof pct !== "number" || !Number.isFinite(pct) || pct <= 0) {
        throw new Error(`${ADAPTER_NAME} adapter params invalid.slices[${index}].pct: expected a positive number`);
      }

      const risk = rawSlice.risk;
      if (!isReserveRisk(risk)) {
        throw new Error(`${ADAPTER_NAME} adapter params invalid.slices[${index}].risk: expected a reserve risk`);
      }

      const coinId = rawSlice.coinId;
      if (coinId != null && (typeof coinId !== "string" || !coinId.trim())) {
        throw new Error(`${ADAPTER_NAME} adapter params invalid.slices[${index}].coinId: expected a string`);
      }

      const depType = rawSlice.depType;
      if (
        depType != null &&
        (typeof depType !== "string" || !(DEPENDENCY_TYPE_VALUES as readonly string[]).includes(depType))
      ) {
        throw new Error(`${ADAPTER_NAME} adapter params invalid.slices[${index}].depType: expected a dependency type`);
      }

      const blacklistable = rawSlice.blacklistable;
      if (blacklistable != null && typeof blacklistable !== "boolean") {
        throw new Error(`${ADAPTER_NAME} adapter params invalid.slices[${index}].blacklistable: expected a boolean`);
      }

      return {
        name: name.trim(),
        pct,
        risk,
        ...(typeof coinId === "string" ? { coinId: coinId.trim() } : {}),
        ...(typeof depType === "string" ? { depType: depType as ReserveSlice["depType"] } : {}),
        ...(typeof blacklistable === "boolean" ? { blacklistable } : {}),
      };
    }),
    { context: "attestation PDF configured reserve composition" },
  );
}

function readParams(config: LiveReservesConfig): AttestationPdfIndexParams {
  return {
    slices: readConfiguredSlices(config.params?.slices),
  };
}

function monthIndexFromLabel(rawMonth: string): number | null {
  const key = rawMonth
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .slice(0, 3);
  return MONTH_INDEX_BY_PREFIX[key] ?? null;
}

function formatIsoDate(year: number, monthIndex: number, day: number): string {
  return [String(year).padStart(4, "0"), String(monthIndex + 1).padStart(2, "0"), String(day).padStart(2, "0")].join(
    "-",
  );
}

function buildDayDate(
  year: number,
  monthIndex: number,
  day: number,
  source: ReportDateSource,
): ReportDateCandidate | null {
  const timestampMs = Date.UTC(year, monthIndex, day);
  const date = new Date(timestampMs);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== monthIndex || date.getUTCDate() !== day) {
    return null;
  }

  return {
    sourceTimestamp: Math.floor(timestampMs / 1000),
    reportDate: formatIsoDate(year, monthIndex, day),
    reportDateLabel: `${MONTH_LABEL[monthIndex]} ${day}, ${year}`,
    reportDatePrecision: "day",
    dateSource: source,
  };
}

function buildMonthDate(year: number, monthIndex: number, source: ReportDateSource): ReportDateCandidate | null {
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return null;
  }

  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return {
    sourceTimestamp: Date.UTC(year, monthIndex, lastDay) / 1000,
    reportDate: formatIsoDate(year, monthIndex, lastDay),
    reportDateLabel: `${MONTH_LABEL[monthIndex]} ${lastDay}, ${year}`,
    reportDatePrecision: "month",
    reportPeriod: `${MONTH_LABEL[monthIndex]} ${year}`,
    dateSource: source,
  };
}

function betterDate(
  current: ReportDateCandidate | null,
  candidate: ReportDateCandidate | null,
): ReportDateCandidate | null {
  if (!candidate) return current;
  if (!current) return candidate;
  if (candidate.sourceTimestamp > current.sourceTimestamp) return candidate;
  if (
    candidate.sourceTimestamp === current.sourceTimestamp &&
    candidate.reportDatePrecision === "day" &&
    current.reportDatePrecision === "month"
  ) {
    return candidate;
  }
  return current;
}

const MONTH_NAME_PATTERN =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

type DateParserEntry =
  | { kind: "day"; regex: RegExp; year: number; month: number; day: number; monthIsName?: boolean }
  | { kind: "month"; regex: RegExp; year: number; month: number; monthIsName?: boolean };

const DAY_DATE_PARSERS: readonly DateParserEntry[] = [
  // YYYY-MM-DD (and variants)
  {
    kind: "day",
    regex: /\b((?:19|20)\d{2})[-_./\s](0?[1-9]|1[0-2])[-_./\s](0?[1-9]|[12]\d|3[01])\b/gi,
    year: 1,
    month: 2,
    day: 3,
  },
  // DD-MM-YYYY / DD_MM_YY and variants common in PDF filenames.
  {
    kind: "day",
    regex: /(?<![A-Za-z0-9])(0?[1-9]|[12]\d|3[01])[-_./\s](0?[1-9]|1[0-2])[-_./\s]((?:19|20)?\d{2})(?![A-Za-z0-9])/gi,
    year: 3,
    month: 2,
    day: 1,
  },
  // Month DD, YYYY
  {
    kind: "day",
    // eslint-disable-next-line security/detect-non-literal-regexp -- pattern fragment is a static constant.
    regex: new RegExp(
      String.raw`\b(${MONTH_NAME_PATTERN})\.?[\s._-]+(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?[,]?[\s._-]+((?:19|20)\d{2})\b`,
      "gi",
    ),
    year: 3,
    month: 1,
    day: 2,
    monthIsName: true,
  },
  // DD Month YYYY
  {
    kind: "day",
    // eslint-disable-next-line security/detect-non-literal-regexp -- pattern fragment is a static constant.
    regex: new RegExp(
      String.raw`\b(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?[\s._-]+(${MONTH_NAME_PATTERN})\.?[,]?[\s._-]+((?:19|20)\d{2})\b`,
      "gi",
    ),
    year: 3,
    month: 2,
    day: 1,
    monthIsName: true,
  },
];

const MONTH_DATE_PARSERS: readonly DateParserEntry[] = [
  // YYYY Month
  {
    kind: "month",
    // eslint-disable-next-line security/detect-non-literal-regexp -- pattern fragment is a static constant.
    regex: new RegExp(String.raw`\b((?:19|20)\d{2})[\s._-]+(${MONTH_NAME_PATTERN})\.?\b`, "gi"),
    year: 1,
    month: 2,
    monthIsName: true,
  },
  // Month YYYY
  {
    kind: "month",
    // eslint-disable-next-line security/detect-non-literal-regexp -- pattern fragment is a static constant.
    regex: new RegExp(String.raw`\b(${MONTH_NAME_PATTERN})\.?[\s._-]+((?:19|20)\d{2})\b`, "gi"),
    year: 2,
    month: 1,
    monthIsName: true,
  },
  // YYYY-MM (without a trailing day component)
  {
    kind: "month",
    regex: /\b((?:19|20)\d{2})[-_./](0?[1-9]|1[0-2])\b(?![-_./]\d{1,2})/gi,
    year: 1,
    month: 2,
  },
];

function parseAllDates(
  value: string,
  source: ReportDateSource,
  table: readonly DateParserEntry[],
): ReportDateCandidate | null {
  let latest: ReportDateCandidate | null = null;
  for (const entry of table) {
    for (const match of value.matchAll(entry.regex)) {
      const monthRaw = match[entry.month] ?? "";
      const monthIndex = entry.monthIsName ? monthIndexFromLabel(monthRaw) : Number(monthRaw) - 1;
      if (monthIndex == null || Number.isNaN(monthIndex)) continue;
      const yearRaw = match[entry.year] ?? "";
      const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
      const candidate =
        entry.kind === "day"
          ? buildDayDate(year, monthIndex, Number(match[entry.day]), source)
          : buildMonthDate(year, monthIndex, source);
      latest = betterDate(latest, candidate);
    }
  }
  return latest;
}

function parseBestReportDate(value: string, source: ReportDateSource): ReportDateCandidate | null {
  const normalized = decodeUrlish(value).replace(/\+/g, " ");
  return parseAllDates(normalized, source, DAY_DATE_PARSERS) ?? parseAllDates(normalized, source, MONTH_DATE_PARSERS);
}

function collectPdfLinkCandidates(html: string): PdfLinkCandidate[] {
  const anchorRegex = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  const gatedUrlRegex = /<[^>]+\bdata-gated-url\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  const candidates: PdfLinkCandidate[] = [];

  for (const match of html.matchAll(anchorRegex)) {
    const href = decodeHtmlEntities((match[1] ?? match[2] ?? match[3] ?? "").trim());
    if (!href || !isPdfHref(href)) {
      continue;
    }

    const text = stripTags(match[4] ?? "");
    if (!isAttestationReportLink(href, text)) {
      continue;
    }
    const date = parseBestReportDate(href, "href") ?? parseBestReportDate(text, "text");
    if (!date) {
      continue;
    }

    candidates.push({ href, text, date });
  }

  for (const match of html.matchAll(gatedUrlRegex)) {
    const tag = match[0] ?? "";
    const href = decodeHtmlEntities((match[1] ?? match[2] ?? match[3] ?? "").trim());
    if (!href || !isPdfHref(href)) {
      continue;
    }

    const text = readHtmlAttribute(tag, "data-gated-asset") ?? "";
    if (!isAttestationReportLink(href, text)) {
      continue;
    }
    const date = parseBestReportDate(href, "href") ?? parseBestReportDate(text, "text");
    if (!date) {
      continue;
    }

    candidates.push({ href, text, date });
  }

  return candidates;
}

function findLatestPdfLink(html: string): PdfLinkCandidate | null {
  let latest: PdfLinkCandidate | null = null;
  for (const candidate of collectPdfLinkCandidates(html)) {
    if (!latest || candidate.date.sourceTimestamp > latest.date.sourceTimestamp) {
      latest = candidate;
    }
  }
  return latest;
}

function reportHrefMetadata(href: string, indexUrl: string | undefined): Record<string, string> {
  const metadata: Record<string, string> = {
    reportPdfHref: href,
  };

  try {
    const resolved = new URL(href, indexUrl);
    metadata.reportPdfUrl = resolved.href;
    metadata.reportPdfPath = `${resolved.pathname}${resolved.search}`;
    return metadata;
  } catch {
    const [withoutHash] = href.split("#");
    if (withoutHash) {
      metadata.reportPdfPath = withoutHash;
    }
    return metadata;
  }
}

export function adaptAttestationPdfIndex(
  html: string,
  params: AttestationPdfIndexParams,
  options: AttestationPdfIndexAdaptOptions = {},
): AdapterResult {
  const slices = readConfiguredSlices(params.slices);
  const latest = findLatestPdfLink(html);
  if (!latest) {
    throw htmlLayoutChangedError(ADAPTER_NAME, "no dated PDF attestation/report links found in HTML");
  }

  return {
    slices,
    metadata: {
      ...verifiedFreshnessMetadata(latest.date.sourceTimestamp),
      reportDate: latest.date.reportDate,
      reportDateLabel: latest.date.reportDateLabel,
      reportDatePrecision: latest.date.reportDatePrecision,
      ...(latest.date.reportPeriod ? { reportPeriod: latest.date.reportPeriod } : {}),
      reportDateSource: latest.date.dateSource,
      ...(latest.text ? { reportLinkText: latest.text } : {}),
      ...reportHrefMetadata(latest.href, options.indexUrl),
      compositionMode: COMPOSITION_MODE,
      compositionSource: COMPOSITION_MODE,
      compositionNote: COMPOSITION_NOTE,
      redemption: buildDocumentedRedemptionTelemetry(latest.date.sourceTimestamp),
    },
  };
}

export async function fetchAttestationPdfIndexReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireHtmlInput(config.inputs.primary, ADAPTER_NAME);
  const html = await fetchAttestationIndexHtml(config, input.url, signal, ctx);
  return adaptAttestationPdfIndex(html, readParams(config), { indexUrl: input.url });
}
