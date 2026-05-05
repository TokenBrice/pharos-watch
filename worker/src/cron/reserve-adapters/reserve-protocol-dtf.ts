import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildUnknownExposureWarning,
  computeUnknownExposurePct,
  fetchJsonWithRetry,
  parsePositiveNumericLike,
  requireJsonInputFromConfig,
  reserveInfoWarning,
  slicesFromPercentages,
  unverifiedFreshnessMetadata,
} from "./helpers";

interface ReserveProtocolDtfBasketEntry {
  address?: string;
  symbol?: string;
  name?: string;
  weight?: string | number;
}

interface ReserveProtocolDtfRow {
  address?: string;
  name?: string;
  symbol?: string;
  price?: number;
  marketCap?: number;
  chainId?: number;
  type?: string;
  status?: string;
  basket?: ReserveProtocolDtfBasketEntry[];
}

interface ReserveProtocolDtfAssetDescriptor {
  address: string;
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  blacklistable?: boolean;
}

function normalizeAddress(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && /^0x[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
}

function buildDescriptorMap(assets: readonly ReserveProtocolDtfAssetDescriptor[] | undefined): Map<string, ReserveProtocolDtfAssetDescriptor> {
  const descriptors = new Map<string, ReserveProtocolDtfAssetDescriptor>();
  for (const asset of assets ?? []) {
    const address = normalizeAddress(asset.address);
    if (address) descriptors.set(address, asset);
  }
  return descriptors;
}

function findDtfRow(
  rows: readonly ReserveProtocolDtfRow[],
  coin: StablecoinMeta,
): ReserveProtocolDtfRow | null {
  const contractAddresses = new Set(
    (coin.contracts ?? [])
      .map((contract) => normalizeAddress(contract.address))
      .filter((address): address is string => address != null),
  );

  for (const row of rows) {
    const address = normalizeAddress(row.address);
    if (address && contractAddresses.has(address)) return row;
  }

  const expectedSymbol = coin.symbol.toLowerCase();
  return rows.find((row) => row.symbol?.trim().toLowerCase() === expectedSymbol) ?? null;
}

function parseDtfRows(payload: unknown): ReserveProtocolDtfRow[] {
  if (!Array.isArray(payload)) {
    throw new Error("reserve-protocol-dtf adapter expected the DTF discovery payload to be an array");
  }
  return payload as ReserveProtocolDtfRow[];
}

export function adaptReserveProtocolDtfRows(
  payload: unknown,
  coin: StablecoinMeta,
  assets: readonly ReserveProtocolDtfAssetDescriptor[] | undefined,
  sourceUrl: string,
): AdapterResult {
  const rows = parseDtfRows(payload);
  const dtf = findDtfRow(rows, coin);
  if (!dtf) {
    throw new Error(`reserve-protocol-dtf could not find ${coin.id} in Reserve Protocol discovery payload`);
  }

  const descriptorByAddress = buildDescriptorMap(assets);
  const values: Array<{
    pct: number;
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
    depType?: ReserveSlice["depType"];
    blacklistable?: boolean;
  }> = [];
  const warnings: LiveReserveWarning[] = [];
  let unknownWeight = 0;
  let totalWeight = 0;

  for (const component of dtf.basket ?? []) {
    const pct = parsePositiveNumericLike(component.weight);
    if (pct == null) continue;
    totalWeight += pct;

    const address = normalizeAddress(component.address);
    const descriptor = address ? descriptorByAddress.get(address) : undefined;
    if (!descriptor) {
      unknownWeight += pct;
      values.push({
        pct,
        name: `Unmapped Reserve Protocol DTF asset: ${component.symbol ?? component.name ?? component.address ?? "unknown"}`,
        risk: "high",
      });
      continue;
    }

    values.push({
      pct,
      name: descriptor.name,
      risk: descriptor.risk,
      coinId: descriptor.coinId,
      depType: descriptor.depType,
      blacklistable: descriptor.blacklistable,
    });
  }

  if (values.length === 0) {
    throw new Error(`reserve-protocol-dtf found no positive basket weights for ${coin.id}`);
  }

  const unknownExposurePct = computeUnknownExposurePct(unknownWeight, totalWeight);
  if (unknownExposurePct > 0) {
    warnings.push(buildUnknownExposureWarning({
      code: "reserve-protocol-dtf-unknown-component",
      message: "Unmapped Reserve Protocol DTF basket components",
      unknownExposurePct,
    }));
  }
  if (dtf.status && dtf.status !== "active") {
    warnings.push(reserveInfoWarning(
      "reserve-protocol-dtf-status",
      `Reserve Protocol reports DTF status "${dtf.status}"`,
    ));
  }

  const freshness = unverifiedFreshnessMetadata(
    "reserve-protocol-api",
    "Reserve Protocol DTF discovery payload does not expose a source timestamp",
  );

  return {
    slices: slicesFromPercentages(values, {
      decimals: 1,
      tolerancePct: 2,
      context: `${coin.id} Reserve Protocol basket`,
    }),
    warnings,
    metadata: {
      ...freshness,
      unknownExposurePct,
      marketPriceUsd: parsePositiveNumericLike(dtf.price) ?? undefined,
      marketCapUsd: parsePositiveNumericLike(dtf.marketCap) ?? undefined,
      chainId: dtf.chainId,
      dtfStatus: dtf.status,
      dtfType: dtf.type,
      componentCount: values.length,
      details: {
        ...freshness.details,
        sourceUrl,
        dtfAddress: dtf.address,
        dtfSymbol: dtf.symbol,
      },
    },
  };
}

export async function fetchReserveProtocolDtfReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInputFromConfig(config, "reserve-protocol-dtf");
  const params = parseLiveReserveAdapterParams("reserve-protocol-dtf", config.params);
  const payload = await fetchJsonWithRetry<unknown>(input.url, signal, 10_000, ctx);
  return adaptReserveProtocolDtfRows(payload, coin, params.assets, input.url);
}
