import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildCoverageShortfallWarnings,
  fetchJsonWithRetry,
  parseFiniteNumber,
  parsePositiveNumericLike,
  slicesFromValues,
  strictAmountParser,
  verifiedFreshnessMetadata,
} from "./helpers";

type NestVaultPositionsParams = LiveReserveAdapterParamsByKey["nest-vault-positions"];

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
    errors?: unknown;
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
  sourceKey?: string;
  value: number;
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  unknown?: boolean;
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

// These vaults publish explicit pending deposits alongside settled positions.
const PENDING_DEPOSIT_VAULTS = new Set(["nopal-nest", "nbasis-nest"]);

/**
 * `/price.nav` and `/calculated-price` are two valuations of the same vault, so
 * a pending-withdrawal reconciliation that rebuilds one of them from
 * `/positions` must agree with the other. Live reads differ by $0.13 on a
 * $184k NAV (fee accrual timing), far inside this bound; a real cross-source
 * contradiction is orders of magnitude larger. Mirrors the Avant NAV
 * cross-check: 1e-4 relative with a $1 absolute floor.
 */
const NAV_RECONCILIATION_RELATIVE_TOLERANCE = 1e-4;
const NAV_RECONCILIATION_ABSOLUTE_TOLERANCE_USD = 1;
const parsePositionValue = strictAmountParser("nest-vault-positions");

function readParams(config: LiveReservesConfig): NestVaultPositionsParams {
  return parseLiveReserveAdapterParams("nest-vault-positions", config.params);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requirePositionArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`nest-vault-positions missing or invalid ${label} array`);
  }
  return value;
}

function readValue(token: NestPositionToken): number {
  const symbol = typeof token.symbol === "string" ? token.symbol : "Unknown";
  const value = parsePositionValue(token.position?.value, `${symbol} position value`);
  if (value < 0) {
    throw new Error(`nest-vault-positions ${symbol} position value is negative`);
  }
  return value;
}

function readNonNegativeNumericLike(value: unknown, label: string): number {
  try {
    return parseFiniteNumber(value, { label, min: 0 });
  } catch {
    throw new Error(`nest-vault-positions invalid ${label}`);
  }
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

const USDC_METADATA: Omit<SliceValue, "value"> = {
  sourceKey: "nest-vault-positions:usdc",
  name: "Liquid USDC balances",
  risk: "low",
  coinId: "usdc-circle",
  depType: "collateral",
};
const USDT_METADATA: Omit<SliceValue, "value"> = {
  sourceKey: "nest-vault-positions:usdt",
  name: "Liquid USDT balances",
  risk: "low",
  coinId: "usdt-tether",
  depType: "collateral",
};
const LIQUID_TOKEN_METADATA: Readonly<Record<string, Omit<SliceValue, "value">>> = {
  USDC: USDC_METADATA,
  "USDC.e": USDC_METADATA,
  USDT: USDT_METADATA,
  USDT0: USDT_METADATA,
  pUSD: {
    sourceKey: "nest-vault-positions:pusd",
    name: "pUSD liquid balance",
    risk: "high",
    coinId: "pusd-plume",
    depType: "collateral",
  },
  USDG: {
    sourceKey: "nest-vault-positions:usdg",
    name: "USDG liquid balance",
    risk: "low",
    coinId: "usdg-paxos",
    depType: "collateral",
  },
};

// First matching slug OR symbol wins, including conflicting known aliases.
const YIELD_TOKEN_METADATA: ReadonlyArray<{
  slug: string;
  symbol: string;
  metadata: Omit<SliceValue, "value">;
}> = [
  {
    slug: "nest-treasury-vault",
    symbol: "nTBILL",
    metadata: {
      sourceKey: "nest-vault-positions:ntbill",
      name: "Nest Treasury vault (nTBILL)",
      risk: "low",
      coinId: "ntbill-nest",
      depType: "collateral",
    },
  },
  {
    slug: "janus-henderson-fund",
    symbol: "JTRSY",
    metadata: {
      sourceKey: "nest-vault-positions:jtrsy",
      name: "Janus Henderson Anemoy Treasury Fund (JTRSY)",
      risk: "low",
      coinId: "jtrsy-anemoy",
      depType: "collateral",
    },
  },
  {
    slug: "superstate-ustb",
    symbol: "USTB",
    metadata: {
      sourceKey: "nest-vault-positions:ustb",
      name: "Superstate USTB Treasury Fund",
      risk: "low",
      coinId: "ustb-superstate",
      depType: "collateral",
    },
  },
  {
    slug: "superstate-uscc",
    symbol: "USCC",
    metadata: {
      sourceKey: "nest-vault-positions:uscc",
      name: "Superstate USCC cash-and-carry fund",
      risk: "low",
    },
  },
];

function bucketLiquidToken(token: NestPositionToken): SliceValue {
  const symbol = typeof token.symbol === "string" ? token.symbol : "Unknown";
  const value = readValue(token);
  const metadata = Object.prototype.hasOwnProperty.call(LIQUID_TOKEN_METADATA, symbol)
    ? LIQUID_TOKEN_METADATA[symbol]
    : undefined;
  if (metadata) return { ...metadata, value };
  return {
    sourceKey: "nest-vault-positions:unknown",
    value,
    name: `${symbol} liquid balance`,
    risk: "high",
    unknown: true,
  };
}

function bucketYieldToken(asset: NestYieldAsset, token: NestPositionToken): SliceValue {
  const slug = typeof asset.slug === "string" ? asset.slug : "";
  const symbol = typeof token.symbol === "string" ? token.symbol : "Unknown";
  const value = readValue(token);
  const metadata = YIELD_TOKEN_METADATA.find((entry) => entry.slug === slug || entry.symbol === symbol)?.metadata;
  if (metadata) return { ...metadata, value };
  return {
    sourceKey: "nest-vault-positions:credit-vaults",
    value,
    name: "Nest private and structured credit vaults",
    risk: "high",
    unknown: true,
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
  coin: ReserveAdapterCoin,
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

  const errors = positions.data?.errors;
  if (errors !== undefined && (!Array.isArray(errors) || errors.length > 0)) {
    throw new Error("nest-vault-positions positions-errors");
  }
  const liquidTokens = requirePositionArray(positions.data?.positions?.liquidAssets, "liquidAssets") as NestPositionToken[];
  const yieldAssets = requirePositionArray(positions.data?.positions?.yieldAssets, "yieldAssets") as Array<
    NestYieldAsset & { tokens: NestPositionToken[] }
  >;
  for (const asset of yieldAssets) {
    requirePositionArray(asset?.tokens, "yield asset tokens");
  }
  const liquidValues = liquidTokens.map(bucketLiquidToken);
  const yieldValues = yieldAssets.flatMap((asset) => asset.tokens
    .map((token) => bucketYieldToken(asset, token)));
  const settledValues = mergeSliceValues([...liquidValues, ...yieldValues]);
  const settledPositionUsd = settledValues.reduce((sum, value) => sum + value.value, 0);
  if (settledPositionUsd <= 0) {
    throw new Error("nest-vault-positions produced zero reserve value");
  }

  const navUsd = parsePositiveNumericLike(price.data?.nav);
  const priceUsd = parsePositiveNumericLike(price.data?.price);
  const totalSupply = parsePositiveNumericLike(price.data?.totalSupply);
  const sourceTimestamp = readLatestTimestamp(lastPriceUpdate);
  const reconcilePending = PENDING_DEPOSIT_VAULTS.has(coin.id);
  if (reconcilePending && navUsd == null) {
    throw new Error(`nest-vault-positions missing ${coin.symbol} NAV`);
  }
  const pendingTransactions = reconcilePending
    ? [
        ...liquidTokens.flatMap((token) => readPendingTransactions(token, "liquid")),
        ...yieldAssets.flatMap((asset) => {
          const assetSlug = typeof asset.slug === "string" ? asset.slug : undefined;
          return asset.tokens
            .flatMap((token) => readPendingTransactions(token, "yield", assetSlug));
        }),
      ]
    : [];
  const pendingDepositUsd = pendingTransactions
    .filter((transaction) => transaction.type === "PendingDeposit")
    .reduce((sum, transaction) => sum + transaction.valueUsd, 0);
  const pendingWithdrawalUsd = pendingTransactions
    .filter((transaction) => transaction.type === "PendingWithdrawal")
    .reduce((sum, transaction) => sum + transaction.valueUsd, 0);
  let grossNavUsd: number | null = null;
  let calculatedNavUsd: number | null = null;
  let claimableFeesUsd: number | null = null;
  let unrealizedDividendsUsd: number | null = null;
  let calculatedPriceUrl: string | null = null;
  if (pendingWithdrawalUsd > 0) {
    // The generic pending-withdrawals source key is safe only while every
    // positive receivable belongs to the reviewed underlying: OALS2T in
    // nOPAL's liquid-stone vault, or USCC in nBASIS. NAV reconciliation proves
    // the amount, not an interchangeable asset identity.
    const withdrawalReviewed = coin.id === "nopal-nest"
      ? (transaction: NestPendingTransactionValue) =>
        transaction.positionKind === "yield" && transaction.assetSlug === "liquid-stone"
        && transaction.symbol === "OALS2T"
      : coin.id === "nbasis-nest"
        ? (transaction: NestPendingTransactionValue) =>
          transaction.positionKind === "yield" && transaction.assetSlug === "superstate-uscc"
          && transaction.symbol === "USCC"
        : () => false;
    if (pendingTransactions.some((transaction) =>
      transaction.type === "PendingWithdrawal" && transaction.valueUsd > 0
      && !withdrawalReviewed(transaction))) {
      throw new Error(`nest-vault-positions cannot reconcile positive ${coin.symbol} pending withdrawals`);
    }
    calculatedPriceUrl = new URL("calculated-price", params.priceUrl).href;
    const calculated = await fetchJsonWithRetry<{ data?: {
      grossCalculatedNav?: unknown; calculatedNav?: unknown; claimableFees?: unknown;
      unrealizedDividends?: unknown; claimableFeesAdjusted?: unknown; errors?: unknown;
    } }>(calculatedPriceUrl, signal, 12_000, ctx);
    const data = calculated.data;
    grossNavUsd = parsePositiveNumericLike(data?.grossCalculatedNav);
    calculatedNavUsd = parsePositiveNumericLike(data?.calculatedNav);
    claimableFeesUsd = parseFiniteNumber(data?.claimableFees, { label: "Nest reconciliation claimable fees", min: 0 });
    // Nest includes accrued yield in NAV and exposes unrealizedDividends
    // separately from /positions. Require the explicit nonnegative amount,
    // including an observed zero; gross reconciliation admits it exactly once.
    unrealizedDividendsUsd = readNonNegativeNumericLike(data?.unrealizedDividends, "unrealized dividends");
    const hasErrors = data?.errors !== undefined && (!Array.isArray(data.errors) || data.errors.length > 0);
    if (hasErrors || grossNavUsd == null || calculatedNavUsd == null
      || claimableFeesUsd == null || claimableFeesUsd < 0 || data?.claimableFeesAdjusted !== true
      || Math.abs(grossNavUsd - settledPositionUsd - pendingDepositUsd - pendingWithdrawalUsd - unrealizedDividendsUsd) > 0.01
      || Math.abs(grossNavUsd - claimableFeesUsd - calculatedNavUsd) > 0.01) {
      throw new Error("nest-vault-positions pending withdrawal NAV reconciliation failed");
    }
    // The vault publishes NAV twice: `/price.nav`, and the net NAV rebuilt here
    // from `/positions`. Accepting a reconciliation that contradicts the
    // published NAV would suppress the published-NAV residual, report gross NAV
    // as total reserves, and score coverage over a contradiction (R1), so it
    // fails closed naming both values.
    if (
      navUsd != null &&
      Math.abs(calculatedNavUsd - navUsd) >
        Math.max(NAV_RECONCILIATION_ABSOLUTE_TOLERANCE_USD, Math.abs(navUsd) * NAV_RECONCILIATION_RELATIVE_TOLERANCE)
    ) {
      throw new Error(
        `nest-vault-positions calculated NAV ${calculatedNavUsd} does not match the published NAV ${navUsd}`,
      );
    }
  }
  // No calculated-price read means no separately admitted dividend contributor,
  // not a claim that the vault has zero unrealized dividends.
  const reconciledDividendsUsd = unrealizedDividendsUsd != null ? unrealizedDividendsUsd : 0;
  const settledCoverageUsd = settledPositionUsd + pendingDepositUsd + pendingWithdrawalUsd + reconciledDividendsUsd;
  const navReconciliationResidualUsd =
    grossNavUsd == null && navUsd != null && navUsd > 0 && settledCoverageUsd < navUsd
      ? navUsd - settledCoverageUsd
      : null;
  const unknownValue = settledValues.reduce((sum, value) => sum + (value.unknown ? value.value : 0), 0)
    + pendingDepositUsd + pendingWithdrawalUsd + reconciledDividendsUsd + (navReconciliationResidualUsd ?? 0);
  const values = mergeSliceValues([
    ...settledValues,
    ...(pendingWithdrawalUsd > 0
      ? [{
          sourceKey: "nest-vault-positions:pending-withdrawals",
          value: pendingWithdrawalUsd,
          name: coin.id === "nbasis-nest"
            ? "Nest pending USCC redemption receivables"
            : "Nest pending redemption receivables",
          risk: "high" as const,
        }]
      : []),
    ...(pendingDepositUsd > 0
      ? [{
          sourceKey: "nest-vault-positions:pending-deposits",
          value: pendingDepositUsd,
          name: "Nest pending deposits",
          risk: "high" as const,
        }]
      : []),
    ...(reconciledDividendsUsd > 0
      ? [{
          sourceKey: "nest-vault-positions:unrealized-dividends",
          value: reconciledDividendsUsd,
          name: "Nest unrealized dividend receivables",
          risk: "high" as const,
        }]
      : []),
    ...(navReconciliationResidualUsd != null && navReconciliationResidualUsd > 0
      ? [{
          sourceKey: "nest-vault-positions:nav-residual",
          value: navReconciliationResidualUsd,
          name: "Nest NAV reconciliation residual",
          risk: "high" as const,
        }]
      : []),
  ]);
  const totalReserveUsd = grossNavUsd ?? (navUsd != null && navUsd > 0 ? navUsd : settledPositionUsd);
  const unknownExposurePct = unknownValue / Math.max(totalReserveUsd, settledCoverageUsd) * 100;
  const navCoverageRatio = navUsd && navUsd > 0 ? settledPositionUsd / navUsd : null;
  const reconciledNavCoverageRatio =
    grossNavUsd != null ? settledCoverageUsd / grossNavUsd
      : navUsd && navUsd > 0 ? settledCoverageUsd / navUsd : navCoverageRatio;
  const warnings = buildCoverageShortfallWarnings({
    code: "nest-nav-coverage-gap",
    message: (pct) => reconcilePending
      ? `Nest settled positions plus pending deposits cover ${pct}% of reported NAV`
      : `Nest position values cover ${pct}% of reported NAV`,
    coverageRatio: reconciledNavCoverageRatio,
    thresholdRatio: 0.99,
  });

  return {
    slices: slicesFromValues(values, null),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      details: {
        proofKind: "nest-vault-positions-api",
        ...(reconcilePending
          ? {
              reconciliationKind: grossNavUsd != null
                ? "settled-plus-pending-plus-dividends-equals-gross-nav-less-fees-equals-net-nav"
                : coin.id === "nbasis-nest"
                ? "settled-plus-pending-deposits-compared-with-nav"
                : "settled-plus-pending-deposits-plus-residual-equals-nav",
              pendingTransactions,
            }
          : {}),
        ...(calculatedPriceUrl != null ? { calculatedPriceUrl } : {}),
      },
      totalReserveUsd,
      settledPositionUsd,
      ...(grossNavUsd != null ? { grossNavUsd, calculatedNavUsd, claimableFeesUsd, unrealizedDividendsUsd } : {}),
      ...(reconcilePending ? { pendingDepositUsd, pendingWithdrawalUsd } : {}),
      ...(navReconciliationResidualUsd != null ? { navReconciliationResidualUsd } : {}),
      unknownExposurePct,
      ...(navUsd != null ? { navUsd } : {}),
      ...(priceUsd != null ? { priceUsd } : {}),
      ...(totalSupply != null ? { totalSupply } : {}),
      ...(navCoverageRatio != null ? { navCoverageRatio } : {}),
      ...(reconcilePending && reconciledNavCoverageRatio != null
        ? { reconciledNavCoverageRatio }
        : {}),
    },
  };
}
