import {
  getIndependentAssuranceManifest,
  independentAssuranceSourceTimestamp,
  reconcileIndependentAssuranceManifest,
  type IndependentAssuranceManifest,
} from "@shared/lib/independent-assurance";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { sha256Hex } from "../../lib/hash";
import { normalizeSlices, reserveDegradedWarning, reserveInfoWarning } from "./helpers";
import type { IndependentAssuranceProfile } from "./independent-assurance";
import { fetchBinaryResponseWithRetry, fetchJsonPostWithRetry, fetchTextResponseWithRetry } from "./request";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "brla-independent-assurance";
const MAX_PDF_BYTES = 4 * 1024 * 1024;
const PDF_MAGIC = "%PDF-";

/**
 * Reviewed 2026-09-09: pinned Notion block identity for the July 31, 2026 UHY
 * reasonable-assurance report on the official BRLA transparency page. The
 * runtime re-resolves the signed download URL through loadPageChunk /
 * getSignedFileUrls and fails closed on any page-block drift; the bytes are
 * additionally pinned by SHA-256 and length in the reviewed manifest.
 */
export const BRLA_NOTION_PIN = {
  rootPageId: "238ba143-aa2f-4338-902e-e91ebe50298a",
  rootPageTitle: "$BRLA Transparency Page",
  rootContent: [
    "cf1916ba-711b-40c4-94e5-e03624c5ed1f",
    "7bfdab83-655c-450c-a9a3-864148aedf34",
    "c322a3b4-7335-4c35-9537-3b5ac2ce540f",
    "2cba743f-1174-4ccf-9b30-103312db3173",
    "3047f28f-0ae4-80b4-90cd-dd40ecf60481",
    "3917f28f-0ae4-805e-9d52-db401c28fe81",
    "1a67f28f-0ae4-8039-bef1-fbc1e6262bdb",
    "d2906e8b-4cde-47f2-9a37-40a762f81b9c",
    "0e7779a9-ccb4-44f1-8a3e-38c5dce0356a",
    "6ec21b45-4aec-43b7-8ce6-c24ed23f9fd6",
    "71e226ba-7758-4cd1-99c9-b367e6076c6b",
  ],
  yearBlockId: "3047f28f-0ae4-80b4-90cd-dd40ecf60481",
  yearTitle: "2026",
  reportBlockId: "3c67f28f-0ae4-80fb-bd17-f3ca9b5d3490",
  attachmentTitle: "Avenia - Transparency Report - 20260731 (Audit Attestation).pdf",
  attachmentSource:
    "attachment:f7048fe1-2d4c-4bcb-bb66-29f306cac7d0:Avenia_-_Transparency_Report_-_20260731_(Audit_Attestation).pdf",
  attachmentId: "f7048fe1-2d4c-4bcb-bb66-29f306cac7d0",
} as const;

const BRLA_REPORT_FILE_PATTERN = /^Avenia - Transparency Report - (\d{8}) \(Audit Attestation\)\.pdf$/;

interface NotionBlock {
  id: string;
  type: string;
  title?: string;
  source?: string;
  content?: string[];
}

function firstTitlePart(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const first = value[0];
  if (Array.isArray(first) && typeof first[0] === "string") return first[0];
  return undefined;
}

function parseNotionBlock(raw: unknown): NotionBlock | null {
  if (typeof raw !== "object" || raw === null) return null;
  const outer = (raw as { value?: unknown }).value;
  if (typeof outer !== "object" || outer === null) return null;
  const inner = (outer as { value?: unknown }).value;
  if (typeof inner !== "object" || inner === null) return null;
  const block = inner as {
    id?: unknown;
    type?: unknown;
    properties?: Record<string, unknown>;
    content?: unknown;
  };
  if (typeof block.id !== "string" || typeof block.type !== "string") return null;
  return {
    id: block.id,
    type: block.type,
    title: firstTitlePart(block.properties?.title),
    source: firstTitlePart(block.properties?.source),
    content: Array.isArray(block.content)
      ? block.content.filter((item): item is string => typeof item === "string")
      : undefined,
  };
}

/** Notion's private site API lives under /api/v3 on the notion.site origin; it is not a Pharos route. */
function notionApiUrl(host: string, path: string): string {
  return new URL(`/api/v3/${path}`, `https://${host}`).toString();
}

async function loadNotionChunk(
  host: string,
  pageId: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<Record<string, unknown>> {
  const payload = await fetchJsonPostWithRetry<{ recordMap?: { block?: Record<string, unknown> } }>(
    notionApiUrl(host, "loadPageChunk"),
    { pageId, limit: 100, cursor: { stack: [] }, chunkNumber: 0, verticalColumns: false },
    signal,
    10_000,
    ctx,
  );
  const blocks = payload.recordMap?.block;
  if (!blocks) throw new Error(`${ADAPTER_KEY}: Notion loadPageChunk returned no block map`);
  return blocks;
}

/**
 * Verifies the official Notion transparency page still resolves the reviewed
 * July 31, 2026 attachment and returns a fresh signed download URL. Every
 * pinned identity (root page, root child tree, 2026 header, report block,
 * attachment) must match exactly; any drift fails closed.
 */
export async function verifyBrlaNotionDiscovery(args: {
  manifest: IndependentAssuranceManifest;
  indexUrl: string;
  indexHost: string;
  reportHosts: readonly string[];
  signal: AbortSignal;
  ctx?: AdapterContext;
}): Promise<{ signedUrl: string; sourceTimestamp: number }> {
  let index: URL;
  try {
    index = new URL(args.indexUrl);
  } catch {
    throw new Error(`${ADAPTER_KEY}: index URL is invalid`);
  }
  if (index.protocol !== "https:") throw new Error(`${ADAPTER_KEY}: index URL must use HTTPS`);
  if (index.hostname.toLowerCase() !== args.indexHost.toLowerCase()) {
    throw new Error(`${ADAPTER_KEY}: index host ${index.hostname} is not reviewed for this profile`);
  }

  const indexResponse = await fetchTextResponseWithRetry(args.indexUrl, args.signal, 15_000, args.ctx, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 Pharos reserve verifier",
    },
    maxRetries: 0,
  });
  const finalHost = (() => {
    try {
      return new URL(indexResponse.finalUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (finalHost !== args.indexHost.toLowerCase()) {
    throw new Error(`${ADAPTER_KEY}: index response URL drifted`);
  }

  const rootBlocks = await loadNotionChunk(args.indexHost, BRLA_NOTION_PIN.rootPageId, args.signal, args.ctx);
  const rootBlock = parseNotionBlock(rootBlocks[BRLA_NOTION_PIN.rootPageId]);
  if (!rootBlock || rootBlock.type !== "page" || rootBlock.title !== BRLA_NOTION_PIN.rootPageTitle) {
    throw new Error(`${ADAPTER_KEY}: official index page identity drifted`);
  }
  if (JSON.stringify(rootBlock.content ?? []) !== JSON.stringify(BRLA_NOTION_PIN.rootContent)) {
    throw new Error(`${ADAPTER_KEY}: official index structure changed; review report selection before publication`);
  }

  const yearBlocks = await loadNotionChunk(args.indexHost, BRLA_NOTION_PIN.yearBlockId, args.signal, args.ctx);
  const yearBlock = parseNotionBlock(yearBlocks[BRLA_NOTION_PIN.yearBlockId]);
  if (!yearBlock || yearBlock.type !== "header" || yearBlock.title !== BRLA_NOTION_PIN.yearTitle) {
    throw new Error(`${ADAPTER_KEY}: ${BRLA_NOTION_PIN.yearTitle} report group identity drifted`);
  }

  let latestReportDate: string | null = null;
  let latestBlockId: string | null = null;
  for (const raw of Object.values(yearBlocks)) {
    const block = parseNotionBlock(raw);
    if (!block || block.type !== "file" || !block.title) continue;
    const match = block.title.match(BRLA_REPORT_FILE_PATTERN);
    if (!match) continue;
    const date = match[1];
    if (latestReportDate == null || date > latestReportDate) {
      latestReportDate = date;
      latestBlockId = block.id;
    }
  }
  if (latestReportDate == null || latestReportDate > "20260731") {
    throw new Error(`${ADAPTER_KEY}: ${latestReportDate == null ? "no dated reports" : `newer unreviewed report ${latestReportDate}`} on official index`);
  }
  if (latestBlockId !== BRLA_NOTION_PIN.reportBlockId) {
    throw new Error(`${ADAPTER_KEY}: reviewed July report is not the latest report on official index`);
  }
  const reportBlock = parseNotionBlock(yearBlocks[BRLA_NOTION_PIN.reportBlockId]);
  if (!reportBlock || reportBlock.type !== "file" || reportBlock.title !== BRLA_NOTION_PIN.attachmentTitle) {
    throw new Error(`${ADAPTER_KEY}: reviewed report block identity drifted`);
  }
  if (reportBlock.source !== BRLA_NOTION_PIN.attachmentSource) {
    throw new Error(`${ADAPTER_KEY}: reviewed report attachment drifted`);
  }

  const signed = await fetchJsonPostWithRetry<{ signedUrls?: unknown }>(
    notionApiUrl(args.indexHost, "getSignedFileUrls"),
    {
      urls: [{ url: BRLA_NOTION_PIN.attachmentSource, permissionRecord: { table: "block", id: BRLA_NOTION_PIN.reportBlockId } }],
    },
    args.signal,
    10_000,
    args.ctx,
  );
  const signedUrl = Array.isArray(signed.signedUrls) && typeof signed.signedUrls[0] === "string"
    ? signed.signedUrls[0]
    : null;
  if (!signedUrl) throw new Error(`${ADAPTER_KEY}: Notion returned no signed URL for the reviewed attachment`);
  let parsedSigned: URL;
  try {
    parsedSigned = new URL(signedUrl);
  } catch {
    throw new Error(`${ADAPTER_KEY}: malformed signed URL`);
  }
  if (!args.reportHosts.includes(parsedSigned.hostname.toLowerCase())) {
    throw new Error(`${ADAPTER_KEY}: signed URL host is not reviewed`);
  }
  if (!parsedSigned.pathname.includes(BRLA_NOTION_PIN.attachmentId)) {
    throw new Error(`${ADAPTER_KEY}: signed URL attachment identity drifted`);
  }
  if (parsedSigned.searchParams.get("id") !== BRLA_NOTION_PIN.reportBlockId) {
    throw new Error(`${ADAPTER_KEY}: signed URL block identity drifted`);
  }

  return { signedUrl, sourceTimestamp: independentAssuranceSourceTimestamp(args.manifest) };
}

export async function fetchAndVerifyBrlaPdf(args: {
  manifest: IndependentAssuranceManifest;
  signedUrl: string;
  reportHosts: readonly string[];
  signal: AbortSignal;
  ctx?: AdapterContext;
}): Promise<{ responseUrl: string; byteLength: number }> {
  const response = await fetchBinaryResponseWithRetry(args.signedUrl, args.signal, 15_000, args.ctx, {
    headers: {
      Accept: "application/pdf,application/octet-stream;q=0.9",
      "User-Agent": "Mozilla/5.0 Pharos reserve verifier",
    },
    maxRetries: 0,
    maxResponseBytes: MAX_PDF_BYTES,
  });
  const finalHost = (() => {
    try {
      return new URL(response.finalUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (!args.reportHosts.includes(finalHost)) {
    throw new Error(`${ADAPTER_KEY}: PDF response host is not reviewed`);
  }
  const bytes = response.body;
  if (bytes.length !== args.manifest.reportByteLength) {
    throw new Error(
      `${ADAPTER_KEY}: PDF byte length ${bytes.length} does not match reviewed ${args.manifest.reportByteLength}`,
    );
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const magic = new TextDecoder().decode(bytes.slice(0, PDF_MAGIC.length));
  if (!contentType.startsWith("application/pdf") && magic !== PDF_MAGIC) {
    throw new Error(`${ADAPTER_KEY}: official artifact is not a PDF`);
  }
  const digest = await sha256Hex(bytes);
  if (digest !== args.manifest.reportSha256.toLowerCase()) {
    throw new Error(`${ADAPTER_KEY}: PDF SHA-256 ${digest} does not match reviewed manifest`);
  }
  return { responseUrl: response.finalUrl, byteLength: bytes.length };
}
type BrlaAssetClassification = IndependentAssuranceProfile["classifications"][string];
const BRLA_CLASSIFICATIONS: Record<string, BrlaAssetClassification> = {
  "cash-and-cash-equivalents": {
    name: "BRL cash and cash equivalents held at named Brazilian financial institutions",
    risk: "very-low",
    assetClass: "cash",
    issuerOrObligor: "Stark Bank, Woovi, BTG Pactual, Itaú Unibanco, XP Investimentos, Banco Inter",
    riskFactors: ["counterparty", "liquidity", "custody", "concentration"],
    liquidityHorizon: "immediate",
  },
  "repurchase-agreements": {
    name: "Overnight repurchase agreements collateralized by Brazilian corporate debentures",
    risk: "low",
    assetClass: "repo",
    issuerOrObligor: "XP Investimentos; diversified Brazilian corporate debentures as collateral",
    riskFactors: ["credit", "counterparty", "liquidity", "custody", "market"],
    liquidityHorizon: "one-day",
  },
};

const BRLA_REQUIRED_ASSET_CODES = ["cash-and-cash-equivalents", "repurchase-agreements"] as const;

export async function fetchBrlaIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params) as
    LiveReserveAdapterParamsByKey["brla-independent-assurance"];
  if (params.product !== "BRLA" || params.profile !== "brla-v1") {
    throw new Error(`${ADAPTER_KEY}: adapter/profile parameter mismatch`);
  }
  if (coin.symbol.toUpperCase() !== "BRLA") {
    throw new Error(`${ADAPTER_KEY}: coin ${coin.id} is not BRLA`);
  }
  const primary = config.inputs.primary;
  if (primary.kind !== "http-html") {
    throw new Error(`${ADAPTER_KEY} adapter requires an http-html primary input`);
  }

  const manifest = getIndependentAssuranceManifest("BRLA");
  if (manifest.profile !== params.profile) {
    throw new Error(`${ADAPTER_KEY}: manifest profile drifted for ${manifest.product}`);
  }
  if (new URL(primary.url).href !== new URL(manifest.officialIndexUrl).href) {
    throw new Error(`${ADAPTER_KEY}: configured index URL is not the reviewed official index`);
  }

  const discovery = await verifyBrlaNotionDiscovery({
    manifest,
    indexUrl: primary.url,
    indexHost: params.indexHost,
    reportHosts: params.reportHosts,
    signal,
    ctx,
  });
  const artifact = await fetchAndVerifyBrlaPdf({
    manifest,
    signedUrl: discovery.signedUrl,
    reportHosts: params.reportHosts,
    signal,
    ctx,
  });
  const reconciliation = reconcileIndependentAssuranceManifest(manifest);

  for (const requiredCode of BRLA_REQUIRED_ASSET_CODES) {
    if (!manifest.assets.some((asset) => asset.code === requiredCode && Number(asset.amount) > 0)) {
      throw new Error(`${ADAPTER_KEY}: required positive asset row ${requiredCode} is missing`);
    }
  }

  const classifiedAssets = manifest.assets.map((asset) => {
    const classification = BRLA_CLASSIFICATIONS[asset.code];
    if (Number(asset.amount) > 0 && !classification) {
      throw new Error(`${ADAPTER_KEY}: unknown positive asset row ${asset.code}`);
    }
    return {
      sourceKey: `brla-independent-assurance:brla:${asset.code}`,
      amount: Number(asset.amount),
      name: classification?.name ?? asset.label,
      risk: classification?.risk ?? "very-low",
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
  if (slices.length === 0) throw new Error(`${ADAPTER_KEY}: no positive reserve asset rows`);

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
      reportedAssetTotal: manifest.reportedAssetTotal,
      computedAssetTotal: reconciliation.computedAssetTotal,
      reportedLiabilityTotal: manifest.reportedLiabilityTotal,
      computedLiabilityTotal: reconciliation.liabilityTotal,
      reportedAssetDifference: reconciliation.reportedAssetDifference,
      reportedLiabilityDifference: reconciliation.reportedLiabilityDifference,
      reserveShortfall: reconciliation.reserveShortfall,
      nonPositiveLiabilityCodes: reconciliation.nonPositiveLiabilityCodes,
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

  const warnings = [];
  if (roundingDifferences.length > 0) {
    warnings.push(reserveInfoWarning(
      "report-rounding-difference",
      `Reported totals differ from recomputed rows: ${roundingDifferences.join("; ")}`,
    ));
  }
  if (reconciliation.reserveShortfall !== "0" || reconciliation.nonPositiveLiabilityCodes.length > 0) {
    warnings.push(reserveDegradedWarning(
      "reserve-undercollateralized",
      `Report reserve shortfall: ${reconciliation.reserveShortfall} ${manifest.unit}; non-positive liability rows: ${reconciliation.nonPositiveLiabilityCodes.join(", ") || "none"}`,
    ));
  }

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      sourceTimestamp: discovery.sourceTimestamp,
      freshnessMode: "verified",
      ...(reconciliation.collateralizationRatio !== null
        ? { collateralizationRatio: reconciliation.collateralizationRatio }
        : {}),
      details,
    },
  };
}
