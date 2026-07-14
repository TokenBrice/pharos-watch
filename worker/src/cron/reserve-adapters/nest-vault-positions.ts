import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildCoverageShortfallWarnings,
  fetchJsonWithRetry,
  parsePositiveNumericLike,
  slicesFromValues,
  verifiedFreshnessMetadata,
} from "./helpers";

interface NestVaultPositionsParams {
  priceUrl: string;
  lastPriceUpdateUrl: string;
}

interface NestPositionToken {
  symbol?: unknown;
  position?: {
    value?: unknown;
  };
}

interface NestYieldAsset {
  slug?: unknown;
  tokens?: unknown;
}

interface NestPositionsPayload {
  data?: {
    positions?: {
      liquidAssets?: unknown;
      yieldAssets?: unknown;
    };
  };
}

interface NestPricePayload {
  data?: {
    nav?: unknown;
    price?: unknown;
    totalSupply?: unknown;
  };
}

interface NestLastPriceUpdatePayload {
  data?: {
    lastPriceUpdates?: unknown;
  };
}

interface SliceValue {
  value: number;
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

function readParams(config: LiveReservesConfig): NestVaultPositionsParams {
  return parseLiveReserveAdapterParams("nest-vault-positions", config.params);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readValue(token: NestPositionToken): number {
  return parsePositiveNumericLike(token.position?.value) ?? 0;
}

function bucketLiquidToken(token: NestPositionToken): SliceValue {
  const symbol = typeof token.symbol === "string" ? token.symbol : "Unknown";
  const value = readValue(token);
  if (symbol === "USDC" || symbol === "USDC.e") {
    return {
      value,
      name: "Liquid USDC balances",
      risk: "low",
      coinId: "usdc-circle",
    };
  }
  if (symbol === "USDT" || symbol === "USDT0") {
    return {
      value,
      name: "Liquid USDT balances",
      risk: "low",
      coinId: "usdt-tether",
    };
  }
  if (symbol === "pUSD") {
    return {
      value,
      name: "pUSD liquid balance",
      risk: "high",
      coinId: "pusd-plume",
    };
  }
  return {
    value,
    name: `${symbol} liquid balance`,
    risk: "high",
  };
}

function bucketYieldToken(asset: NestYieldAsset, token: NestPositionToken): SliceValue {
  const slug = typeof asset.slug === "string" ? asset.slug : "";
  const symbol = typeof token.symbol === "string" ? token.symbol : "Unknown";
  const value = readValue(token);
  if (slug === "nest-treasury-vault" || symbol === "nTBILL") {
    return {
      value,
      name: "Nest Treasury vault (nTBILL)",
      risk: "low",
      coinId: "ntbill-nest",
    };
  }
  if (slug === "janus-henderson-fund" || symbol === "JTRSY") {
    return {
      value,
      name: "Janus Henderson Anemoy Treasury Fund (JTRSY)",
      risk: "very-low",
      coinId: "jtrsy-anemoy",
    };
  }
  if (slug === "superstate-ustb" || symbol === "USTB") {
    return {
      value,
      name: "Superstate USTB Treasury Fund",
      risk: "very-low",
      coinId: "ustb-superstate",
    };
  }
  if (slug === "superstate-uscc" || symbol === "USCC") {
    return {
      value,
      name: "Superstate USCC cash-and-carry fund",
      risk: "low",
    };
  }
  return {
    value,
    name: "Nest private and structured credit vaults",
    risk: "high",
  };
}

function mergeSliceValues(values: SliceValue[]): SliceValue[] {
  const merged = new Map<string, SliceValue>();
  for (const value of values) {
    const key = [
      value.name,
      value.risk,
      value.coinId ?? "",
      value.depType ?? "",
    ].join("|");
    const existing = merged.get(key);
    if (existing) {
      existing.value += value.value;
    } else {
      merged.set(key, { ...value });
    }
  }
  return [...merged.values()];
}

function readLatestTimestamp(payload: NestLastPriceUpdatePayload): number {
  const updates = asArray(payload.data?.lastPriceUpdates);
  const timestamps = updates
    .map((update) => {
      if (!update || typeof update !== "object") return null;
      return parsePositiveNumericLike((update as { updatedAt?: unknown }).updatedAt);
    })
    .filter((value): value is number => value != null && Number.isFinite(value));
  const latest = Math.max(...timestamps);
  if (!Number.isFinite(latest) || latest <= 0) {
    throw new Error("nest-vault-positions missing last price update timestamp");
  }
  return Math.floor(latest);
}

export async function fetchNestVaultPositionsReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primary = config.inputs.primary;
  if (primary.kind !== "http-json") {
    throw new Error("nest-vault-positions requires http-json input");
  }
  const params = readParams(config);
  const [positions, price, lastPriceUpdate] = await Promise.all([
    fetchJsonWithRetry<NestPositionsPayload>(primary.url, signal, 12_000, ctx),
    fetchJsonWithRetry<NestPricePayload>(params.priceUrl, signal, 12_000, ctx),
    fetchJsonWithRetry<NestLastPriceUpdatePayload>(params.lastPriceUpdateUrl, signal, 12_000, ctx),
  ]);

  const liquidValues = asArray(positions.data?.positions?.liquidAssets)
    .map((token) => bucketLiquidToken(token as NestPositionToken));
  const yieldValues = asArray(positions.data?.positions?.yieldAssets)
    .flatMap((asset) => asArray((asset as NestYieldAsset).tokens)
      .map((token) => bucketYieldToken(asset as NestYieldAsset, token as NestPositionToken)));
  const values = mergeSliceValues([...liquidValues, ...yieldValues]);
  const totalReserveUsd = values.reduce((sum, value) => sum + value.value, 0);
  if (totalReserveUsd <= 0) {
    throw new Error("nest-vault-positions produced zero reserve value");
  }

  const navUsd = parsePositiveNumericLike(price.data?.nav);
  const priceUsd = parsePositiveNumericLike(price.data?.price);
  const totalSupply = parsePositiveNumericLike(price.data?.totalSupply);
  const sourceTimestamp = readLatestTimestamp(lastPriceUpdate);
  const navCoverageRatio = navUsd && navUsd > 0 ? totalReserveUsd / navUsd : null;
  const warnings = buildCoverageShortfallWarnings({
    code: "nest-nav-coverage-gap",
    message: (pct) => `Nest position values cover ${pct}% of reported NAV`,
    coverageRatio: navCoverageRatio,
    thresholdRatio: 0.99,
  });

  return {
    slices: slicesFromValues(values),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      details: {
        proofKind: "nest-vault-positions-api",
      },
      totalReserveUsd,
      ...(navUsd != null ? { navUsd } : {}),
      ...(priceUsd != null ? { priceUsd } : {}),
      ...(totalSupply != null ? { totalSupply } : {}),
      ...(navCoverageRatio != null ? { navCoverageRatio } : {}),
    },
  };
}
