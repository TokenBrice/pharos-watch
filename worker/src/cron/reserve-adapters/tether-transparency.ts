import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  parseTimestampLikeToUnixSeconds,
  reserveInfoWarning,
  requireJsonInputFromConfig,
  slicesFromPercentages,
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

interface TetherChainDetail {
  name: string;
  issued: number;
  quarantined: number;
}

/** tether.to reports amounts as a mix of raw numbers and numeric strings across
 *  currencies/chains within the same payload; parse either defensively. */
function parseAmount(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return Number.NaN;
    return Number(trimmed);
  }
  return Number.NaN;
}

function findEntry(
  entries: TetherDataFormattedEntry[],
  currencyIso: string,
): TetherDataFormattedEntry | undefined {
  return entries.find((entry) => typeof entry.iso === "string" && entry.iso.trim().toLowerCase() === currencyIso);
}

function buildChainDetails(blockChains: unknown): { chains: TetherChainDetail[]; totalQuarantined: number } {
  const chains: TetherChainDetail[] = [];
  let totalQuarantined = 0;
  if (!Array.isArray(blockChains)) {
    return { chains, totalQuarantined };
  }

  for (const raw of blockChains as TetherBlockChainEntry[]) {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const totalAuthorized = parseAmount(raw.totalAuthorized);
    if (!name || !Number.isFinite(totalAuthorized) || totalAuthorized <= 0) continue;

    const notIssued = parseAmount(raw.notIssued);
    const quarantined = parseAmount(raw.quarantined);
    const safeNotIssued = Number.isFinite(notIssued) ? notIssued : 0;
    const safeQuarantined = Number.isFinite(quarantined) ? quarantined : 0;

    chains.push({
      name,
      issued: Math.max(0, totalAuthorized - safeNotIssued),
      quarantined: safeQuarantined,
    });
    totalQuarantined += safeQuarantined;
  }

  return { chains, totalQuarantined };
}

export interface TetherTransparencyParams {
  currencyIso: "usdt" | "xaut";
  slices: ReserveSlice[];
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

  const { chains, totalQuarantined } = buildChainDetails(entry.blockChains);
  const shareholderEquityUsd = parseAmount(entry.shareholder_eq);

  const warnings: LiveReserveWarning[] = [];
  if (totalQuarantined > 0) {
    const quarantinedChains = chains.filter((chain) => chain.quarantined > 0).map((chain) => chain.name);
    warnings.push(
      reserveInfoWarning(
        "quarantined-balance",
        `Tether reports a nonzero quarantined ${params.currencyIso.toUpperCase()} balance on ${quarantinedChains.join(", ")}`,
      ),
    );
  }

  return {
    slices: slicesFromPercentages(params.slices, {
      context: `${ADAPTER_NAME} configured reserve composition`,
    }),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      collateralizationRatio: totalAssets / totalLiabilities,
      ...(params.currencyIso === "usdt"
        ? {
            totalAssetsUsd: totalAssets,
            totalLiabilitiesUsd: totalLiabilities,
            ...(Number.isFinite(shareholderEquityUsd) ? { shareholderEquityUsd } : {}),
          }
        : {}),
      details: { chains },
    },
  };
}

export async function fetchTetherTransparencyReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInputFromConfig(config, ADAPTER_NAME);
  const payload = await fetchJsonWithRetry<TetherTransparencyResponse>(input.url, signal, 12_000, ctx);
  const params = parseLiveReserveAdapterParams("tether-transparency", config.params);
  return adaptTetherTransparency(payload, params);
}
