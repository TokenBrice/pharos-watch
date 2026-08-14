import {
  getIndependentAssuranceManifest,
  independentAssuranceSourceTimestamp,
  reconcileIndependentAssuranceManifest,
  type IndependentAssuranceManifest,
  type IndependentAssuranceProduct,
  type IndependentAssuranceReconciliationOptions,
} from "@shared/lib/independent-assurance";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { normalizeSlices, readHtmlAttribute, stripTags } from "./helpers";
import { fetchBinaryResponseWithRetry, fetchTextResponseWithRetry } from "./request";
import type { AdapterContext, AdapterResult } from "./types";
import { reserveInfoWarning } from "./warnings";

const MAX_PDF_BYTES = 4 * 1024 * 1024;
const PDF_MAGIC = "%PDF-";

interface AssuranceSliceClassification {
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  assetClass?: ReserveSlice["assetClass"];
  issuerOrObligor?: string;
  riskFactors?: ReserveSlice["riskFactors"];
  liquidityHorizon?: ReserveSlice["liquidityHorizon"];
}

export interface IndependentAssuranceProfile {
  adapterName: string;
  product: IndependentAssuranceProduct;
  profile: string;
  requiredAssetCodes: readonly string[];
  classifications: Readonly<Record<string, AssuranceSliceClassification>>;
  reconciliation?: IndependentAssuranceReconciliationOptions;
  isReportCandidate: (href: string, text: string) => boolean;
}

interface ReportCandidate {
  url: string;
  text: string;
}

interface VerifiedIndependentAssuranceArtifact {
  manifest: IndependentAssuranceManifest;
  sourceTimestamp: number;
  responseUrl: string;
  byteLength: number;
}

function requireHttpsUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`independent-assurance: ${label} is not a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`independent-assurance: ${label} must use HTTPS`);
  }
  return parsed;
}

function assertAllowedHost(value: string, hosts: readonly string[], label: string): URL {
  const parsed = requireHttpsUrl(value, label);
  const normalizedHosts = hosts.map((host) => host.toLowerCase());
  if (!normalizedHosts.includes(parsed.hostname.toLowerCase())) {
    throw new Error(
      `independent-assurance: ${label} host ${parsed.hostname} is not in the reviewed allowlist`,
    );
  }
  return parsed;
}

function normalizeUrl(value: string, base: string): string {
  return new URL(value, base).href;
}

function collectReportCandidates(html: string, indexUrl: string, profile: IndependentAssuranceProfile): ReportCandidate[] {
  const candidates: ReportCandidate[] = [];
  const anchorRegex = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  const gatedUrlRegex = /<[^>]+\bdata-gated-url\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;

  for (const match of html.matchAll(anchorRegex)) {
    const href = match[1] ?? match[2] ?? match[3] ?? "";
    const text = stripTags(match[4] ?? "");
    if (!/\.pdf(?:[?#]|$)/i.test(href) || !profile.isReportCandidate(href, text)) continue;
    candidates.push({ url: normalizeUrl(href, indexUrl), text });
  }
  for (const match of html.matchAll(gatedUrlRegex)) {
    const tag = match[0] ?? "";
    const href = match[1] ?? match[2] ?? match[3] ?? "";
    const text = readHtmlAttribute(tag, "data-gated-asset") ?? "";
    if (!/\.pdf(?:[?#]|$)/i.test(href) || !profile.isReportCandidate(href, text)) continue;
    candidates.push({ url: normalizeUrl(href, indexUrl), text });
  }

  const unique = new Map<string, ReportCandidate>();
  for (const candidate of candidates) {
    unique.set(`${candidate.url}\n${candidate.text}`, candidate);
  }
  return [...unique.values()];
}

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function parseDiscoveryDate(value: string): string | null {
  const decodedValue = decodeURIComponent(value);
  const shortMonthFirst = decodedValue.match(/\b(\d{1,2})[.]([0-9]{1,2})[.]((?:19|20)?\d{2})\b/);
  if (shortMonthFirst) {
    const month = Number(shortMonthFirst[1]);
    const day = Number(shortMonthFirst[2]);
    const year = Number(shortMonthFirst[3].length === 2 ? `20${shortMonthFirst[3]}` : shortMonthFirst[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  const decoded = decodedValue.replace(/[_./]/g, "-");
  const iso = decoded.match(/\b((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;

  const dayFirst = decoded.match(/\b(\d{1,2})-(\d{1,2})-((?:19|20)\d{2})\b/);
  if (dayFirst) return `${dayFirst[3]}-${dayFirst[2].padStart(2, "0")}-${dayFirst[1].padStart(2, "0")}`;

  const namedDay = decoded.match(
    /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+((?:19|20)\d{2})\b/i,
  );
  if (namedDay) {
    const month = MONTHS[namedDay[2].toLowerCase()];
    return `${namedDay[3]}-${String(month).padStart(2, "0")}-${namedDay[1].padStart(2, "0")}`;
  }

  const namedMonth = decoded.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+((?:19|20)\d{2})\b/i,
  );
  if (namedMonth) {
    const month = MONTHS[namedMonth[1].toLowerCase()];
    const lastDay = new Date(Date.UTC(Number(namedMonth[2]), month, 0)).getUTCDate();
    return `${namedMonth[2]}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  }

  return null;
}

async function fetchIndexHtml(
  url: string,
  indexHost: string,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<string> {
  const response = await fetchTextResponseWithRetry(url, signal, 15_000, ctx, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 Pharos reserve verifier",
    },
    maxRetries: 0,
  });
  assertAllowedHost(response.finalUrl, [indexHost], "index response");
  return response.body;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function fetchAndHashPdf(
  manifest: IndependentAssuranceManifest,
  reportHosts: readonly string[],
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<VerifiedIndependentAssuranceArtifact> {
  const response = await fetchBinaryResponseWithRetry(manifest.reportUrl, signal, 15_000, ctx, {
    headers: {
      Accept: "application/pdf,application/octet-stream;q=0.9",
      "User-Agent": "Mozilla/5.0 Pharos reserve verifier",
    },
    maxRetries: 0,
    maxResponseBytes: MAX_PDF_BYTES,
  });

  assertAllowedHost(response.finalUrl, reportHosts, "PDF response");
  const bytes = response.body;
  if (bytes.length !== manifest.reportByteLength) {
    throw new Error(
      `independent-assurance: PDF byte length ${bytes.length} does not match reviewed ${manifest.reportByteLength}`,
    );
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const magic = new TextDecoder().decode(bytes.slice(0, PDF_MAGIC.length));
  if (!contentType.startsWith("application/pdf") && magic !== PDF_MAGIC) {
    throw new Error("independent-assurance: official artifact is not a PDF");
  }

  const sha256 = bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
  if (sha256 !== manifest.reportSha256.toLowerCase()) {
    throw new Error(`independent-assurance: PDF SHA-256 ${sha256} does not match reviewed manifest`);
  }

  return {
    manifest,
    sourceTimestamp: independentAssuranceSourceTimestamp(manifest),
    responseUrl: response.finalUrl,
    byteLength: bytes.length,
  };
}

export async function verifyIndependentAssuranceReport(args: {
  manifest: IndependentAssuranceManifest;
  indexUrl: string;
  indexHost: string;
  reportHosts: readonly string[];
  profile: IndependentAssuranceProfile;
  signal: AbortSignal;
  ctx?: AdapterContext;
}): Promise<VerifiedIndependentAssuranceArtifact> {
  const index = requireHttpsUrl(args.indexUrl, "index URL");
  if (index.hostname.toLowerCase() !== args.indexHost.toLowerCase()) {
    throw new Error(`independent-assurance: index host ${index.hostname} is not reviewed for this profile`);
  }
  assertAllowedHost(args.manifest.reportUrl, args.reportHosts, "reviewed PDF");
  const html = await fetchIndexHtml(args.indexUrl, args.indexHost, args.signal, args.ctx);
  const candidates = collectReportCandidates(html, args.indexUrl, args.profile);
  const manifestUrl = normalizeUrl(args.manifest.reportUrl, args.indexUrl);
  const exact = candidates.filter((candidate) => candidate.url === manifestUrl);
  const datedCandidates = candidates.map((candidate) => {
    const date = parseDiscoveryDate(`${candidate.url} ${candidate.text}`);
    return { ...candidate, date };
  });
  const ambiguousDate = datedCandidates.some((candidate) => candidate.date == null);
  const latestDate = datedCandidates.reduce<string | null>(
    (latest, candidate) => (candidate.date != null && (latest == null || candidate.date > latest) ? candidate.date : latest),
    null,
  );
  const latestCandidates = datedCandidates.filter((candidate) => candidate.date === latestDate);
  const newer = latestDate != null && latestDate > args.manifest.reportDate;
  const duplicateLatest = latestDate === args.manifest.reportDate &&
    (latestCandidates.length !== 1 || latestCandidates[0]?.url !== manifestUrl);
  if (ambiguousDate || newer || duplicateLatest || exact.length !== 1) {
    throw new Error(
      `independent-assurance: ${ambiguousDate ? "ambiguous report date" : newer ? "newer unreviewed report" : "reviewed report URL is missing or duplicated"} on official index`,
    );
  }

  return fetchAndHashPdf(args.manifest, args.reportHosts, args.signal, args.ctx);
}

export async function fetchIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  profile: IndependentAssuranceProfile,
  params: {
    product: IndependentAssuranceProduct;
    profile: string;
    indexHost: string;
    reportHosts: readonly string[];
  },
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  if (params.product !== profile.product || params.profile !== profile.profile) {
    throw new Error(`independent-assurance: adapter/profile parameter mismatch for ${profile.adapterName}`);
  }
  if (coin.symbol.toUpperCase() !== profile.product) {
    throw new Error(`independent-assurance: coin ${coin.id} is not ${profile.product}`);
  }
  const primary = config.inputs.primary;
  if (primary.kind !== "http-html") {
    throw new Error(`${profile.adapterName} adapter requires an http-html primary input`);
  }

  const manifest = getIndependentAssuranceManifest(profile.product);
  if (manifest.profile !== profile.profile) {
    throw new Error(`independent-assurance: manifest profile drifted for ${profile.product}`);
  }
  if (normalizeUrl(primary.url, primary.url) !== normalizeUrl(manifest.officialIndexUrl, manifest.officialIndexUrl)) {
    throw new Error(`independent-assurance: configured index URL is not the reviewed official index`);
  }

  const artifact = await verifyIndependentAssuranceReport({
    manifest,
    indexUrl: primary.url,
    indexHost: params.indexHost,
    reportHosts: params.reportHosts,
    profile,
    signal,
    ctx,
  });
  const reconciliation = reconcileIndependentAssuranceManifest(manifest, profile.reconciliation);

  for (const requiredCode of profile.requiredAssetCodes) {
    if (!manifest.assets.some((asset) => asset.code === requiredCode && Number(asset.amount) > 0)) {
      throw new Error(`independent-assurance: required positive asset row ${requiredCode} is missing`);
    }
  }

  const classifiedAssets = manifest.assets.map((asset) => {
    const classification = profile.classifications[asset.code];
    if (Number(asset.amount) > 0 && !classification) {
      throw new Error(`independent-assurance: unknown positive asset row ${asset.code}`);
    }
    return {
      amount: Number(asset.amount),
      name: classification?.name ?? asset.label,
      risk: classification?.risk ?? "very-low",
      ...(classification?.coinId ? { coinId: classification.coinId } : {}),
      ...(classification?.depType ? { depType: classification.depType } : {}),
      ...(classification?.assetClass ? { assetClass: classification.assetClass } : {}),
      ...(classification?.issuerOrObligor ? { issuerOrObligor: classification.issuerOrObligor } : {}),
      ...(classification?.riskFactors ? { riskFactors: classification.riskFactors } : {}),
      ...(classification?.liquidityHorizon ? { liquidityHorizon: classification.liquidityHorizon } : {}),
    };
  });
  const totalClassifiedAmount = classifiedAssets.reduce((sum, asset) => sum + asset.amount, 0);
  const slices = normalizeSlices(
    classifiedAssets.map(({ amount, ...asset }) => ({ ...asset, pct: (amount / totalClassifiedAmount) * 100 })),
    6,
  );
  if (slices.length === 0) throw new Error("independent-assurance: no positive reserve asset rows");

  const details = {
    assurance: {
      product: manifest.product,
      profile: manifest.profile,
      reportDate: manifest.reportDate,
      reportAsOf: manifest.reportAsOf,
      reportTimeZone: manifest.reportTimeZone,
      reportUrl: manifest.reportUrl,
      reportSha256: manifest.reportSha256,
      reportByteLength: manifest.reportByteLength,
      attestor: manifest.attestor,
      engagement: manifest.engagement,
      conclusion: manifest.conclusion,
      unit: manifest.unit,
      assets: manifest.assets,
      liabilities: manifest.liabilities,
      ...(manifest.adjustments ? { adjustments: manifest.adjustments } : {}),
      reportedAssetTotal: manifest.reportedAssetTotal,
      computedAssetTotal: reconciliation.computedAssetTotal,
      reportedLiabilityTotal: manifest.reportedLiabilityTotal,
      computedLiabilityTotal: reconciliation.liabilityTotal,
      reportedAssetDifference: reconciliation.reportedAssetDifference,
      reportedLiabilityDifference: reconciliation.reportedLiabilityDifference,
      extraction: manifest.extraction,
      verifiedResponseUrl: artifact.responseUrl,
      verifiedByteLength: artifact.byteLength,
    },
  };

  const roundingDifferences = [
    reconciliation.reportedAssetDifference !== "0"
      ? `assets ${reconciliation.reportedAssetDifference} ${manifest.unit} (${reconciliation.reportedAssetDifferencePpm.toFixed(3)} ppm)`
      : null,
    reconciliation.reportedLiabilityDifference !== "0"
      ? `liabilities ${reconciliation.reportedLiabilityDifference} ${manifest.unit} (${reconciliation.reportedLiabilityDifferencePpm.toFixed(3)} ppm)`
      : null,
  ].filter((value): value is string => value !== null);

  return {
    slices,
    ...(roundingDifferences.length > 0
      ? {
          warnings: [
            reserveInfoWarning(
              "report-rounding-difference",
              `Reported totals differ from recomputed rows: ${roundingDifferences.join("; ")}`,
            ),
          ],
        }
      : {}),
    metadata: {
      sourceTimestamp: artifact.sourceTimestamp,
      freshnessMode: "verified",
      collateralizationRatio: reconciliation.collateralizationRatio,
      details,
    },
  };
}
