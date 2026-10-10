import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReserveInput, LiveReserveRpcMode, LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decimalNumberFromBigInt,
  fetchErc20Balance,
  fetchJsonWithRetry,
  fetchOnchainMulticall3,
  freshnessMetadataFromTimestamp,
  summarizeSourceTimestampsRequiringCoverage,
  normalizeSlices,
  parseBoundedDecimals,
  requireJsonInput,
  reserveDegradedWarning,
  valueUsdFromBigIntPrice,
} from "./helpers";
import { decodeStrictAddressWord, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";
import { encodeAddress, encodeBalanceOfCallData } from "../../lib/evm-selectors";
import { rethrowIfAborted } from "../../lib/abort";
import { LIVE_RESERVE_FRESHNESS_SEC } from "../../lib/live-reserves/store-shared";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "@shared/lib/live-reserve-freshness";

const BRIDGE_EUR_SELECTOR = "0x7439ae59";
const BRIDGE_DEURO_SELECTOR = "0xd395d24b";
const ERC20_DECIMALS_SELECTOR = "0x313ce567";
const DEURO_IS_MINTER_SELECTOR = "0xaa271e1a";
const DEURO_OUTPUT_ASSET_KEY_BY_LABEL: Readonly<Record<string, string>> = {
  EURT: "asset:eurt",
  EURS: "eurs-stasis",
  VEUR: "asset:veur",
  EURC: "eurc-circle",
  EURR: "eurr-stablr",
  EUROP: "europ-schuman",
  EURI: "euri-banking-circle",
  EURE: "asset:eure-legacy-ethereum",
  EURA: "asset:eura",
};

interface PositionDetailsEntry {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  positions: Array<{
    closed?: boolean;
    denied?: boolean;
    collateralBalance?: string;
    /** Frankencoin: minted ZCHF debt of this position, raw integer in zchfDecimals. */
    minted?: string;
    /** Frankencoin: the ZCHF token this position mints. */
    zchf?: string;
    zchfDecimals?: number;
    /** dEURO: outstanding principal (`Position.principal()`), raw integer in deuroDecimals. */
    principal?: string;
    /** dEURO: outstanding interest (`Position.getInterest()`), raw integer in deuroDecimals. */
    interest?: string;
    /** dEURO: the dEURO token this position mints. */
    deuro?: string;
    deuroDecimals?: number;
  }>;
}

type PositionDetailsPayload = Record<string, PositionDetailsEntry>;
type PriceMappingPayload = Record<string, { price?: { usd?: number; eur?: number }; timestamp?: number }>;

interface PositionsApiParams {
  pricesUrl: string;
  otherThresholdPct?: number;
  redemptionBridge?: {
    chain: string;
    rpcMode: LiveReserveRpcMode;
    holder: string;
    tokenAddress: string;
    tokenDecimals: number;
    priceAddress?: string;
    rpcUrl?: string;
    fallbackRpcUrl?: string;
  };
  redemptionBridgeBasket?: {
    chain: string;
    rpcMode: LiveReserveRpcMode;
    dEuroAddress: string;
    eurUsdPriceAddress: string;
    bridges: Array<{
      label: string;
      bridgeAddress: string;
      tokenAddress: string;
      tokenDecimals: number;
    }>;
    rpcUrl?: string;
    fallbackRpcUrl?: string;
    sourceUrls: string[];
  };
}

interface ProtocolAssetConfig {
  risk: ReserveSlice["risk"];
  coinId?: string;
}

interface CollateralPositionsRedemptionOptions {
  sourceUrls?: string[];
  routeStatusReason?: string;
  telemetryDetails?: Record<string, unknown>;
}

interface BridgeBasketProbe {
  capacityEur: number;
  capacityUsd: number;
  eurUsdReference: number;
  outputValuation: {
    sourceId: string;
    observedAt: number;
    unitValueUsd: number;
    expectedUnitValueUsd: number;
    basketWeights: Array<{ assetId: string; weight: number }>;
  } | null;
  /**
   * R1: a measured positive inventory that published no observed unit value
   * says why, so the withheld valuation reads as a named gap rather than an
   * omission.
   */
  outputValuationUnavailableReason: "output-tokens-unpriced" | "output-price-freshness" | null;
  bridgeInventories: Array<{
    label: string;
    bridgeAddress: string;
    tokenAddress: string;
    tokenDecimals: number;
    inventoryRaw: string;
    inventoryEur: number;
  }>;
}

function readParams(config: LiveReservesConfig): PositionsApiParams {
  return parseLiveReserveAdapterParams("collateral-positions-api", config.params);
}

/**
 * Protocol-specific assets used as collateral in Frankencoin / dEURO
 * that are too niche for the canonical risk map.
 */
const PROTOCOL_ASSET_CONFIG: Record<string, ProtocolAssetConfig> = {
  // Governance / participation shares
  FPS: { risk: "very-high" },
  WFPS: { risk: "very-high" },
  BOSS: { risk: "very-high" },
  // Stablecoins not in canonical map
  VCHF: { risk: "low" },
  CHFAU: { risk: "low" },
  YSYBOLD: { risk: "medium", coinId: "ybold-yearn" },
  // Wrapped BTC variants
  BBTC: { risk: "medium" },
  // Tokenized equities / RWA
  AAPLX: { risk: "high" },
  SPYON: { risk: "high" },
  GOOGLX: { risk: "high" },
  NVDAX: { risk: "high" },
  TSLAX: { risk: "high" },
  LENDS: { risk: "high" },
  REALU: { risk: "high" },
  DQTS: { risk: "high" },
  ESC: { risk: "high" },
};

function getProtocolAssetConfig(symbol: string): ProtocolAssetConfig | null {
  return PROTOCOL_ASSET_CONFIG[symbol.toUpperCase()] ?? null;
}

function isKnownAsset(symbol: string): boolean {
  return getCanonicalReserveAssetRisk(symbol) !== null || getProtocolAssetConfig(symbol) !== null;
}

function inferRisk(symbol: string): ReserveSlice["risk"] {
  const canonicalRisk = getCanonicalReserveAssetRisk(symbol);
  if (canonicalRisk) return canonicalRisk;
  const protocolConfig = getProtocolAssetConfig(symbol);
  if (protocolConfig) return protocolConfig.risk;
  return "high";
}

function inferCoinId(symbol: string): string | undefined {
  const protocolCoinId = getProtocolAssetConfig(symbol)?.coinId;
  if (protocolCoinId) return protocolCoinId;
  const upper = symbol.toUpperCase();
  switch (upper) {
    case "USDC":
      return "usdc-circle";
    case "DAI":
      return "dai-makerdao";
    case "LUSD":
      return "lusd-liquity";
    case "ZCHF":
      return "zchf-frankencoin";
    case "CHFAU":
      return "chfau-allunity";
    case "PAXG":
      return "paxg-paxos";
    case "XAUT":
      return "xaut-tether";
    default:
      return undefined;
  }
}

function inferDepType(symbol: string): ReserveSlice["depType"] | undefined {
  // This adapter measures assets pledged to Frankencoin/dEURO loan positions
  // (Position.collateralBalance), never a serial claim on the collateral token.
  // The symbol table identifies that token; the position contract fixes its role.
  return inferCoinId(symbol) ? "collateral" : undefined;
}

function parseCollateralBalance(raw: string | undefined, decimals: number): bigint | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  if (parseBoundedDecimals(decimals) == null) return null;
  return BigInt(raw);
}

interface PositionLiability {
  raw: bigint;
  decimals: number;
  /** Minted-token address that prices the liability; absent leaves coverage incomplete. */
  token: string | undefined;
}

/**
 * Reads one open position's outstanding minted-token liability. Frankencoin
 * rows carry `minted` in `zchfDecimals`. dEURO rows carry `principal` and
 * `interest` in `deuroDecimals`: the API reads `Position.principal()` and
 * `Position.getInterest()` live, and their sum is `Position.getDebt()`, the
 * full debt the position owes. The API reports `interest: "0"` when its own
 * interest read fails, which the payload cannot distinguish from zero accrual.
 * The protocol is chosen from which field family the row carries; a row with
 * both or neither family is unparseable rather than combined across different
 * debt semantics.
 */
function parsePositionLiability(position: PositionDetailsEntry["positions"][number]): PositionLiability | null {
  const hasDeuroFields = position.deuro !== undefined || position.deuroDecimals !== undefined ||
    position.principal !== undefined || position.interest !== undefined;
  const hasZchfFields = position.zchf !== undefined || position.zchfDecimals !== undefined ||
    position.minted !== undefined;
  if (hasDeuroFields === hasZchfFields) return null;
  if (hasDeuroFields) {
    const decimals = parseBoundedDecimals(position.deuroDecimals);
    if (decimals == null) return null;
    const principal = parseCollateralBalance(position.principal, decimals);
    const interest = parseCollateralBalance(position.interest, decimals);
    if (principal == null || interest == null) return null;
    return { raw: principal + interest, decimals, token: position.deuro };
  }
  const decimals = parseBoundedDecimals(position.zchfDecimals);
  const minted = decimals == null ? null : parseCollateralBalance(position.minted, decimals);
  if (decimals == null || minted == null) return null;
  return { raw: minted, decimals, token: position.zchf };
}

export function adaptCollateralPositions(
  details: PositionDetailsPayload,
  prices: PriceMappingPayload,
  otherThresholdPct = 2,
  immediateRedeemableUsd?: number | null,
  redemptionOptions: CollateralPositionsRedemptionOptions = {},
  nowSec = Math.floor(Date.now() / 1000),
): AdapterResult {
  const warnings: LiveReserveWarning[] = [];
  const values: Array<{
    name: string;
    usd: number;
    risk: ReserveSlice["risk"];
    sourceKey: string;
    coinId?: string;
    depType?: ReserveSlice["depType"];
    unknown?: boolean;
  }> = [];
  const missingPriceSymbols = new Set<string>();
  let unknownExposureUsd = 0;
  let activePositionCount = 0;
  const priceTimestamps: unknown[] = [];

  for (const entry of Object.values(details)) {
    let totalBalance = 0n;
    for (const [positionIndex, position] of entry.positions.entries()) {
      if (position.closed || position.denied) continue;
      const balance = parseCollateralBalance(position.collateralBalance, entry.decimals);
      if (balance == null) {
        throw new Error(
          `collateral-positions-api unparseable-collateral-balance: ${entry.symbol} position ${positionIndex}`,
        );
      }
      totalBalance += balance;
      if (balance > 0n) activePositionCount += 1;
    }

    if (totalBalance <= 0n) continue;

    const priceInfo = prices[entry.address.toLowerCase()];
    const usdPrice = priceInfo?.price?.usd;
    if (typeof usdPrice !== "number" || !Number.isFinite(usdPrice) || usdPrice <= 0) {
      missingPriceSymbols.add(entry.symbol);
      continue;
    }

    const usdValue = valueUsdFromBigIntPrice(totalBalance, entry.decimals, usdPrice);
    if (!Number.isFinite(usdValue) || usdValue <= 0) {
      throw new Error(`collateral-positions-api invalid-collateral-valuation: ${entry.symbol}`);
    }
    priceTimestamps.push(priceInfo?.timestamp);

    const risk = inferRisk(entry.symbol);
    const unknown = !isKnownAsset(entry.symbol);
    if (unknown) {
      warnings.push(reserveDegradedWarning(
        "unknown-asset",
        `Unmapped collateral symbol: ${entry.symbol} (inferred risk: ${risk})`,
      ));
      unknownExposureUsd += usdValue;
    }

    values.push({
      name: `${entry.symbol}${entry.name && entry.name !== entry.symbol ? ` (${entry.name})` : ""}`,
      usd: usdValue,
      risk,
      sourceKey: `collateral-positions-api:${entry.symbol.toLowerCase()}`,
      coinId: inferCoinId(entry.symbol),
      depType: inferDepType(entry.symbol),
      ...(unknown ? { unknown: true } : {}),
    });
  }

  if (missingPriceSymbols.size > 0) {
    throw new Error(
      `collateral-positions-api missing USD price(s) for active collateral: ${Array.from(missingPriceSymbols).join(", ")}`,
    );
  }

  const total = values.reduce((acc, value) => acc + value.usd, 0);
  if (!Number.isFinite(total)) throw new Error("collateral-positions-api invalid-collateral-total");
  if (total <= 0) return { slices: [] };

  // Liability side: each open position's outstanding ZCHF/dEURO debt, valued
  // through the minted token's own price-mapping row. Both sides of the
  // assets ÷ liability ratio come from the same position payload over the same
  // scope. A minted row without a price makes the liability incomplete, so the
  // ratio is withheld rather than overstated.
  let mintedUsd = 0;
  let mintedCoverageComplete = true;
  const debtPriceTimestamps: unknown[] = [];
  for (const entry of Object.values(details)) {
    for (const [positionIndex, position] of entry.positions.entries()) {
      if (position.closed || position.denied) continue;
      const liability = parsePositionLiability(position);
      if (liability == null) {
        mintedCoverageComplete = false;
        warnings.push(reserveDegradedWarning(
          "unparseable-minted-balance",
          `Unparseable ${entry.symbol} minted liability at position ${positionIndex}`,
        ));
        continue;
      }
      if (liability.raw <= 0n) continue;
      const mintedPriceInfo = liability.token
        ? prices[liability.token.toLowerCase()]
        : undefined;
      const mintedPrice = mintedPriceInfo?.price?.usd;
      if (typeof mintedPrice !== "number" || !Number.isFinite(mintedPrice) || mintedPrice <= 0) {
        mintedCoverageComplete = false;
        continue;
      }
      debtPriceTimestamps.push(mintedPriceInfo?.timestamp);
      const usd = valueUsdFromBigIntPrice(liability.raw, liability.decimals, mintedPrice);
      if (Number.isFinite(usd) && usd >= 0) {
        mintedUsd += usd;
      } else {
        mintedCoverageComplete = false;
      }
    }
  }
  if (!mintedCoverageComplete) {
    warnings.push(reserveDegradedWarning(
      "liability-coverage-incomplete",
      "One or more open positions lack a valid minted amount, debt decimals, token identity, or USD valuation",
    ));
  }
  // Debt quotes qualify only the ratio, never the independently observed
  // collateral composition clock. Reuse the reserve freshness budget because
  // this latest-state adapter has no dated-source age tier.
  const debtTimestampSummary = summarizeSourceTimestampsRequiringCoverage(debtPriceTimestamps);
  const debtPricesFresh = debtPriceTimestamps.length === 0 || (
    debtTimestampSummary.sourceTimestamp != null &&
    debtTimestampSummary.latestSourceTimestamp != null &&
    debtTimestampSummary.untimestampedCount === 0 &&
    nowSec - debtTimestampSummary.sourceTimestamp <= LIVE_RESERVE_FRESHNESS_SEC &&
    debtTimestampSummary.latestSourceTimestamp <= nowSec + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC
  );
  if (!debtPricesFresh) {
    warnings.push(reserveDegradedWarning(
      "liability-price-freshness",
      `Debt price timestamps must be complete, at most ${LIVE_RESERVE_FRESHNESS_SEC}s old, and no more than ${MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC}s ahead`,
    ));
  }

  const knownValues = values.filter((value) => !value.unknown);
  const unknownValues = values.filter((value) => value.unknown);
  const major = knownValues.filter((value) => (value.usd / total) * 100 >= otherThresholdPct);
  const minor = knownValues.filter((value) => (value.usd / total) * 100 < otherThresholdPct);

  const slices = major.map((value) => ({
    sourceKey: value.sourceKey,
    name: value.name,
    pct: (value.usd / total) * 100,
    risk: value.risk,
    ...(value.coinId ? { coinId: value.coinId } : {}),
    ...(value.depType ? { depType: value.depType } : {}),
  }));

  if (minor.length > 0) {
    const otherUsd = minor.reduce((acc, value) => acc + value.usd, 0);
    const highestRisk = minor.some((value) => value.risk === "very-high")
      ? "very-high"
      : minor.some((value) => value.risk === "high")
        ? "high"
        : "medium";
    slices.push({
      sourceKey: "collateral-positions-api:other",
      name: "Other collateral",
      pct: (otherUsd / total) * 100,
      risk: highestRisk,
    });
  }

  if (unknownValues.length > 0) {
    slices.push({
      sourceKey: "collateral-positions-api:unknown",
      name: "Unknown assets",
      pct: (unknownExposureUsd / total) * 100,
      risk: "high",
    });
  }

  const timestampSummary = summarizeSourceTimestampsRequiringCoverage(priceTimestamps);
  if (timestampSummary.untimestampedCount > 0) {
    warnings.push(reserveDegradedWarning("price-timestamp-coverage", "Only part of the active collateral price basket has source timestamps"));
  }
  return {
    slices: normalizeSlices(slices),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      assetCount: values.length,
      collateralAssetCount: Object.keys(details).length,
      activePositionCount,
      missingPriceCount: missingPriceSymbols.size,
      unknownAssetCount: unknownValues.length,
      unknownExposurePct: total > 0 ? (unknownExposureUsd / total) * 100 : 0,
      totalReserveUsd: total,
      mintedCoverageComplete,
      debtPricesFresh,
      ...(mintedUsd > 0 && mintedCoverageComplete && debtPricesFresh
        ? {
            totalLiabilitiesUsd: mintedUsd,
            collateralizationRatio: total / mintedUsd,
          }
        : {}),
      ...(immediateRedeemableUsd != null
        ? {
            redemption: {
              capacityUsd: immediateRedeemableUsd,
              capacityKind: "live-direct-bounded" as const,
              freshnessKind: "same-run-onchain" as const,
              routeStatus: "unknown" as const,
              routeStatusSource: "static-config" as const,
              ...(redemptionOptions.routeStatusReason
                ? { routeStatusReason: redemptionOptions.routeStatusReason }
                : {}),
              holderEligibility: "any-holder" as const,
              settlementDelaySec: 0,
              ...(redemptionOptions.sourceUrls ? { sourceUrls: redemptionOptions.sourceUrls } : {}),
              ...(redemptionOptions.telemetryDetails ?? {}),
            },
          }
        : {}),
      ...freshnessMetadataFromTimestamp(
        timestampSummary.untimestampedCount === 0 ? timestampSummary.sourceTimestamp : null,
        "position-price-timestamps",
        "One or more active collateral prices lack a valid source timestamp",
      ),
    },
  };
}

async function fetchBridgeBasketImmediateRedeemableUsd(
  basket: NonNullable<PositionsApiParams["redemptionBridgeBasket"]>,
  prices: PriceMappingPayload,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<BridgeBasketProbe | null> {
  const calls = basket.bridges.flatMap((bridge, index) => {
    const label = `bridge:${index}`;
    return [
      { label: `${label}:underlying`, contract: bridge.bridgeAddress, data: BRIDGE_EUR_SELECTOR },
      { label: `${label}:deuro`, contract: bridge.bridgeAddress, data: BRIDGE_DEURO_SELECTOR },
      { label: `${label}:decimals`, contract: bridge.tokenAddress, data: ERC20_DECIMALS_SELECTOR },
      {
        label: `${label}:inventory`,
        contract: bridge.tokenAddress,
        data: encodeBalanceOfCallData(bridge.bridgeAddress),
      },
      {
        label: `${label}:minter`,
        contract: basket.dEuroAddress,
        data: `${DEURO_IS_MINTER_SELECTOR}${encodeAddress(bridge.bridgeAddress)}`,
      },
    ];
  });

  try {
    const results = await fetchOnchainMulticall3({
      calls,
      chain: basket.chain,
      signal,
      ctx,
      rpcUrl: basket.rpcUrl,
      fallbackRpcUrl: basket.fallbackRpcUrl,
      timeoutMs: 12_000,
    });
    if (!results || results.some((result) => !result.success)) return null;

    const byLabel = new Map(results.map((result) => [result.label, result.returnData]));
    const bridgeInventories: BridgeBasketProbe["bridgeInventories"] = [];
    let capacityEur = 0;

    for (const [index, bridge] of basket.bridges.entries()) {
      const label = `bridge:${index}`;
      const underlying = decodeStrictAddressWord(byLabel.get(`${label}:underlying`));
      const dEuro = decodeStrictAddressWord(byLabel.get(`${label}:deuro`));
      const decimals = decodeUint256Word(byLabel.get(`${label}:decimals`));
      const inventoryRaw = decodeUint256Word(byLabel.get(`${label}:inventory`));
      const isMinter = decodeStrictBoolWord(byLabel.get(`${label}:minter`));
      if (
        underlying !== bridge.tokenAddress.toLowerCase()
        || dEuro !== basket.dEuroAddress.toLowerCase()
        || decimals !== BigInt(bridge.tokenDecimals)
        || inventoryRaw == null
        || isMinter !== true
      ) {
        return null;
      }

      const inventoryEur = decimalNumberFromBigInt(inventoryRaw, bridge.tokenDecimals);
      if (!Number.isFinite(inventoryEur) || inventoryEur < 0) return null;
      capacityEur += inventoryEur;
      bridgeInventories.push({
        label: bridge.label,
        bridgeAddress: bridge.bridgeAddress,
        tokenAddress: bridge.tokenAddress,
        tokenDecimals: bridge.tokenDecimals,
        inventoryRaw: inventoryRaw.toString(),
        inventoryEur,
      });
    }

    const fx = prices[basket.eurUsdPriceAddress.toLowerCase()]?.price;
    const eurUsdReference = fx?.usd != null && fx?.eur != null && fx.usd > 0 && fx.eur > 0
      ? fx.usd / fx.eur
      : null;
    if (eurUsdReference == null || !Number.isFinite(eurUsdReference) || eurUsdReference <= 0) return null;

    // R1: the observed basket unit value must come from pricing each weighted
    // output token, never from the EUR/USD reference. That reference is the peg
    // *expectation* for a Euro stablecoin; reusing it as the observed value
    // pins observed === expected, so the output haircut is always zero and an
    // impaired member is scored at par. When any member is unpriced the whole
    // valuation is withheld with a named reason instead (the priced legs alone
    // cannot value the basket).
    const weightedInventories = bridgeInventories.filter((inventory) => inventory.inventoryEur > 0);
    const outputUsdPrices = weightedInventories.map(
      (inventory) => prices[inventory.tokenAddress.toLowerCase()]?.price?.usd,
    );
    const outputsPriced = outputUsdPrices.every(
      (usdPrice) => typeof usdPrice === "number" && Number.isFinite(usdPrice) && usdPrice > 0,
    );
    const valuationTimestamps = summarizeSourceTimestampsRequiringCoverage([
      prices[basket.eurUsdPriceAddress.toLowerCase()]?.timestamp,
      ...weightedInventories.map((inventory) => prices[inventory.tokenAddress.toLowerCase()]?.timestamp),
    ]);
    const nowSec = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
    const pricesFresh = valuationTimestamps.untimestampedCount === 0
      && valuationTimestamps.sourceTimestamp != null
      && valuationTimestamps.latestSourceTimestamp != null
      && nowSec - valuationTimestamps.sourceTimestamp <= LIVE_RESERVE_FRESHNESS_SEC
      && valuationTimestamps.latestSourceTimestamp <= nowSec + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC;
    const observedUnitValueUsd =
      capacityEur > 0 && outputsPriced && pricesFresh
        ? weightedInventories.reduce(
            (sum, inventory, index) =>
              sum + (inventory.inventoryEur / capacityEur) * outputUsdPrices[index]!,
            0,
          )
        : null;
    // Prefer the market value of the measured inventory; only a basket that
    // cannot be priced falls back to the nominal FX conversion of its face
    // amount, and that fallback never carries an observed valuation.
    const capacityUsd = capacityEur * (observedUnitValueUsd ?? eurUsdReference);
    if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;
    const outputValuation =
      observedUnitValueUsd != null
        ? {
            sourceId: `collateral-positions-api:deuro-bridge-basket:${basket.eurUsdPriceAddress.toLowerCase()}`,
            observedAt: valuationTimestamps.sourceTimestamp!,
            unitValueUsd: observedUnitValueUsd,
            expectedUnitValueUsd: eurUsdReference,
            basketWeights: weightedInventories.map((inventory) => ({
              assetId: DEURO_OUTPUT_ASSET_KEY_BY_LABEL[inventory.label]!,
              weight: inventory.inventoryEur / capacityEur,
            })),
          }
        : null;
    if (
      outputValuation &&
      outputValuation.basketWeights.some((weight) => weight.assetId === undefined)
    ) {
      return null;
    }
    return {
      capacityEur,
      capacityUsd,
      eurUsdReference,
      outputValuation,
      outputValuationUnavailableReason:
        capacityEur > 0 && outputValuation == null
          ? outputsPriced ? "output-price-freshness" : "output-tokens-unpriced"
          : null,
      bridgeInventories,
    };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return null;
  }
}

async function fetchBridgeImmediateRedeemableUsd(
  bridge: NonNullable<PositionsApiParams["redemptionBridge"]>,
  prices: PriceMappingPayload,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<number | null> {
  const onchainInput: LiveReserveInput = {
    kind: "onchain-evm",
    chain: bridge.chain,
    rpcMode: bridge.rpcMode,
  };

  const balance = await fetchErc20Balance(
    onchainInput,
    bridge.tokenAddress,
    bridge.holder,
    signal,
    ctx,
    bridge.rpcUrl,
    bridge.fallbackRpcUrl,
  );

  if (balance == null) return null;
  if (balance <= 0n) return 0;

  const priceInfo = prices[(bridge.priceAddress ?? bridge.tokenAddress).toLowerCase()];
  const usdPrice = priceInfo?.price?.usd;
  if (typeof usdPrice !== "number" || usdPrice <= 0) return null;

  const usdValue = valueUsdFromBigIntPrice(balance, bridge.tokenDecimals, usdPrice);
  return Number.isFinite(usdValue) && usdValue >= 0 ? usdValue : null;
}

export async function fetchCollateralPositionsApiReserves(
  _coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "collateral-positions-api");
  const params = readParams(config);

  const timeout = 12_000;
  const [details, prices] = await Promise.all([
    fetchJsonWithRetry<PositionDetailsPayload>(input.url, signal, timeout, ctx),
    fetchJsonWithRetry<PriceMappingPayload>(params.pricesUrl, signal, timeout, ctx),
  ]);

  const immediateRedeemableUsd = params.redemptionBridge
    ? await fetchBridgeImmediateRedeemableUsd(params.redemptionBridge, prices, signal, ctx)
    : null;
  const bridgeBasketProbe = params.redemptionBridgeBasket
    ? await fetchBridgeBasketImmediateRedeemableUsd(params.redemptionBridgeBasket, prices, signal, ctx)
    : null;
  const redemptionCapacityUsd = bridgeBasketProbe?.capacityUsd ?? immediateRedeemableUsd;

  return adaptCollateralPositions(
    details,
    prices,
    params.otherThresholdPct ?? 2,
    redemptionCapacityUsd,
    params.redemptionBridgeBasket && bridgeBasketProbe
      ? {
          sourceUrls: params.redemptionBridgeBasket.sourceUrls,
          routeStatusReason: bridgeBasketProbe.capacityEur > 0
            ? `All ${bridgeBasketProbe.bridgeInventories.length} configured StablecoinBridge identities passed; summed idle inventory is ${bridgeBasketProbe.capacityEur} EUR`
            : `All ${bridgeBasketProbe.bridgeInventories.length} configured StablecoinBridge identities passed, but summed idle inventory is zero`,
          telemetryDetails: {
            capacityEur: bridgeBasketProbe.capacityEur,
            eurUsdReference: bridgeBasketProbe.eurUsdReference,
            eurUsdReferenceSource: params.redemptionBridgeBasket.eurUsdPriceAddress,
            ...(bridgeBasketProbe.outputValuation
              ? { outputValuation: bridgeBasketProbe.outputValuation }
              : bridgeBasketProbe.outputValuationUnavailableReason
              ? { outputValuationUnavailableReason: bridgeBasketProbe.outputValuationUnavailableReason }
              : {}),
            bridgeInventories: bridgeBasketProbe.bridgeInventories,
          },
        }
      : params.redemptionBridge
      ? { sourceUrls: [input.url, params.pricesUrl] }
      : {},
    ctx?.nowSec,
  );
}
