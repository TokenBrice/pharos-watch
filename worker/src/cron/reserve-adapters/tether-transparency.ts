import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonAdapterInput,
  parseFiniteNumber,
  parseTimestampLikeToUnixSeconds,
  reserveInfoWarning,
  assertFiniteNonNegativeReserveRows,
  verifiedFreshnessMetadata,
} from "./helpers";

const ADAPTER_NAME = "tether-transparency";

interface TetherBlockChainEntry {
  name?: unknown;
  totalAuthorized?: unknown;
  notIssued?: unknown;
  quarantined?: unknown;
}

interface TetherDataFormattedEntry {
  id?: unknown;
  iso?: unknown;
  total_assets?: unknown;
  total_liabilities?: unknown;
  shareholder_eq?: unknown;
  blockChains?: unknown;
}

export interface TetherTransparencyResponse {
  data_formatted?: TetherDataFormattedEntry[];
}

type ChainAmountReason = "missing" | "malformed" | "negative";

interface TetherChainDetail {
  name: string | null;
  nameReason: "missing" | "malformed" | null;
  totalAuthorized: number | null;
  totalAuthorizedReason: ChainAmountReason | null;
  notIssued: number | null;
  notIssuedReason: ChainAmountReason | null;
  issued: number | null;
  issuedReason: "authorization-unavailable" | "not-issued-unavailable" | "not-issued-exceeds-authorized" | null;
  quarantined: number | null;
  quarantinedReason: ChainAmountReason | null;
}

function parseAmount(value: unknown): number {
  try {
    return parseFiniteNumber(value, { label: "tether amount" });
  } catch {
    return Number.NaN;
  }
}

function findEntry(
  entries: TetherDataFormattedEntry[],
  currencyIso: string,
): TetherDataFormattedEntry | undefined {
  return entries.find((entry) => typeof entry.iso === "string" && entry.iso.trim().toLowerCase() === currencyIso);
}

function parseChainAmount(value: unknown): { value: number | null; reason: ChainAmountReason | null } {
  if (value == null) return { value: null, reason: "missing" };
  const amount = parseAmount(value);
  if (!Number.isFinite(amount)) return { value: null, reason: "malformed" };
  if (amount < 0) return { value: null, reason: "negative" };
  return { value: amount, reason: null };
}

function buildChainDetails(blockChains: unknown): {
  chains: TetherChainDetail[] | null;
  chainsReason: "missing" | "malformed" | null;
} {
  if (!Array.isArray(blockChains)) {
    return { chains: null, chainsReason: blockChains == null ? "missing" : "malformed" };
  }

  const chains: TetherChainDetail[] = [];
  for (const raw of blockChains) {
    const row: TetherBlockChainEntry =
      raw != null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const totalAuthorized = parseChainAmount(row.totalAuthorized);
    const notIssued = parseChainAmount(row.notIssued);
    const quarantined = parseChainAmount(row.quarantined);
    const issuedReason = totalAuthorized.value == null
      ? "authorization-unavailable"
      : notIssued.value == null
        ? "not-issued-unavailable"
        : notIssued.value > totalAuthorized.value
          ? "not-issued-exceeds-authorized"
          : null;

    chains.push({
      name: name || null,
      nameReason: name ? null : row.name == null ? "missing" : "malformed",
      totalAuthorized: totalAuthorized.value,
      totalAuthorizedReason: totalAuthorized.reason,
      notIssued: notIssued.value,
      notIssuedReason: notIssued.reason,
      issued: issuedReason == null ? totalAuthorized.value! - notIssued.value! : null,
      issuedReason,
      quarantined: quarantined.value,
      quarantinedReason: quarantined.reason,
    });
  }

  return { chains, chainsReason: null };
}

export interface TetherTransparencyParams {
  currencyIso: "usdt" | "xaut";
  slices: ReserveSlice[];
  compositionAsOf?: string;
}

export function adaptTetherTransparency(
  payload: TetherTransparencyResponse,
  params: TetherTransparencyParams,
): AdapterResult {
  const entries = payload.data_formatted;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${ADAPTER_NAME} payload is missing data_formatted entries`);
  }

  const entry = findEntry(entries, params.currencyIso);
  if (!entry) {
    throw new Error(`${ADAPTER_NAME} payload has no data_formatted entry for currencyIso "${params.currencyIso}"`);
  }

  const totalAssets = parseAmount(entry.total_assets);
  const totalLiabilities = parseAmount(entry.total_liabilities);
  if (!(totalAssets > 0) || !(totalLiabilities > 0)) {
    throw new Error(`${ADAPTER_NAME} entry "${params.currencyIso}" has invalid total_assets/total_liabilities`);
  }

  const sourceTimestamp = parseTimestampLikeToUnixSeconds(entry.id);
  if (sourceTimestamp == null) {
    throw new Error(`${ADAPTER_NAME} entry "${params.currencyIso}" has an unreadable id timestamp`);
  }

  const chainDetails = buildChainDetails(entry.blockChains);
  const shareholderEquityUsd = parseAmount(entry.shareholder_eq);

  const warnings: LiveReserveWarning[] = [];
  const quarantinedChains = chainDetails.chains?.filter((chain) => chain.quarantined != null && chain.quarantined > 0) ?? [];
  if (quarantinedChains.length > 0) {
    warnings.push(
      reserveInfoWarning(
        "quarantined-balance",
        `Tether reports a nonzero quarantined ${params.currencyIso.toUpperCase()} balance on ${quarantinedChains.map((chain) => chain.name ?? "unknown chain").join(", ")}`,
      ),
    );
  }
  assertFiniteNonNegativeReserveRows(params.slices, (slice) => slice.pct, `${ADAPTER_NAME} configured reserve composition`);
  const compositionTotal = params.slices.reduce((sum, slice) => sum + slice.pct, 0);
  if (compositionTotal <= 0 || Math.abs(compositionTotal - 100) > 1.5) {
    throw new Error(`${ADAPTER_NAME} configured reserve composition must sum to 100% ± 1.5%`);
  }

  return {
    // Keep positive sub-display-precision categories without allocating a rounding residual.
    slices: params.slices.filter((slice) => slice.pct > 0),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      diag: { rawSumDeviation: Math.abs(compositionTotal - 100) },
      ...verifiedFreshnessMetadata(sourceTimestamp),
      collateralizationRatio: totalAssets / totalLiabilities,
      ...(params.currencyIso === "usdt"
        ? {
            totalAssetsUsd: totalAssets,
            totalLiabilitiesUsd: totalLiabilities,
            ...(Number.isFinite(shareholderEquityUsd) ? { shareholderEquityUsd } : {}),
          }
        : {}),
      details: {
        ...chainDetails,
        compositionSource: "reviewed-config",
        ...(params.compositionAsOf ? { compositionAsOf: params.compositionAsOf } : {}),
      },
    },
  };
}

export async function fetchTetherTransparencyReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const payload = await fetchJsonAdapterInput<TetherTransparencyResponse>(config, ADAPTER_NAME, signal, 12_000, ctx);
  const params = parseLiveReserveAdapterParams("tether-transparency", config.params);
  return adaptTetherTransparency(payload, params);
}
