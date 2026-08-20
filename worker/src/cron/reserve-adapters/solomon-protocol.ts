import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonAdapterInput,
  freshnessMetadataFromTimestamp,
  parseTimestampLikeToUnixSeconds,
  slicesFromValues,
} from "./helpers";

interface SolomonAssetRow {
  name?: string;
  asset?: string;
  amount?: string | number;
  amountUsd?: string | number;
  exchange?: string;
  baseAsset?: string;
  notionalUsd?: string | number;
}

export interface SolomonProtocolDataResponse {
  protocolTvl?: string | number;
  custodyNotionalUsd?: string | number;
  vaultNotionalUsd?: string | number;
  yieldDistributorsNotionalUsd?: string | number;
  reserveFundNotionalUsd?: string | number;
  positionsNotionalUsd?: string | number;
  createdAt?: string;
  updatedAt?: string;
  dataValidForTimestamp?: string | number;
  custody?: SolomonAssetRow[];
  vault?: SolomonAssetRow[];
  yieldDistributors?: SolomonAssetRow[];
  reserveFund?: SolomonAssetRow[];
  positions?: SolomonAssetRow[];
}

function parseUsd(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`solomon-protocol missing/invalid ${field}`);
}

function optionalUsd(value: unknown): number {
  if (value == null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function rowUsd(row: SolomonAssetRow): number {
  return optionalUsd(row.amountUsd);
}

function custodySliceName(asset: string): { name: string; risk: "medium" | "high" } {
  const upper = asset.toUpperCase();
  if (upper === "BTC") {
    return {
      name: "Ceffu-custodied BTC with Binance inverse-perpetual hedge",
      risk: "medium",
    };
  }
  if (upper === "SOL") {
    return {
      name: "Ceffu-custodied SOL with Binance inverse-perpetual hedge",
      risk: "high",
    };
  }
  return {
    name: `Ceffu-custodied ${upper} with exchange hedge`,
    risk: "high",
  };
}

/**
 * Live Solomon USDv composition from the issuer protocol-data API.
 * Custody/vault/yield-distributor balances are itemized; any residual of
 * protocolTvl that the API does not attribute is kept as an explicit
 * unmapped slice rather than dropped or renormalized away.
 */
export function adaptSolomonProtocolData(payload: SolomonProtocolDataResponse): AdapterResult {
  const protocolTvl = parseUsd(payload.protocolTvl, "protocolTvl");
  if (protocolTvl <= 0) {
    throw new Error("solomon-protocol protocolTvl must be positive");
  }

  const values: Array<{
    name: string;
    value: number;
    risk: "low" | "medium" | "high" | "very-high";
    coinId?: string;
    depType?: "collateral";
    blacklistable?: boolean;
  }> = [];

  for (const row of payload.custody ?? []) {
    const usd = rowUsd(row);
    if (usd <= 0) continue;
    const asset = typeof row.asset === "string" && row.asset.trim() ? row.asset.trim() : "asset";
    const mapped = custodySliceName(asset);
    values.push({ name: mapped.name, value: usd, risk: mapped.risk });
  }

  let usdcUsd = 0;
  let usdtUsd = 0;
  let otherVaultUsd = 0;
  for (const row of [...(payload.vault ?? []), ...(payload.yieldDistributors ?? [])]) {
    const usd = rowUsd(row);
    if (usd <= 0) continue;
    const asset = (row.asset ?? "").toUpperCase();
    if (asset === "USDC") usdcUsd += usd;
    else if (asset === "USDT") usdtUsd += usd;
    else otherVaultUsd += usd;
  }
  if (usdcUsd > 0) {
    values.push({
      name: "USDC on-chain vault and yield-distributor balances",
      value: usdcUsd,
      risk: "low",
      coinId: "usdc-circle",
      depType: "collateral",
      blacklistable: true,
    });
  }
  if (usdtUsd > 0) {
    values.push({
      name: "USDT on-chain vault balance",
      value: usdtUsd,
      risk: "low",
      coinId: "usdt-tether",
      depType: "collateral",
      blacklistable: true,
    });
  }
  if (otherVaultUsd > 0) {
    values.push({
      name: "Other on-chain vault balances",
      value: otherVaultUsd,
      risk: "medium",
    });
  }

  for (const row of payload.reserveFund ?? []) {
    const usd = rowUsd(row);
    if (usd <= 0) continue;
    const asset = typeof row.asset === "string" && row.asset.trim() ? row.asset.trim() : "reserve";
    values.push({
      name: `Reserve fund ${asset}`,
      value: usd,
      risk: "medium",
    });
  }

  const identifiedUsd = values.reduce((sum, entry) => sum + entry.value, 0);
  const residualUsd = protocolTvl - identifiedUsd;
  // Cent-level float noise is ignored; a material residual stays visible.
  if (residualUsd > 1) {
    values.push({
      name: "Unmapped reserve positions (issuer API does not reconcile reserves to supply)",
      value: residualUsd,
      risk: "very-high",
    });
  } else if (residualUsd < -1) {
    throw new Error(
      `solomon-protocol identified components ($${identifiedUsd.toFixed(2)}) exceed protocolTvl ($${protocolTvl.toFixed(2)})`,
    );
  }

  const slices = slicesFromValues(values);
  if (slices.length === 0) {
    throw new Error("solomon-protocol produced no positive reserve slices");
  }

  // `dataValidForTimestamp` is the moment the reserve data is valid for;
  // `updatedAt`/`createdAt` are row-serving timestamps that can advance while
  // the underlying data stays stale, so they are only fallbacks.
  const sourceTimestamp =
    parseTimestampLikeToUnixSeconds(payload.dataValidForTimestamp)
    ?? parseTimestampLikeToUnixSeconds(payload.updatedAt)
    ?? parseTimestampLikeToUnixSeconds(payload.createdAt);


  return {
    slices,
    metadata: {
      protocolTvl,
      identifiedUsd,
      residualUsd: Math.max(0, residualUsd),
      custodyNotionalUsd: optionalUsd(payload.custodyNotionalUsd),
      vaultNotionalUsd: optionalUsd(payload.vaultNotionalUsd),
      yieldDistributorsNotionalUsd: optionalUsd(payload.yieldDistributorsNotionalUsd),
      reserveFundNotionalUsd: optionalUsd(payload.reserveFundNotionalUsd),
      // Hedge notional is informational; custody carries the reserve claim.
      positionsNotionalUsd: optionalUsd(payload.positionsNotionalUsd),
      positionCount: Array.isArray(payload.positions) ? payload.positions.length : 0,
      supplyUsd: protocolTvl,
      updatedAt: payload.updatedAt,
      dataValidForTimestamp: payload.dataValidForTimestamp,
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "issuer-api",
        "Solomon protocol-data payload did not expose a trustworthy source timestamp",
      ),
    },
  };
}

export async function fetchSolomonProtocolReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const payload = await fetchJsonAdapterInput<SolomonProtocolDataResponse>(
    config,
    "solomon-protocol",
    signal,
    12_000,
    ctx,
  );
  return adaptSolomonProtocolData(payload);
}
