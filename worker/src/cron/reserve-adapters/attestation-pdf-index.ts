import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { ReserveSliceSchema } from "@shared/types/reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decodeHtmlEntities,
  fetchPrimaryHtmlInput,
  fetchTextWithRetry,
  htmlLayoutChangedError,
  normalizeSlices,
  readHtmlAttribute,
  requireHtmlInput,
  stripTags,
  verifiedFreshnessMetadata,
} from "./helpers";
import { buildBrowserHeaders, HTML_ACCEPT_HEADER, NEUTRAL_ADAPTER_HEADERS } from "./request";
import { buildDocumentedRedemptionTelemetry } from "./redemption";
import {
  parseReportDateCandidates,
  type ParsedReportDateCandidate,
  type ReportDateParserEntry,
} from "./report-date";

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

export interface AttestationPdfIndexParams {
  slices: ReserveSlice[];
}

interface AttestationPdfIndexAdaptOptions {
  indexUrl?: string;
}

type ReportDateSource = "href" | "text";

interface ReportDateCandidate extends ParsedReportDateCandidate {
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

  const slices = rawSlices.map((rawSlice, index) => {
    const parsed = ReserveSliceSchema.safeParse(rawSlice);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue && issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
      throw new Error(
        `${ADAPTER_NAME} adapter params invalid.slices[${index}]${path}: ${issue?.message ?? "invalid reserve slice"}`,
      );
    }

    const slice = parsed.data;
    if (!slice.name.trim()) {
      throw new Error(`${ADAPTER_NAME} adapter params invalid.slices[${index}].name: expected a non-empty string`);
    }
    if (slice.coinId != null && !slice.coinId.trim()) {
      throw new Error(`${ADAPTER_NAME} adapter params invalid.slices[${index}].coinId: expected a string`);
    }

    return {
      ...slice,
      name: slice.name.trim(),
      ...(slice.coinId != null ? { coinId: slice.coinId.trim() } : {}),
    };
  });

  const total = slices.reduce((sum, slice) => sum + slice.pct, 0);
  if (Math.abs(total - 100) > 1.5) {
    throw new Error(
      `attestation PDF configured reserve composition sum to ${total.toFixed(1)}% (expected 100% ± 1.5%)`,
    );
  }

  return normalizeSlices(slices);
}

function readParams(config: LiveReservesConfig): AttestationPdfIndexParams {
  return {
    slices: readConfiguredSlices(config.params?.slices),
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

const DAY_DATE_PARSERS: readonly ReportDateParserEntry[] = [
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

const MONTH_DATE_PARSERS: readonly ReportDateParserEntry[] = [
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
  table: readonly ReportDateParserEntry[],
): ReportDateCandidate | null {
  let latest: ReportDateCandidate | null = null;
  for (const candidate of parseReportDateCandidates(value, table)) {
    latest = betterDate(latest, { ...candidate, dateSource: source });
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
