import {
  getIndependentAssuranceManifest,
  independentAssuranceSourceTimestamp,
  reconcileIndependentAssuranceManifest,
  type IndependentAssuranceManifest,
  type IndependentAssuranceProduct,
  type IndependentAssuranceReconciliationOptions,
} from "@shared/lib/independent-assurance";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { normalizeSlices, readHtmlAttribute, stripTags } from "./helpers";
import { fetchBinaryResponseWithRetry, fetchTextResponseWithRetry } from "./request";
import type { AdapterContext, AdapterFn, AdapterResult } from "./types";
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
  reportDateFromCandidate?: (href: string, text: string) => string | null;
}

const formatDate = (year: number, month: number, day: number): string | null => year < 2000 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ? null : `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
export const AUDX_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: "audx-independent-assurance", product: "AUDX", profile: "audx-v1", requiredAssetCodes: ["designated-bank-accounts"], classifications: {
    "designated-bank-accounts": { name: "Australian-dollar reserves in designated bank accounts", risk: "very-low", assetClass: "bank-deposit", issuerOrObligor: "Undisclosed Australian financial institutions", riskFactors: ["counterparty", "liquidity", "custody", "concentration"], liquidityHorizon: "unknown" },
  },
  isReportCandidate: (href, text) =>
    !/whitepaper/i.test(`${href} ${text}`) && /report|attestation|audit/i.test(`${href} ${text}`),
};

function europReportDate(href: string): string | null {
  const fileName = decodeURIComponent(new URL(href).pathname.split("/").pop() ?? "");
  const yearFirst = fileName.match(/((?:19|20)\d{2})[._-](\d{1,2})[._-](\d{1,2})/);
  const dayFirst = fileName.match(/(\d{1,2})[._-](\d{1,2})[._-]((?:19|20)?\d{2})/);
  const quarter = fileName.match(/Q([1-4])[_-]((?:19|20)\d{2})/i);
  if (yearFirst) return formatDate(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
  if (dayFirst) return formatDate(dayFirst[3].length === 2 ? 2000 + Number(dayFirst[3]) : Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]));
  if (!quarter) return null;
  const year = Number(quarter[2]), month = Number(quarter[1]) * 3;
  return formatDate(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate());
}
export const EUROP_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: "europ-independent-assurance", product: "EUROP", profile: "europ-v1", requiredAssetCodes: ["cash", "cash-equivalents"],
  classifications: {
    cash: { name: "Euro cash held at regulated financial institutions", risk: "very-low", assetClass: "bank-deposit", issuerOrObligor: "Societe Generale S.A. and Banking Circle S.A.", riskFactors: ["counterparty", "liquidity", "custody", "legal", "concentration"], liquidityHorizon: "immediate" },
    "cash-equivalents": { name: "Euro cash equivalents held at regulated financial institutions (instruments undisclosed)", risk: "low", assetClass: "other", issuerOrObligor: "Societe Generale S.A. and Banking Circle S.A.; underlying instruments undisclosed", riskFactors: ["credit", "duration", "liquidity", "custody", "counterparty", "concentration"], liquidityHorizon: "unknown" },
  },
  reconciliation: {
    reportedAssetTotalTolerance: { absolute: "1", relativePpm: 1 },
    reportedLiabilityTotalTolerance: { absolute: "1", relativePpm: 1 },
  },
  isReportCandidate: (href) => /(?:SALVUS.*Attestation.*(?:EUROP|Letter)|Attestation.*(?:number|nombre).*EUROP)/i.test(decodeURIComponent(href)),
  reportDateFromCandidate: europReportDate,
};
const STRAITSX_MONTHS: Readonly<Record<string, number>> = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
function straitsxReportDate(href: string, text: string): string | null {
  const fileName = decodeURIComponent(new URL(href).pathname.split("/").pop() ?? "");
  const fullDate = fileName.match(/(\d{1,2})[ _-](Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[ _-]((?:19|20)\d{2})/i);
  if (fullDate) return formatDate(Number(fullDate[3]), STRAITSX_MONTHS[fullDate[2].toLowerCase()], Number(fullDate[1]));
  const compactDate = fileName.match(/(?:xsgd|xusd)-(\d{2})(\d{2})(\d{2})(?:\D|$)/i);
  if (compactDate) return formatDate(2000 + Number(compactDate[1]), Number(compactDate[2]), Number(compactDate[3]));
  const monthOnly = fileName.match(/(?:xsgd|xusd)-report-(\d{2}|(?:19|20)\d{2})-([a-z]+)/i);
  if (monthOnly) {
    const month = STRAITSX_MONTHS[monthOnly[2].toLowerCase()];
    const year = monthOnly[1].length === 2 ? 2000 + Number(monthOnly[1]) : Number(monthOnly[1]);
    if (month) return formatDate(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate());
  }
  const labelDate = text.match(/\b(Mid-)?(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+((?:19|20)\d{2})\b/i);
  if (!labelDate) return null;
  const month = STRAITSX_MONTHS[labelDate[2].toLowerCase()];
  const year = Number(labelDate[3]);
  return formatDate(year, month, labelDate[1] ? 15 : new Date(Date.UTC(year, month, 0)).getUTCDate());
}

const STRAITSX_PROFILE_BASE: Omit<IndependentAssuranceProfile, "product" | "requiredAssetCodes" | "isReportCandidate" | "reportDateFromCandidate"> = {
  adapterName: "straitsx-independent-assurance",
  profile: "straitsx-v1",
  classifications: {
    cash: { name: "Cash deposits in the safeguarded reserve account", risk: "very-low", assetClass: "cash", issuerOrObligor: "Undisclosed MAS-permitted safeguarding institution", riskFactors: ["counterparty", "custody", "concentration"], liquidityHorizon: "immediate" },
    "short-dated-government-or-repo": { name: "Short-dated sovereign instruments or eligible overnight reverse repos", risk: "very-low", assetClass: "other", issuerOrObligor: "Relevant government or eligible highly rated overnight reverse-repo counterparty", riskFactors: ["counterparty", "duration", "liquidity", "custody"], liquidityHorizon: "unknown" },
    "fixed-deposits": { name: "Fixed deposits", risk: "very-low", assetClass: "bank-deposit", issuerOrObligor: "Undisclosed safeguarding institution", riskFactors: ["counterparty", "custody", "liquidity"], liquidityHorizon: "unknown" },
  },
};
export function straitsxIndependentAssuranceProfile(product: "XSGD" | "XUSD"): IndependentAssuranceProfile {
  return {
    ...STRAITSX_PROFILE_BASE,
    product,
    requiredAssetCodes: product === "XSGD" ? ["cash", "short-dated-government-or-repo"] : ["cash"],
    isReportCandidate: (href, text) => ((decoded) => !/whitepaper/i.test(decoded) && decoded.toUpperCase().includes(product) && /(?:SCS[ _]Reserve[ _]Account[ _]Report|Attestation Report)/i.test(decoded))(decodeURIComponent(`${href} ${text}`)),
    reportDateFromCandidate: straitsxReportDate,
  };
}
export const INDEPENDENT_ASSURANCE_PROFILES = {
  "audx-independent-assurance": AUDX_INDEPENDENT_ASSURANCE_PROFILE,
  "europ-independent-assurance": EUROP_INDEPENDENT_ASSURANCE_PROFILE,
  "straitsx-independent-assurance": straitsxIndependentAssuranceProfile,
} as const;

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
    const date = args.profile.reportDateFromCandidate
      ? args.profile.reportDateFromCandidate(candidate.url, candidate.text)
      : parseDiscoveryDate(`${candidate.url} ${candidate.text}`);
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

export const fetchIndependentAssuranceAdapter: AdapterFn = async (coin, config, signal, ctx) => {
  const adapter = config.adapter;
  if (adapter === "straitsx-independent-assurance") {
    const params = parseLiveReserveAdapterParams("straitsx-independent-assurance", config.params) as
      LiveReserveAdapterParamsByKey["straitsx-independent-assurance"];
    return fetchIndependentAssuranceReserves(coin, config, signal, INDEPENDENT_ASSURANCE_PROFILES["straitsx-independent-assurance"](params.product), params, ctx);
  }
  if (adapter === "audx-independent-assurance" || adapter === "europ-independent-assurance") {
    const params = parseLiveReserveAdapterParams(adapter, config.params) as
      LiveReserveAdapterParamsByKey["audx-independent-assurance"] | LiveReserveAdapterParamsByKey["europ-independent-assurance"];
    return fetchIndependentAssuranceReserves(coin, config, signal, INDEPENDENT_ASSURANCE_PROFILES[adapter], params, ctx);
  }
  throw new Error(`independent-assurance: unsupported adapter ${adapter}`);
};
