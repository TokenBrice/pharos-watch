import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { getLiveReserveAdapterMaxUnknownExposurePct, parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import { rethrowIfAborted } from "../../lib/abort";
import { DECIMALS_SELECTOR, encodeBalanceOfCallData } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { observeFpiControllerRedemptionRoute } from "./fpi-controller-redemption";
import {
  buildRedemptionSnapshotMetadata,
  buildUnknownExposureWarning,
  computeUnknownExposurePct,
  decimalNumberFromBigInt,
  fetchDefiLlamaPrices,
  fetchJsonAdapterInput,
  fetchOnchainUint256,
  freshnessMetadataFromTimestamp,
  normalizeSlices,
  parseTimestampLikeToUnixSeconds,
  reconcileRowsWithSourceTotal,
  reserveDegradedWarning,
  SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT,
  sourceKeySlug,
} from "./helpers";

/* ---------- v2 balance-sheet API types ---------- */

interface BalanceSheetAsset {
  tokenSymbol: string;
  totalValueUsd: number;
  category?: string;
}

export interface FraxBalanceSheetResponse {
  asOfTimestamp?: string;
  totalAssets?: number;
  assets?: BalanceSheetAsset[];
}

/* ---------- v2 FPI collateral API types ---------- */

interface FraxFpiCollateralRow {
  key?: string;
  name?: string;
  chain?: string;
  ownerAddress?: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenName?: string;
  tokenQuantity?: number | null;
  tokenPrice?: number | null;
  valueUsd?: number | null;
}

export interface FraxFpiCollateralResponse {
  updatedAtBlock?: number;
  updatedAtTimestampSec?: number;
  assets?: FraxFpiCollateralRow[];
  liabilities?: FraxFpiCollateralRow[];
}

/* ---------- token → display / risk / coinId map ---------- */

interface TokenDisplayConfig {
  label: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  /**
   * Stable slice identity for rows that map to a fixed on-chain contract
   * rather than a symbol. When set, it is emitted verbatim so the key cannot
   * drift if the issuer relabels the position.
   */
  sourceKey?: string;
}

const TOKEN_DISPLAY: Record<string, TokenDisplayConfig> = {
  AUSD: { label: "AUSD (Agora Dollar)", risk: getCanonicalReserveAssetRisk("AUSD") ?? "low" },
  AVAX: { label: "AVAX", risk: getCanonicalReserveAssetRisk("AVAX") ?? "high" },
  WTGXX: { label: "WTGXX (WisdomTree Government Money Market)", risk: "low" },
  USTB: {
    label: "USTB (Superstate tokenized T-bills)",
    risk: getCanonicalReserveAssetRisk("USTB") ?? "low",
    coinId: "ustb-superstate",
  },
  BUIDL: {
    label: "BUIDL (BlackRock tokenized T-bills)",
    risk: getCanonicalReserveAssetRisk("BUIDL") ?? "low",
    coinId: "buidl-blackrock",
  },
  CVX: { label: "CVX", risk: "very-high" },
  CRV: { label: "CRV", risk: getCanonicalReserveAssetRisk("CRV") ?? "very-high" },
  CHR: { label: "CHR", risk: "very-high" },
  DAI: { label: "DAI", risk: getCanonicalReserveAssetRisk("DAI") ?? "low", coinId: "dai-makerdao" },
  EREBOR_USD: {
    label: "EREBOR_USD (Erebor Bank frxUSD reserve account)",
    risk: "very-low",
  },
  ETH: { label: "ETH", risk: getCanonicalReserveAssetRisk("ETH") ?? "very-low" },
  FPI: { label: "FPI", risk: "medium" },
  FRAX: { label: "FRAX", risk: getCanonicalReserveAssetRisk("FRAX") ?? "low", coinId: "frax-frax" },
  FXS: { label: "FXS", risk: "high" },
  LFRAX: { label: "LFRAX", risk: "medium" },
  MULTI: { label: "MULTI", risk: "very-high" },
  MATIC: { label: "MATIC", risk: "high" },
  OP: { label: "OP", risk: "high" },
  PYUSD: { label: "PYUSD", risk: getCanonicalReserveAssetRisk("PYUSD") ?? "low", coinId: "pyusd-paypal" },
  RAM: { label: "RAM", risk: "very-high" },
  SDT: { label: "SDT", risk: "very-high" },
  THE: { label: "THE", risk: "very-high" },
  USDB: { label: "USDB (Bridge)", risk: "low" },
  USDC: { label: "USDC (Circle)", risk: "low", coinId: "usdc-circle" },
  USCC: { label: "USCC (Superstate crypto arbitrage)", risk: "medium" },
  USDS: { label: "USDS", risk: getCanonicalReserveAssetRisk("USDS") ?? "low", coinId: "usds-sky" },
  USDT: { label: "USDT", risk: getCanonicalReserveAssetRisk("USDT") ?? "low", coinId: "usdt-tether" },
  USDe: { label: "USDe", risk: "high", coinId: "usde-ethena" },
  WAVAX: { label: "WAVAX", risk: "high" },
  VELO: { label: "VELO (locked veNFT #4976)", risk: "very-high" },
  BNB: { label: "BNB", risk: "high" },
  WBNB: { label: "WBNB", risk: "high" },
  WETH: { label: "WETH", risk: getCanonicalReserveAssetRisk("WETH") ?? "very-low" },
  WPOL: { label: "WPOL", risk: "high" },
  ZK: { label: "ZK", risk: "high" },
  axlUSDC: { label: "axlUSDC", risk: "medium", coinId: "usdc-circle" },
  axlfrxETH: { label: "axlfrxETH", risk: "medium" },
  cvxCRV: { label: "cvxCRV", risk: "very-high" },
  // The source labels this row crvUSD, but its own description identifies an
  // unstaked Curve sfrxUSD/scrvUSD LP. Keep it unlinked instead of fabricating
  // a pure crvUSD dependency or hiding its partial Frax self-exposure.
  crvUSD: { label: "sfrxUSD/scrvUSD Curve LP", risk: "medium" },
  frxETH: { label: "frxETH", risk: "low" },
  frxUSD: { label: "frxUSD", risk: getCanonicalReserveAssetRisk("FRXUSD") ?? "low", coinId: "frxusd-frax" },
  lzfrxETH: { label: "lzfrxETH", risk: "medium" },
  lzsfrxETH: { label: "lzsfrxETH", risk: "medium" },
  // Resupply reUSD: the balance sheet reports token 0x57aB1E0003F623289CD798B1824Be09a793e4Bec
  // (Convex sfrxUSD/reUSD), not Re Protocol's same-symbol reUSD.
  reUSD: { label: "reUSD", risk: "medium", coinId: "reusd-resupply" },
  sDAI: { label: "sDAI", risk: "low", coinId: "dai-makerdao" },
  sFRAX: { label: "sFRAX", risk: "medium", coinId: "frax-frax" },
  sfrxETH: { label: "sfrxETH", risk: getCanonicalReserveAssetRisk("SFRXETH") ?? "low" },
  sfrxUSD: { label: "sfrxUSD", risk: "low", coinId: "sfrxusd-frax" },
  stkAAVE: { label: "stkAAVE", risk: "very-high" },
  // Staked Convex wrapper of the Curve FPI/FRAX LP; no governance-token leg,
  // so it inherits FPI's own risk rating rather than FXS's.
  stkcvxFPIFRAX: { label: "stkcvxFPIFRAX (staked Convex FPI/FRAX LP)", risk: "medium" },
  wfrxETH: { label: "wfrxETH", risk: "medium" },
  ZZ: { label: "ZZ", risk: "very-high" },
};

// FPI collateral rows in this allowlist report no tokenSymbol, only a `name`.
// Keep them separate from tokenSymbol mappings so arbitrary provider row names
// cannot collide with trusted symbols such as FRAX, DAI, or USDC.
const FPI_COLLATERAL_NAME_ONLY_DISPLAY: Record<string, TokenDisplayConfig> = {
  // FPIS is FPI's own governance token, so this LP is rated like FXS rather
  // than a stable pair. The slice identity is the Fraxswap V2 FRAX/FPIS pair
  // contract on Ethereum, read from the Fraxswap V2 factory getPair(FRAX,
  // FPIS) (factory 0x43ec799eadd63848443e2347c49f5f52e8fe0f6f; token0 FRAX
  // 0x853d955acef822db058eb8505911ed77f175b99e, token1 FPIS
  // 0xc2544a32872a91f4a553b404c6950e89de901fdb), so a provider-side relabel
  // cannot move the reviewed slice key.
  "Fraxswap V2 FRAX/FPIS": {
    label: "Fraxswap V2 FRAX/FPIS",
    risk: "high",
    sourceKey: "frax-fpi-collateral:ethereum:0x56695c26b3cdb528815cd22ff7b47510ab821efd",
  },
};

/* ---------- v2 balance-sheet adapter ---------- */

export function adaptFraxBalanceSheet(payload: FraxBalanceSheetResponse, subjectId?: string): AdapterResult {
  const assets = payload.assets;
  if (!assets?.length || !payload.totalAssets || payload.totalAssets <= 0) {
    throw new Error("Frax balance-sheet response missing or empty assets array");
  }

  const warnings: LiveReserveWarning[] = [];

  // Aggregate USD value by tokenSymbol
  const bySymbol = new Map<string, number>();
  for (const asset of assets) {
    if (!asset.category?.startsWith("asset:")) continue;
    const usd = asset.totalValueUsd;
    if (typeof usd !== "number" || !Number.isFinite(usd) || !asset.tokenSymbol?.trim()) {
      throw new Error("Frax balance-sheet asset amount or identity is unavailable");
    }
    bySymbol.set(asset.tokenSymbol, (bySymbol.get(asset.tokenSymbol) ?? 0) + usd);
  }
  // Contra entries offset their own asset, never an unrelated reserve bucket.
  for (const [symbol, usd] of bySymbol) {
    if (usd < 0) throw new Error(`Frax balance-sheet net asset is negative: ${symbol}`);
    if (usd === 0) bySymbol.delete(symbol);
  }

  const categorizedAssetTotal = [...bySymbol.values()].reduce((a, b) => a + b, 0);
  if (categorizedAssetTotal <= 0) throw new Error("Frax balance-sheet total asset value is zero");
  const sourceTotal = Number(payload.totalAssets);
  if (!Number.isFinite(sourceTotal) || sourceTotal <= 0) {
    throw new Error("Frax balance-sheet totalAssets is invalid or zero");
  }
  const total = sourceTotal;
  const reconciliation = reconcileRowsWithSourceTotal({
    rowTotalUsd: categorizedAssetTotal,
    sourceTotalUsd: sourceTotal,
    exceedsMessage: "Frax balance-sheet asset rows exceed totalAssets",
  });
  if (reconciliation.rowsExceedTotalWarning) warnings.push(reconciliation.rowsExceedTotalWarning);
  // The sync core rejects malformed slices before it reads fatal warnings, so a
  // withheld attempt still shares its rows over their own sum; they never publish.
  const shareBasisUsd = reconciliation.rowsExceedTotalWarning ? categorizedAssetTotal : total;
  const stableRedeemableUsd = ["USDC", "USDS", "PYUSD", "DAI", "FRAX"].reduce(
    (sum, symbol) => sum + (bySymbol.get(symbol) ?? 0),
    0,
  );
  if (stableRedeemableUsd > total) {
    warnings.push(reserveDegradedWarning("redeemable-capacity-exceeds-total",
      "Frax redeemable asset rows exceed totalAssets; capacity is unavailable"));
  }
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.asOfTimestamp);

  const slices: ReserveSlice[] = [];
  const unknownSymbols: string[] = [];
  let unknownUsd = 0;
  for (const [symbol, usd] of bySymbol) {
    const config = TOKEN_DISPLAY[symbol];
    if (!config) {
      unknownSymbols.push(symbol);
      unknownUsd += usd;
    }
    if (config) {
      slices.push({
        sourceKey: `frax-balance-sheet:${symbol.toLowerCase()}`,
        name: config.label,
        pct: (usd / shareBasisUsd) * 100,
        risk: config.risk,
        ...(config.coinId && config.coinId !== subjectId ? { coinId: config.coinId, depType: "collateral" as const } : {}),
      });
    }
  }

  if (unknownUsd > 0) {
    slices.push({
      sourceKey: "frax-balance-sheet:unknown",
      name: "Unmapped Frax balance-sheet assets",
      pct: (unknownUsd / shareBasisUsd) * 100,
      risk: "high",
    });
    warnings.push(
      buildUnknownExposureWarning({
        adapterKey: "frax-balance-sheet",
        code: "unknown-token",
        message: `Frax balance-sheet unknown token(s): ${unknownSymbols.sort().join(", ")}`,
        unknownExposurePct: (unknownUsd / shareBasisUsd) * 100,
      }),
    );
  }

  if (reconciliation.gapPct > SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT) {
    slices.push({
      sourceKey: "frax-balance-sheet:source-total-gap",
      name: "Unmapped Frax balance-sheet total-assets gap",
      pct: reconciliation.gapPct,
      risk: "high",
    });
    warnings.push(
      buildUnknownExposureWarning({
        adapterKey: "frax-balance-sheet",
        code: "source-total-gap",
        message: "Frax balance-sheet totalAssets exceeds mapped asset-category rows",
        unknownExposurePct: reconciliation.gapPct,
      }),
    );
  }

  return {
    slices: normalizeSlices(slices, null),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      totalCollateralUsd: total,
      categorizedAssetTotalUsd: categorizedAssetTotal,
      sourceTotalAssetsUsd: sourceTotal,
      ...(reconciliation.gapPct > 0 ? { sourceTotalGapPct: reconciliation.gapPct } : {}),
      assetCount: bySymbol.size,
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "frax-balance-sheet-api",
        "Frax balance-sheet response did not include asOfTimestamp",
      ),
      ...buildRedemptionSnapshotMetadata({
        ...(stableRedeemableUsd <= total ? { capacityUsd: stableRedeemableUsd } : {}),
        capacityKind: "live-proxy-validated",
        freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" : "unverified",
        ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
        routeStatus: "unknown",
        sourceUrls: ["https://frax.com/transparency"],
      }),
    },
  };
}

/* ---------- v2 FPI collateral adapter ---------- */

function nonnegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isFpiSelfHolding(row: FraxFpiCollateralRow): boolean {
  return row.tokenSymbol === "FPI";
}

function describeFpiCollateralRow(row: FraxFpiCollateralRow): string {
  const symbol = row.tokenSymbol?.trim();
  if (symbol) return symbol;
  const name = row.name?.trim();
  if (name) return name;
  return row.key?.trim() || "unlabeled-row";
}

function getFpiCollateralMappingKey(row: FraxFpiCollateralRow): string | undefined {
  const symbol = row.tokenSymbol?.trim();
  if (symbol) return symbol;

  const name = row.name?.trim();
  return name && FPI_COLLATERAL_NAME_ONLY_DISPLAY[name] ? name : undefined;
}

function getFpiCollateralDisplayConfig(key: string): TokenDisplayConfig | undefined {
  return TOKEN_DISPLAY[key] ?? FPI_COLLATERAL_NAME_ONLY_DISPLAY[key];
}

/**
 * Pharos-side USD value for non-FPI rows whose issuer `valueUsd` is missing:
 * the row's disclosed token quantity, else the owner's on-chain balance, times
 * the row's own token price, else a policy-checked DefiLlama quote for the same
 * token contract. `rpcByChain` supplies configured endpoints for chains the
 * Worker registry does not resolve. A row absent from the result cannot be
 * valued without inventing precision, so the adapter keeps failing closed on
 * it. FPI self-holdings are never estimated: they net against FPI liabilities.
 */
async function valueUnpricedFpiCollateralRows(
  assets: readonly FraxFpiCollateralRow[],
  rpcByChain: Readonly<Record<string, { rpcUrl?: string; fallbackRpcUrl?: string }>>,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<Map<FraxFpiCollateralRow, number>> {
  const rows = assets.flatMap((row, index) => {
    if (nonnegativeFinite(row.valueUsd) != null || isFpiSelfHolding(row)) return [];
    const chain = row.chain?.trim();
    const token = canonicalEvmAddress(row.tokenAddress, { allowZero: false });
    const owner = canonicalEvmAddress(row.ownerAddress, { allowZero: false });
    const disclosedPrice = nonnegativeFinite(row.tokenPrice);
    const rowPrice = disclosedPrice != null && disclosedPrice > 0 ? disclosedPrice : undefined;
    return [{ row, key: String(index), chain, token, owner, rowPrice }];
  });
  if (rows.length === 0) return new Map();

  // One row at a time: each row opens at most two concurrent RPC reads, so the
  // valuation stays inside the Worker connection budget however many rows lack
  // an issuer value.
  const quantities = new Map<FraxFpiCollateralRow, number>();
  for (const { row, chain, token, owner } of rows) {
    const disclosed = nonnegativeFinite(row.tokenQuantity);
    if (disclosed != null) {
      quantities.set(row, disclosed);
      continue;
    }
    if (!chain || !token || !owner) continue;
    try {
      const read = (data: string) => fetchOnchainUint256({ contract: token, data, chain, signal, ctx, ...rpcByChain[chain] });
      const [balanceRaw, decimals] = await Promise.all([read(encodeBalanceOfCallData(owner)), read(DECIMALS_SELECTOR)]);
      if (balanceRaw == null || decimals == null || decimals > 36n) continue;
      quantities.set(row, decimalNumberFromBigInt(balanceRaw, Number(decimals)));
    } catch (error) {
      rethrowIfAborted(error, signal);
    }
  }

  const quoteLookups = rows.flatMap(({ row, key, chain, token, rowPrice }) =>
    (quantities.get(row) ?? 0) > 0 && rowPrice == null && chain && token ? [{ key, chain, address: token }] : []);
  let quotes = new Map<string, number>();
  try {
    const result = await fetchDefiLlamaPrices(quoteLookups, signal, ctx);
    if (result.warnings.some((warning) => warning.code === "defillama-quote-quality")) {
      throw new Error("Frax FPI DefiLlama quotes fail quality policy");
    }
    quotes = result.prices;
  } catch (error) {
    rethrowIfAborted(error, signal);
  }

  const values = new Map<FraxFpiCollateralRow, number>();
  for (const { row, key, rowPrice } of rows) {
    const quantity = quantities.get(row);
    if (quantity == null) continue;
    if (quantity === 0) {
      values.set(row, 0);
      continue;
    }
    const price = rowPrice ?? quotes.get(key);
    const valueUsd = price != null ? quantity * price : undefined;
    if (valueUsd != null && Number.isFinite(valueUsd)) values.set(row, valueUsd);
  }
  return values;
}

export function adaptFraxFpiCollateral(
  payload: FraxFpiCollateralResponse,
  unpricedRowValuesUsd: ReadonlyMap<FraxFpiCollateralRow, number> = new Map(),
): AdapterResult {
  const assets = payload.assets;
  if (!assets?.length) {
    throw new Error("Frax FPI collateral response missing or empty assets array");
  }

  const warnings: LiveReserveWarning[] = [];
  const bySymbol = new Map<string, number>();
  const unknownLabels = new Set<string>();
  let unknownUsd = 0;
  let selfHeldFpiUsd = 0;
  const unavailableAssetLabels: string[] = [];
  let selfHoldingsComplete = true;
  const unpricedAssetLabels: string[] = [];
  let unpricedUsd = 0;

  for (const asset of assets) {
    const usd = nonnegativeFinite(asset.valueUsd);
    if (usd == null) {
      const estimateUsd = isFpiSelfHolding(asset) ? undefined : nonnegativeFinite(unpricedRowValuesUsd.get(asset));
      if (estimateUsd != null) {
        unpricedUsd += estimateUsd;
        unpricedAssetLabels.push(describeFpiCollateralRow(asset));
        continue;
      }
      unavailableAssetLabels.push(describeFpiCollateralRow(asset));
      if (isFpiSelfHolding(asset)) selfHoldingsComplete = false;
      continue;
    }
    if (usd === 0) continue;
    if (isFpiSelfHolding(asset)) {
      selfHeldFpiUsd += usd;
      continue;
    }

    const symbol = getFpiCollateralMappingKey(asset);
    const config = symbol ? getFpiCollateralDisplayConfig(symbol) : undefined;
    if (symbol && config) {
      bySymbol.set(symbol, (bySymbol.get(symbol) ?? 0) + usd);
    } else {
      unknownUsd += usd;
      unknownLabels.add(describeFpiCollateralRow(asset));
    }
  }

  const mappedCollateralUsd = [...bySymbol.values()].reduce((sum, usd) => sum + usd, 0);
  const valuedCollateralUsd = mappedCollateralUsd + unknownUsd;
  if (valuedCollateralUsd <= 0) {
    throw new Error("Frax FPI collateral response has no positive non-FPI collateral assets");
  }
  // A row the issuer left unpriced but Pharos could value is admitted as
  // explicit unpriced exposure only while it, together with any unmapped
  // exposure, stays under the adapter's shared unknown-exposure ceiling (the
  // same combined figure the snapshot validator gates); a material one fails
  // closed like any other unavailable row rather than resting the composition
  // on Pharos' estimate.
  const unpricedAdmitted = computeUnknownExposurePct(unknownUsd + unpricedUsd, valuedCollateralUsd + unpricedUsd)
    <= getLiveReserveAdapterMaxUnknownExposurePct("frax-fpi-collateral");
  if (!unpricedAdmitted) unavailableAssetLabels.push(...unpricedAssetLabels);
  const admittedUnpricedUsd = unpricedAdmitted ? unpricedUsd : 0;
  const totalCollateralUsd = valuedCollateralUsd + admittedUnpricedUsd;

  const liabilities = payload.liabilities;
  const unavailableLiabilityCount = liabilities?.filter((row) => nonnegativeFinite(row.valueUsd) == null).length ?? 0;
  const liabilityCoverageComplete = Array.isArray(liabilities) && liabilities.length > 0 && unavailableLiabilityCount === 0;
  const compositionComplete = unavailableAssetLabels.length === 0;
  const totalLiabilitiesUsd = liabilityCoverageComplete
    ? liabilities.reduce((sum, liability) => sum + liability.valueUsd!, 0)
    : undefined;
  const netExternalLiabilitiesUsd = compositionComplete && totalLiabilitiesUsd != null
    ? totalLiabilitiesUsd - selfHeldFpiUsd
    : undefined;
  const collateralizationRatio = netExternalLiabilitiesUsd != null && netExternalLiabilitiesUsd > 0
    ? totalCollateralUsd / netExternalLiabilitiesUsd
    : undefined;
  if (!compositionComplete) {
    warnings.push(reserveDegradedWarning("asset-coverage-incomplete",
      `Frax FPI asset values unavailable: ${unavailableAssetLabels.join(", ")}`));
  }
  if (!liabilityCoverageComplete || (netExternalLiabilitiesUsd != null && netExternalLiabilitiesUsd < 0)) {
    warnings.push(reserveDegradedWarning("liability-coverage-incomplete",
      "Frax FPI liabilities are unavailable or inconsistent with self holdings"));
  }
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.updatedAtTimestampSec);
  const stableRedeemableUsd = ["FRAX", "sFRAX", "sfrxUSD"].reduce(
    (sum, symbol) => sum + (bySymbol.get(symbol) ?? 0),
    0,
  );

  const slices: ReserveSlice[] = [];
  for (const [symbol, usd] of bySymbol) {
    const config = getFpiCollateralDisplayConfig(symbol);
    if (!config) continue;
    slices.push({
      sourceKey: config.sourceKey ?? `frax-fpi-collateral:${sourceKeySlug(symbol)}`,
      name: config.label,
      pct: (usd / totalCollateralUsd) * 100,
      risk: config.risk,
      ...(config.coinId ? { coinId: config.coinId, depType: "collateral" as const } : {}),
    });
  }

  if (unknownUsd > 0) {
    const unknownExposurePct = (unknownUsd / totalCollateralUsd) * 100;
    slices.push({
      sourceKey: "frax-fpi-collateral:unknown",
      name: "Unmapped Frax FPI collateral assets",
      pct: unknownExposurePct,
      risk: "high",
    });
    warnings.push(
      buildUnknownExposureWarning({
        adapterKey: "frax-fpi-collateral",
        code: "unknown-token",
        message: `Frax FPI collateral unknown token(s): ${[...unknownLabels].sort().join(", ")}`,
        unknownExposurePct,
      }),
    );
  }

  if (unpricedAdmitted && unpricedAssetLabels.length > 0) {
    const unpricedExposurePct = (admittedUnpricedUsd / totalCollateralUsd) * 100;
    slices.push({
      sourceKey: "frax-fpi-collateral:unpriced",
      name: "Unpriced Frax FPI collateral assets",
      pct: unpricedExposurePct,
      risk: "high",
    });
    warnings.push(
      buildUnknownExposureWarning({
        adapterKey: "frax-fpi-collateral",
        code: "asset-value-unavailable",
        message: `Frax FPI asset values unavailable upstream; valued by Pharos as unpriced exposure: ${unpricedAssetLabels.join(", ")}`,
        unknownExposurePct: unpricedExposurePct,
      }),
    );
  }

  if (collateralizationRatio != null && collateralizationRatio < 1) {
    warnings.push(
      reserveDegradedWarning(
        "undercollateralized",
        `Frax FPI non-FPI collateral is ${(collateralizationRatio * 100).toFixed(2)}% of net external FPI liabilities`,
      ),
    );
  }

  return {
    slices: normalizeSlices(slices, null),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...(compositionComplete ? { totalCollateralUsd } : { knownCollateralUsd: totalCollateralUsd }),
      compositionComplete,
      unavailableAssetCount: unavailableAssetLabels.length,
      unavailableAssetLabels,
      liabilityCoverageComplete,
      unavailableLiabilityCount,
      mappedCollateralUsd,
      unknownCollateralUsd: unknownUsd,
      ...(unpricedAdmitted && unpricedAssetLabels.length > 0
        ? { unpricedCollateralUsd: admittedUnpricedUsd, unpricedAssetLabels }
        : {}),
      ...(compositionComplete
        ? { unknownExposurePct: computeUnknownExposurePct(unknownUsd + admittedUnpricedUsd, totalCollateralUsd) }
        : {}),
      ...(selfHoldingsComplete ? { selfHeldFpiUsd } : { knownSelfHeldFpiUsd: selfHeldFpiUsd }),
      ...(totalLiabilitiesUsd != null ? { totalLiabilitiesUsd } : {}),
      ...(netExternalLiabilitiesUsd != null && netExternalLiabilitiesUsd >= 0 ? { netExternalLiabilitiesUsd } : {}),
      ...(collateralizationRatio != null ? { collateralizationRatio } : {}),
      assetCount: assets.length,
      liabilityCount: payload.liabilities?.length ?? 0,
      ...(payload.updatedAtBlock != null ? { updatedAtBlock: payload.updatedAtBlock } : {}),
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "frax-fpi-collateral-api",
        "Frax FPI collateral response did not include updatedAtTimestampSec",
      ),
      ...buildRedemptionSnapshotMetadata({
        ...(compositionComplete ? { capacityUsd: stableRedeemableUsd } : {}),
        capacityKind: "live-proxy-validated",
        freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" : "unverified",
        ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
        routeStatus: "open",
        routeStatusSource: "static-config",
        sourceUrls: ["https://frax.com/transparency"],
      }),
    },
  };
}

/* ---------- fetch entrypoint ---------- */

function isBalanceSheetResponse(payload: unknown): payload is FraxBalanceSheetResponse {
  return Array.isArray((payload as FraxBalanceSheetResponse)?.assets);
}

function isFpiCollateralResponse(payload: unknown): payload is FraxFpiCollateralResponse {
  const response = payload as FraxFpiCollateralResponse;
  return Array.isArray(response?.assets) && Array.isArray(response?.liabilities);
}

/**
 * Dedicated balance-sheet adapter entrypoint for coins using the Frax v2
 * balance-sheet API with independent evidence class (e.g. frxUSD).
 */
export async function fetchFraxBalanceSheetReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const payload = await fetchJsonAdapterInput<FraxBalanceSheetResponse>(config, "frax-balance-sheet", signal, 12_000, ctx);

  if (!isBalanceSheetResponse(payload)) {
    throw new Error("frax-balance-sheet adapter requires a v2 balance-sheet API response");
  }
  return adaptFraxBalanceSheet(payload, coin.id);
}

/**
 * Dedicated adapter entrypoint for the Frax FPI collateral endpoint. FPI
 * balances controlled by FPI system addresses are treasury/self holdings, so
 * they are excluded from reserve slices and netted against FPI liabilities.
 */
export async function fetchFraxFpiCollateralReserves(
  _coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const payload = await fetchJsonAdapterInput<FraxFpiCollateralResponse>(config, "frax-fpi-collateral", signal, 12_000, ctx);

  if (!isFpiCollateralResponse(payload)) {
    throw new Error("frax-fpi-collateral adapter requires the FPI collateral API response");
  }
  // Reserve composition and the V9-only route attempt publish as one adapter
  // result. If the issuer payload fails, no new or stale route attempt is
  // attached to an otherwise non-authoritative reserve snapshot.
  const params = parseLiveReserveAdapterParams("frax-fpi-collateral", config.params);
  const unpricedRowValuesUsd = await valueUnpricedFpiCollateralRows(payload.assets ?? [], {
    ethereum: { rpcUrl: params.rpcUrl, fallbackRpcUrl: params.fallbackRpcUrl },
    fraxtal: { rpcUrl: params.fraxtalRpcUrl, fallbackRpcUrl: params.fraxtalFallbackRpcUrl },
  }, signal, ctx);
  const result = adaptFraxFpiCollateral(payload, unpricedRowValuesUsd);
  const routeAttempt = await observeFpiControllerRedemptionRoute(params, signal, ctx);
  const routeWarnings: LiveReserveWarning[] =
    routeAttempt.status === "rejected"
      ? [
          {
            code: "fpi-controller-route-unavailable",
            message: `FPI Controller Pool V9 route observation rejected: ${routeAttempt.rejectionCode}`,
            severity: "warning",
            effect: "info",
          },
        ]
      : [];
  return {
    ...result,
    ...(routeWarnings.length > 0 || (result.warnings?.length ?? 0) > 0
      ? { warnings: [...(result.warnings ?? []), ...routeWarnings] }
      : {}),
    metadata: {
      ...(result.metadata ?? {}),
      redemption: {
        ...(result.metadata?.redemption ?? {}),
        v9RouteAttempt: routeAttempt,
      },
    },
  };
}
