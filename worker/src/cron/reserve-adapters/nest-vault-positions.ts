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
  pendingTransactions?: unknown;
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

type NestPendingTransactionType = "PendingDeposit" | "PendingWithdrawal";

interface NestPendingTransactionValue {
  type: NestPendingTransactionType;
  positionKind: "liquid" | "yield";
  symbol: string;
  assetSlug?: string;
  amount: number;
  price: number;
  valueUsd: number;
}

const NOPAL_ASSET_ID = "nopal-nest";

function readParams(config: LiveReservesConfig): NestVaultPositionsParams {
  return parseLiveReserveAdapterParams("nest-vault-positions", config.params);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readValue(token: NestPositionToken): number {
  return parsePositiveNumericLike(token.position?.value) ?? 0;
}

function readNonNegativeNumericLike(value: unknown, label: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`nest-vault-positions invalid ${label}`);
  }
  return parsed;
}

function readPendingTransactions(
  token: NestPositionToken,
  positionKind: NestPendingTransactionValue["positionKind"],
  assetSlug?: string,
): NestPendingTransactionValue[] {
  if (!Array.isArray(token.pendingTransactions)) {
    throw new Error("nest-vault-positions missing pendingTransactions array");
  }
  const symbol = typeof token.symbol === "string" ? token.symbol : "Unknown";
  return token.pendingTransactions.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`nest-vault-positions invalid pendingTransactions[${index}] shape`);
    }
    const transaction = entry as {
      type?: unknown;
      amount?: unknown;
      price?: unknown;
      value?: unknown;
    };
    if (transaction.type !== "PendingDeposit" && transaction.type !== "PendingWithdrawal") {
      throw new Error(`nest-vault-positions unsupported pending transaction type: ${String(transaction.type)}`);
    }
    return {
      type: transaction.type,
      positionKind,
      symbol,
      ...(assetSlug ? { assetSlug } : {}),
      amount: readNonNegativeNumericLike(transaction.amount, `pending ${transaction.type} amount`),
      price: readNonNegativeNumericLike(transaction.price, `pending ${transaction.type} price`),
      valueUsd: readNonNegativeNumericLike(transaction.value, `pending ${transaction.type} value`),
    };
  });
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
      risk: "low",
      coinId: "jtrsy-anemoy",
    };
  }
  if (slug === "superstate-ustb" || symbol === "USTB") {
    return {
      value,
      name: "Superstate USTB Treasury Fund",
      risk: "low",
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
  coin: StablecoinMeta,
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

  const liquidTokens = asArray(positions.data?.positions?.liquidAssets)
    .map((token) => token as NestPositionToken);
  const yieldAssets = asArray(positions.data?.positions?.yieldAssets)
    .map((asset) => asset as NestYieldAsset);
  const liquidValues = liquidTokens.map(bucketLiquidToken);
  const yieldValues = yieldAssets.flatMap((asset) => asArray(asset.tokens)
    .map((token) => bucketYieldToken(asset, token as NestPositionToken)));
  const settledValues = mergeSliceValues([...liquidValues, ...yieldValues]);
  const settledPositionUsd = settledValues.reduce((sum, value) => sum + value.value, 0);
  if (settledPositionUsd <= 0) {
    throw new Error("nest-vault-positions produced zero reserve value");
  }

  const navUsd = parsePositiveNumericLike(price.data?.nav);
  const priceUsd = parsePositiveNumericLike(price.data?.price);
  const totalSupply = parsePositiveNumericLike(price.data?.totalSupply);
  const sourceTimestamp = readLatestTimestamp(lastPriceUpdate);
  const reconcileNopal = coin.id === NOPAL_ASSET_ID;
  if (reconcileNopal && navUsd == null) {
    throw new Error("nest-vault-positions missing nOPAL NAV");
  }
  const pendingTransactions = reconcileNopal
    ? [
        ...liquidTokens.flatMap((token) => readPendingTransactions(token, "liquid")),
        ...yieldAssets.flatMap((asset) => {
          const assetSlug = typeof asset.slug === "string" ? asset.slug : undefined;
          return asArray(asset.tokens)
            .flatMap((token) => readPendingTransactions(token as NestPositionToken, "yield", assetSlug));
        }),
      ]
    : [];
  const pendingDepositUsd = pendingTransactions
    .filter((transaction) => transaction.type === "PendingDeposit")
    .reduce((sum, transaction) => sum + transaction.valueUsd, 0);
  const pendingWithdrawalUsd = pendingTransactions
    .filter((transaction) => transaction.type === "PendingWithdrawal")
    .reduce((sum, transaction) => sum + transaction.valueUsd, 0);
  if (reconcileNopal && pendingWithdrawalUsd > 0) {
    throw new Error("nest-vault-positions cannot reconcile positive nOPAL pending withdrawals");
  }
  const navReconciliationResidualUsd =
    reconcileNopal ? navUsd! - settledPositionUsd - pendingDepositUsd : null;
  const values = mergeSliceValues([
    ...settledValues,
    ...(pendingDepositUsd > 0
      ? [{
          value: pendingDepositUsd,
          name: "Nest pending deposits",
          risk: "high" as const,
        }]
      : []),
    ...(navReconciliationResidualUsd != null && navReconciliationResidualUsd > 0
      ? [{
          value: navReconciliationResidualUsd,
          name: "Nest NAV reconciliation residual",
          risk: "high" as const,
        }]
      : []),
  ]);
  const totalReserveUsd = reconcileNopal ? navUsd! : settledPositionUsd;
  const navCoverageRatio = navUsd && navUsd > 0 ? settledPositionUsd / navUsd : null;
  const reconciledNavCoverageRatio =
    reconcileNopal && navUsd && navUsd > 0
      ? (settledPositionUsd + pendingDepositUsd) / navUsd
      : navCoverageRatio;
  const warnings = buildCoverageShortfallWarnings({
    code: "nest-nav-coverage-gap",
    message: (pct) => reconcileNopal
      ? `Nest settled positions plus pending deposits cover ${pct}% of reported NAV`
      : `Nest position values cover ${pct}% of reported NAV`,
    coverageRatio: reconciledNavCoverageRatio,
    thresholdRatio: 0.99,
  });

  return {
    slices: slicesFromValues(values),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      details: {
        proofKind: "nest-vault-positions-api",
        ...(reconcileNopal
          ? {
              reconciliationKind: "settled-plus-pending-deposits-plus-residual-equals-nav",
              pendingTransactions,
            }
          : {}),
      },
      totalReserveUsd,
      ...(reconcileNopal
        ? {
            settledPositionUsd,
            pendingDepositUsd,
            pendingWithdrawalUsd,
            navReconciliationResidualUsd,
          }
        : {}),
      ...(navUsd != null ? { navUsd } : {}),
      ...(priceUsd != null ? { priceUsd } : {}),
      ...(totalSupply != null ? { totalSupply } : {}),
      ...(navCoverageRatio != null ? { navCoverageRatio } : {}),
      ...(reconcileNopal && reconciledNavCoverageRatio != null
        ? { reconciledNavCoverageRatio }
        : {}),
    },
  };
}
