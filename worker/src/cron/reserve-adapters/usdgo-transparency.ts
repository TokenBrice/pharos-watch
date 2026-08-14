import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { getIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { keccak256, toBytes } from "viem";
import { fetchEvmRpcBatch } from "../../lib/evm-rpc";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  reserveInfoWarning,
} from "./helpers";
import { runAdapterIo } from "./concurrency";
import {
  fetchIndependentAssuranceReserves,
  type IndependentAssuranceProfile,
} from "./independent-assurance";

const ADAPTER_KEY = "usdgo-transparency";
const BUIDL_DECIMALS = 6;
const BUIDL_REPORT_AMOUNT_USD = 170_977_843;
const BUIDL_MAX_ROUNDING_DIVERGENCE_USD = 1;
const SAME_PERIOD_CROSS_CHECK_MAX_AGE_SEC = 3 * 24 * 60 * 60;
const CROSS_CHECK_TOLERANCE_PCT = 1;
const BUIDL_BALANCE_OF_SELECTOR = "0x70a08231";
const BUIDL_DECIMALS_SELECTOR = "0x313ce567";

const PROFILE: IndependentAssuranceProfile = {
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
  isReportCandidate: (href, text) => /usdgo|attestation|reserve.?report/i.test(`${href} ${text}`),
};

interface UsdgoIssuerCrossCheckPayload {
  ok?: boolean;
  data?: Record<string, unknown>;
}

interface BuidlObservation {
  blockNumber: number;
  blockHash: string;
  blockTimestamp: number;
  balanceUsd: number;
  balanceRaw: bigint;
  decimals: number;
  codeHash: string;
}

function encodeAddressCall(selector: string, address: string): string {
  return `${selector}${address.toLowerCase().slice(2).padStart(64, "0")}`;
}

function requireHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${ADAPTER_KEY}: ${label} is not a hex result`);
  }
  return value;
}

function requireUint(value: unknown, label: string): bigint {
  const raw = requireHex(value, label);
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`${ADAPTER_KEY}: ${label} is not an integer`);
  }
}

function requireBlock(value: unknown, expectedNumber: number, expectedHash: string): {
  number: number;
  hash: string;
  timestamp: number;
} {
  if (!value || typeof value !== "object") throw new Error(`${ADAPTER_KEY}: BUIDL block header is missing`);
  const block = value as { number?: unknown; hash?: unknown; timestamp?: unknown };
  const numberRaw = requireHex(block.number, "BUIDL block number");
  const hash = requireHex(block.hash, "BUIDL block hash");
  const timestampRaw = requireHex(block.timestamp, "BUIDL block timestamp");
  const number = Number(BigInt(numberRaw));
  const timestamp = Number(BigInt(timestampRaw));
  if (!Number.isSafeInteger(number) || number !== expectedNumber) {
    throw new Error(`${ADAPTER_KEY}: BUIDL block number drifted`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash) || hash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`${ADAPTER_KEY}: BUIDL block hash drifted`);
  }
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error(`${ADAPTER_KEY}: BUIDL block timestamp is invalid`);
  }
  return { number, hash, timestamp };
}

async function readBuidlObservation(
  params: LiveReserveAdapterParamsByKey["usdgo-transparency"],
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<BuidlObservation> {
  const blockTag = `0x${params.avalancheBuidlBlock.toString(16)}`;
  const results = await runAdapterIo(
    ctx,
    `${ADAPTER_KEY}:buidl-rpc`,
    () => fetchEvmRpcBatch("avalanche", [
      { method: "eth_getBlockByNumber", params: [blockTag, false] },
      { method: "eth_getCode", params: [params.avalancheBuidlToken, blockTag] },
      {
        method: "eth_call",
        params: [{ to: params.avalancheBuidlToken, data: encodeAddressCall(BUIDL_BALANCE_OF_SELECTOR, params.avalancheBuidlWallet) }, blockTag],
      },
      {
        method: "eth_call",
        params: [{ to: params.avalancheBuidlToken, data: BUIDL_DECIMALS_SELECTOR }, blockTag],
      },
    ], {
      extraRpcUrls: [params.avalancheRpcUrl],
      signal,
      timeoutMs: 8_000,
      maxRetries: 0,
      chainRpcs: ctx?.chainRpcs,
    }),
    { signal },
  );
  if (!results) throw new Error(`${ADAPTER_KEY}: Avalanche BUIDL RPC batch failed`);

  const block = requireBlock(results[0], params.avalancheBuidlBlock, params.avalancheBuidlBlockHash);
  const code = requireHex(results[1], "BUIDL token code");
  if (code === "0x" || keccak256(toBytes(code)).toLowerCase() !== params.expectedBuidlCodeHash.toLowerCase()) {
    throw new Error(`${ADAPTER_KEY}: BUIDL token code hash drifted`);
  }
  const balanceRaw = requireUint(results[2], "BUIDL balanceOf");
  const decimals = Number(requireUint(results[3], "BUIDL decimals"));
  if (decimals !== BUIDL_DECIMALS) throw new Error(`${ADAPTER_KEY}: BUIDL decimals drifted`);

  const balanceUsd = Number(balanceRaw) / 10 ** decimals;
  if (balanceRaw <= 0n || balanceRaw > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isFinite(balanceUsd) || balanceUsd <= 0) {
    throw new Error(`${ADAPTER_KEY}: BUIDL balance is invalid`);
  }
  const divergenceUsd = Math.abs(balanceUsd - BUIDL_REPORT_AMOUNT_USD);
  if (divergenceUsd > BUIDL_MAX_ROUNDING_DIVERGENCE_USD) {
    throw new Error(`${ADAPTER_KEY}: BUIDL chain balance diverges from Deloitte report by $${divergenceUsd.toFixed(2)}`);
  }

  return {
    blockNumber: block.number,
    blockHash: block.hash,
    blockTimestamp: block.timestamp,
    balanceUsd,
    balanceRaw,
    decimals,
    codeHash: keccak256(toBytes(code)),
  };
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

  const assurancePromise = fetchIndependentAssuranceReserves(coin, config, signal, PROFILE, params, ctx);
  const buidlPromise = readBuidlObservation(params, signal, ctx);
  const crossCheckPromise = readIssuerCrossCheck(params.issuerCrossCheckUrl, signal, ctx).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const [assurance, buidl, crossCheck] = await Promise.all([assurancePromise, buidlPromise, crossCheckPromise]);

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
      buidlOnchain: {
        chain: "avalanche",
        tokenAddress: params.avalancheBuidlToken,
        walletAddress: params.avalancheBuidlWallet,
        blockNumber: buidl.blockNumber,
        blockHash: buidl.blockHash,
        blockTimestamp: buidl.blockTimestamp,
        balanceRaw: buidl.balanceRaw.toString(),
        decimals: buidl.decimals,
        balanceUsd: buidl.balanceUsd,
        reportBalanceUsd: BUIDL_REPORT_AMOUNT_USD,
        divergenceUsd: buidl.balanceUsd - BUIDL_REPORT_AMOUNT_USD,
        codeHash: buidl.codeHash,
      },
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
