import { toErrorMessage } from "@shared/lib/error-utils";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { getIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  reserveInfoWarning,
} from "./helpers";
import {
  fetchIndependentAssuranceReserves,
  type IndependentAssuranceProfile,
} from "./independent-assurance";
import { formatValidIsoDate } from "./report-date";

const ADAPTER_KEY = "usdgo-transparency";
const SAME_PERIOD_CROSS_CHECK_MAX_AGE_SEC = 3 * 24 * 60 * 60;
const CROSS_CHECK_TOLERANCE_PCT = 1;

export const USDGO_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: ADAPTER_KEY,
  product: "USDGO",
  profile: "usdgo-v1",
  requiredAssetCodes: ["cash", "buidl", "stbxx", "jltxx"],
  classifications: {
    cash: {
      name: "FDIC-insured bank cash",
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Major commercial banks holding Anchorage fiduciary cash",
      riskFactors: ["counterparty", "custody", "liquidity", "concentration"],
      liquidityHorizon: "immediate",
    },
    buidl: {
      name: "BlackRock BUIDL",
      risk: "low",
      coinId: "buidl-blackrock",
      assetClass: "fund-share",
      issuerOrObligor: "BlackRock USD Institutional Digital Liquidity Fund",
      riskFactors: ["credit", "liquidity", "custody", "counterparty", "legal"],
      liquidityHorizon: "one-day",
    },
    stbxx: {
      name: "Goldman Sachs STBXX (CUSIP 38151N205)",
      risk: "low",
      assetClass: "money-market-fund",
      issuerOrObligor: "Goldman Sachs Financial Square Government Fund",
      riskFactors: ["credit", "liquidity", "custody", "counterparty", "duration"],
      liquidityHorizon: "one-day",
    },
    jltxx: {
      name: "JPMorgan JLTXX (CUSIP 46655R119)",
      risk: "low",
      assetClass: "money-market-fund",
      issuerOrObligor: "JPMorgan Liquidity Funds",
      riskFactors: ["credit", "liquidity", "custody", "counterparty", "duration"],
      liquidityHorizon: "one-day",
    },
  },
  isReportCandidate: (href) =>
    /USDGO[-_ ]Stablecoin[-_ ]Attestation[-_ ]Report/i.test(decodeURIComponent(href)),
  reportDateFromCandidate: usdgoReportDate,
};

interface UsdgoIssuerCrossCheckPayload {
  ok?: boolean;
  data?: Record<string, unknown>;
}

function usdgoReportDate(href: string): string | null {
  const fileName = decodeURIComponent(new URL(href).pathname.split("/").pop() ?? "");
  const match = fileName.match(/^(\d{2})[.](\d{2})[.](\d{2})_USDGO[-_]Stablecoin[-_]Attestation[-_]Report/i);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = 2000 + Number(match[3]);
  return formatValidIsoDate(year, month, day, 2000);
}

function parseMillionUsd(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${ADAPTER_KEY}: invalid issuer ${label}`);
  return parsed * 1_000_000;
}

function requireIssuerData(payload: UsdgoIssuerCrossCheckPayload): Record<string, unknown> {
  if (payload.ok !== true || !payload.data || typeof payload.data !== "object") {
    throw new Error(`${ADAPTER_KEY}: issuer cross-check returned an invalid response`);
  }
  const data = payload.data;
  const knownKeys = new Set([
    "collateralizationRatio",
    "buidlUsdM",
    "gsUsdM",
    "jltxxUsdM",
    "usdUsdM",
    "backingAssetsM",
    "circulationSupplyMFormatted",
    "lastUpdated",
    "assetPhrases",
    "transparencyUrl",
    "circulationChains",
  ]);
  for (const [key, value] of Object.entries(data)) {
    if (knownKeys.has(key)) continue;
    if (typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))) {
      throw new Error(`${ADAPTER_KEY}: issuer cross-check exposed unknown numeric field ${key}`);
    }
  }
  return data;
}

async function readIssuerCrossCheck(
  url: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<{ sourceTimestamp: number; values: Record<string, number>; source: string }> {
  const payload = await fetchJsonWithRetry<UsdgoIssuerCrossCheckPayload>(url, signal, 8_000, ctx);
  const data = requireIssuerData(payload);
  const values = {
    buidlUsd: parseMillionUsd(data.buidlUsdM, "buidlUsdM"),
    stbxxUsd: parseMillionUsd(data.gsUsdM, "gsUsdM"),
    jltxxUsd: parseMillionUsd(data.jltxxUsdM, "jltxxUsdM"),
    cashUsd: parseMillionUsd(data.usdUsdM, "usdUsdM"),
    totalReserveUsd: parseMillionUsd(data.backingAssetsM, "backingAssetsM"),
    supplyUsd: parseMillionUsd(data.circulationSupplyMFormatted, "circulationSupplyMFormatted"),
  };
  const componentTotalUsd = values.buidlUsd + values.stbxxUsd + values.jltxxUsd + values.cashUsd;
  if (values.totalReserveUsd <= 0 || values.supplyUsd <= 0 || Math.abs(componentTotalUsd - values.totalReserveUsd) / values.totalReserveUsd > 0.01) {
    throw new Error(`${ADAPTER_KEY}: issuer cross-check components do not reconcile`);
  }
  const sourceTimestamp = Date.parse(String(data.lastUpdated ?? ""));
  if (!Number.isFinite(sourceTimestamp)) throw new Error(`${ADAPTER_KEY}: issuer cross-check timestamp is invalid`);
  return {
    sourceTimestamp: Math.floor(sourceTimestamp / 1_000),
    values,
    source: url,
  };
}

function compareCrossCheck(
  report: { sourceTimestamp: number; values: Record<string, number> },
  crossCheck: { sourceTimestamp: number; values: Record<string, number>; source: string },
): { warning?: LiveReserveWarning; details: Record<string, unknown> } {
  const deltaSec = crossCheck.sourceTimestamp - report.sourceTimestamp;
  const details = {
    source: crossCheck.source,
    sourceTimestamp: crossCheck.sourceTimestamp,
    values: crossCheck.values,
    reportTimestampDeltaSec: deltaSec,
  };
  if (Math.abs(deltaSec) > SAME_PERIOD_CROSS_CHECK_MAX_AGE_SEC) {
    return {
      warning: reserveInfoWarning(
        "usdgo-issuer-cross-check-newer-period",
        "USDGO issuer transparency values were retained as a later-period cross-check; Deloitte's verified report remains authoritative.",
      ),
      details,
    };
  }
  for (const key of ["buidlUsd", "stbxxUsd", "jltxxUsd", "cashUsd", "totalReserveUsd", "supplyUsd"] as const) {
    const reportValue = report.values[key];
    const crossValue = crossCheck.values[key];
    const denominator = Math.max(Math.abs(reportValue), 1);
    if (Math.abs(reportValue - crossValue) / denominator * 100 > CROSS_CHECK_TOLERANCE_PCT) {
      throw new Error(`${ADAPTER_KEY}: issuer cross-check disagrees with Deloitte report for ${key}`);
    }
  }
  return { details };
}

export async function fetchUsdgoTransparencyReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params) as
    LiveReserveAdapterParamsByKey["usdgo-transparency"];
  const manifest = getIndependentAssuranceManifest("USDGO");
  const reportValues = {
    buidlUsd: Number(manifest.assets.find((asset) => asset.code === "buidl")?.amount ?? 0),
    stbxxUsd: Number(manifest.assets.find((asset) => asset.code === "stbxx")?.amount ?? 0),
    jltxxUsd: Number(manifest.assets.find((asset) => asset.code === "jltxx")?.amount ?? 0),
    cashUsd: Number(manifest.assets.find((asset) => asset.code === "cash")?.amount ?? 0),
    totalReserveUsd: Number(manifest.reportedAssetTotal),
    supplyUsd: Number(manifest.reportedLiabilityTotal),
  };
  const reportTimestamp = Date.parse(manifest.reportAsOf);
  if (!Number.isFinite(reportTimestamp)) throw new Error(`${ADAPTER_KEY}: reviewed report timestamp is invalid`);

  const assurancePromise = fetchIndependentAssuranceReserves(
    coin,
    config,
    signal,
    USDGO_INDEPENDENT_ASSURANCE_PROFILE,
    params,
    ctx,
  );
  const crossCheckPromise = readIssuerCrossCheck(params.issuerCrossCheckUrl, signal, ctx).catch((error: unknown) => ({
    error: toErrorMessage(error),
  }));
  const [assurance, crossCheck] = await Promise.all([assurancePromise, crossCheckPromise]);

  const warnings = [...(assurance.warnings ?? [])];
  let issuerCrossCheckDetails: Record<string, unknown> | undefined;
  if ("error" in crossCheck) {
    warnings.push(reserveInfoWarning(
      "usdgo-issuer-cross-check-unavailable",
      `USDGO issuer API cross-check was unavailable; Deloitte's verified report remains authoritative (${crossCheck.error}).`,
    ));
  } else {
    const compared = compareCrossCheck(
      { sourceTimestamp: Math.floor(reportTimestamp / 1_000), values: reportValues },
      crossCheck,
    );
    issuerCrossCheckDetails = compared.details;
    if (compared.warning) warnings.push(compared.warning);
  }

  const reportSurplusUsd = reportValues.totalReserveUsd - reportValues.supplyUsd;
  const metadata = assurance.metadata ?? {};
  const assuranceDetails = metadata.details && typeof metadata.details === "object" ? metadata.details : {};
  return {
    slices: assurance.slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...metadata,
      sourceTimestamp: Math.floor(reportTimestamp / 1_000),
      freshnessMode: "verified",
      unknownExposurePct: 0,
      totalReserveUsd: reportValues.totalReserveUsd,
      totalAssetsUsd: reportValues.totalReserveUsd,
      totalLiabilitiesUsd: reportValues.supplyUsd,
      supplyUsd: reportValues.supplyUsd,
      shareholderEquityUsd: reportSurplusUsd,
      collateralizationRatio: reportValues.totalReserveUsd / reportValues.supplyUsd,
      ...(issuerCrossCheckDetails ? { issuerCrossCheck: issuerCrossCheckDetails } : {}),
      details: {
        ...assuranceDetails,
        authoritativeBasis: "Deloitte examination report; issuer API is cross-check only",
        reportSurplusUsd,
      },
      sourceProvenance: "Deloitte independent examination with exact artifact hash; issuer transparency API is non-authoritative cross-check only.",
    },
  };
}
