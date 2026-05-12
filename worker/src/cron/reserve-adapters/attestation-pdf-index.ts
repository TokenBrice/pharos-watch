import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import { DEPENDENCY_TYPE_VALUES } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  escapeRegExp,
  fetchPrimaryHtmlInput,
  htmlLayoutChangedError,
  requireHtmlInput,
  slicesFromPercentages,
  verifiedFreshnessMetadata,
  isReserveRisk,
} from "./helpers";
import { buildDocumentedRedemptionTelemetry } from "./redemption";

const ADAPTER_NAME = "attestation-pdf-index";
const COMPOSITION_MODE = "configured-static-slices";
const COMPOSITION_NOTE =
  "Reserve composition is emitted from adapter params; the selected PDF is used for report and freshness metadata only until full PDF parsing is implemented.";

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

const MONTH_LABEL = [
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

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, rawName: string) => {
    const name = rawName.toLowerCase();
    if (name.startsWith("#x")) {
      const codePoint = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    if (name.startsWith("#")) {
      const codePoint = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return HTML_ENTITY_MAP[name] ?? entity;
  });
}

function decodeUrlish(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripTags(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function readHtmlAttribute(tag: string, name: string): string | null {
  const escapedName = escapeRegExp(name);
  // eslint-disable-next-line security/detect-non-literal-regexp -- attribute name is escaped before constructing the bounded matcher.
  const regex = new RegExp(String.raw`\b${escapedName}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`, "i");
  const match = tag.match(regex);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? decodeHtmlEntities(value.trim()) : null;
}

function isPdfHref(href: string): boolean {
  return /\.pdf(?:[?#]|$)/i.test(href);
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

function parseYearMonthDayDates(value: string, source: ReportDateSource): ReportDateCandidate | null {
  const regex = /\b((?:19|20)\d{2})[-_./\s](0?[1-9]|1[0-2])[-_./\s](0?[1-9]|[12]\d|3[01])\b/gi;
  let latest: ReportDateCandidate | null = null;
  for (const match of value.matchAll(regex)) {
    latest = betterDate(latest, buildDayDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]), source));
  }
  return latest;
}

function parseMonthDayYearDates(value: string, source: ReportDateSource): ReportDateCandidate | null {
  const regex =
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?[\s._-]+(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?[,]?[\s._-]+((?:19|20)\d{2})\b/gi;
  let latest: ReportDateCandidate | null = null;
  for (const match of value.matchAll(regex)) {
    const monthIndex = monthIndexFromLabel(match[1] ?? "");
    if (monthIndex == null) continue;
    latest = betterDate(latest, buildDayDate(Number(match[3]), monthIndex, Number(match[2]), source));
  }
  return latest;
}

function parseDayMonthYearDates(value: string, source: ReportDateSource): ReportDateCandidate | null {
  const regex =
    /\b(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?[\s._-]+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?[,]?[\s._-]+((?:19|20)\d{2})\b/gi;
  let latest: ReportDateCandidate | null = null;
  for (const match of value.matchAll(regex)) {
    const monthIndex = monthIndexFromLabel(match[2] ?? "");
    if (monthIndex == null) continue;
    latest = betterDate(latest, buildDayDate(Number(match[3]), monthIndex, Number(match[1]), source));
  }
  return latest;
}

function parseYearMonthNameDates(value: string, source: ReportDateSource): ReportDateCandidate | null {
  const regex =
    /\b((?:19|20)\d{2})[\s._-]+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\b/gi;
  let latest: ReportDateCandidate | null = null;
  for (const match of value.matchAll(regex)) {
    const monthIndex = monthIndexFromLabel(match[2] ?? "");
    if (monthIndex == null) continue;
    latest = betterDate(latest, buildMonthDate(Number(match[1]), monthIndex, source));
  }
  return latest;
}

function parseMonthNameYearDates(value: string, source: ReportDateSource): ReportDateCandidate | null {
  const regex =
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?[\s._-]+((?:19|20)\d{2})\b/gi;
  let latest: ReportDateCandidate | null = null;
  for (const match of value.matchAll(regex)) {
    const monthIndex = monthIndexFromLabel(match[1] ?? "");
    if (monthIndex == null) continue;
    latest = betterDate(latest, buildMonthDate(Number(match[2]), monthIndex, source));
  }
  return latest;
}

function parseYearMonthNumberDates(value: string, source: ReportDateSource): ReportDateCandidate | null {
  const regex = /\b((?:19|20)\d{2})[-_./](0?[1-9]|1[0-2])\b(?![-_./]\d{1,2})/gi;
  let latest: ReportDateCandidate | null = null;
  for (const match of value.matchAll(regex)) {
    latest = betterDate(latest, buildMonthDate(Number(match[1]), Number(match[2]) - 1, source));
  }
  return latest;
}

function parseBestReportDate(value: string, source: ReportDateSource): ReportDateCandidate | null {
  const normalized = decodeUrlish(value).replace(/\+/g, " ");
  const latestDayDate = [
    parseYearMonthDayDates(normalized, source),
    parseMonthDayYearDates(normalized, source),
    parseDayMonthYearDates(normalized, source),
  ].reduce<ReportDateCandidate | null>((latest, candidate) => betterDate(latest, candidate), null);
  if (latestDayDate) {
    return latestDayDate;
  }

  return [
    parseYearMonthNameDates(normalized, source),
    parseMonthNameYearDates(normalized, source),
    parseYearMonthNumberDates(normalized, source),
  ].reduce<ReportDateCandidate | null>((latest, candidate) => betterDate(latest, candidate), null);
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
  const html = await fetchPrimaryHtmlInput(config, ADAPTER_NAME, signal, ctx);
  return adaptAttestationPdfIndex(html, readParams(config), { indexUrl: input.url });
}
