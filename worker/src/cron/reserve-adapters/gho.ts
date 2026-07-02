import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { TOTAL_SUPPLY_SELECTOR, encodeAddress, encodeUint256 } from "../../lib/evm-selectors";
import { mapWithConcurrency } from "../../lib/concurrency";
import type { AdapterContext, AdapterResult } from "./types";
import { parseEvmAddressResult } from "./evm";
import {
  decimalNumberFromBigInt,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  type OnchainCallers,
  reserveDegradedWarning,
  reserveInfoWarning,
  requireOnchainInput,
  slicesFromValues,
} from "./helpers";
import { decodeAddressArrayWord, decodeBoolWord } from "./abi-decode";

const GHO_TOKEN = "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f";
const GET_FACILITATORS_LIST_SELECTOR = "0x1ec90f2e";
const GET_FACILITATOR_SELECTOR = "0xd46ec0ed";
const GET_USED_SELECTOR = "0x9abeb940";
const GET_CURRENT_BACKING_SELECTOR = "0x476cce03";
const GET_IS_FROZEN_SELECTOR = "0x236fc8ad";
const GET_IS_SEIZED_SELECTOR = "0x80bc659a";
const GET_FEE_STRATEGY_SELECTOR = "0x4101d9f4";
const GET_BUY_FEE_SELECTOR = "0x45d6494d";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ONE_GHO = 10n ** 18n;
// Keep facilitator reads below the shared adapter IO cap to avoid request
// queue explosion when the rest of the cron contends for the same pool.
const FACILITATOR_READ_CONCURRENCY = 2;
const textDecoder = new TextDecoder();

type FacilitatorRiskBucket = "aave-v3-direct" | "flashminter" | "unknown";

function classifyFacilitatorLabel(label: string): FacilitatorRiskBucket {
  const normalized = label.toLowerCase();
  if (normalized.includes("flashmint") || normalized.includes("flash mint")) {
    return "flashminter";
  }
  if (
    normalized.includes("directminter")
    || normalized.includes("direct minter")
    || normalized.includes("directfacilitator")
    || normalized.includes("direct facilitator")
    || normalized.includes("aave")
  ) {
    return "aave-v3-direct";
  }
  return "unknown";
}

function riskForFacilitatorBucket(bucket: FacilitatorRiskBucket): ReserveSlice["risk"] {
  return bucket === "aave-v3-direct" ? "medium" : "high";
}

interface GhoParams {
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  gsmModules: GhoTrackedModuleConfig[];
  ghoTokenAddress?: string;
}

export interface GhoTrackedModuleConfig {
  address: string;
  label: string;
  coinId?: string;
  depType?: ReserveSlice["depType"];
  risk?: ReserveSlice["risk"];
}

export interface GhoFacilitatorSnapshot {
  address: string;
  label: string;
  bucketLevel: bigint;
  bucketCapacity: bigint;
}

export interface GhoTrackedModuleSnapshot {
  address: string;
  label: string;
  coinId?: string;
  depType?: ReserveSlice["depType"];
  risk: ReserveSlice["risk"];
  currentBackingGho: bigint;
  swappable: boolean;
  isFrozen: boolean;
  isSeized: boolean;
  buyFeeBps: number | null;
}

export interface GhoFacilitatorData {
  facilitators: GhoFacilitatorSnapshot[];
  trackedModules: GhoTrackedModuleSnapshot[];
  totalSupply?: bigint;
}

function scale18ToUsd(value: bigint): number {
  return decimalNumberFromBigInt(value, 18);
}

function hexWords(raw: string): string[] {
  const stripped = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (stripped.length === 0 || stripped.length % 64 !== 0) return [];
  const words: string[] = [];
  for (let index = 0; index < stripped.length; index += 64) {
    words.push(stripped.slice(index, index + 64));
  }
  return words;
}

function parseUintWord(word: string): bigint {
  return BigInt(`0x${word}`);
}

function decodeFacilitator(raw: string): { bucketCapacity: bigint; bucketLevel: bigint; label: string } | null {
  const words = hexWords(raw);
  if (words.length < 5) return null;
  const base = Number(parseUintWord(words[0]) / 32n);
  if (!Number.isInteger(base) || base < 0 || base + 2 >= words.length) return null;
  const bucketCapacity = parseUintWord(words[base]);
  const bucketLevel = parseUintWord(words[base + 1]);
  const labelOffset = Number(parseUintWord(words[base + 2]) / 32n);
  const labelIndex = base + labelOffset;
  if (!Number.isInteger(labelIndex) || labelIndex < 0 || labelIndex >= words.length) return null;
  const labelLength = Number(parseUintWord(words[labelIndex]));
  if (!Number.isInteger(labelLength) || labelLength < 0) return null;
  const byteWordLength = Math.ceil(labelLength / 32);
  if (labelIndex + 1 + byteWordLength > words.length) return null;
  const labelHex = words
    .slice(labelIndex + 1, labelIndex + 1 + byteWordLength)
    .join("")
    .slice(0, labelLength * 2);
  const labelBytes = new Uint8Array(labelLength);
  for (let index = 0; index < labelLength; index += 1) {
    labelBytes[index] = Number.parseInt(labelHex.slice(index * 2, index * 2 + 2), 16);
  }
  return {
    bucketCapacity,
    bucketLevel,
    label: textDecoder.decode(labelBytes),
  };
}

function decodeCurrentBacking(raw: string): { excess: bigint; deficit: bigint } | null {
  const words = hexWords(raw);
  if (words.length < 2) return null;
  return {
    excess: parseUintWord(words[0]),
    deficit: parseUintWord(words[1]),
  };
}

function readParams(config: LiveReservesConfig): GhoParams {
  const params = parseLiveReserveAdapterParams("gho", config.params);
  return {
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    gsmModules: params.gsmModules.map((trackedModule) => ({
      address: trackedModule.address,
      label: trackedModule.label,
      coinId: trackedModule.coinId,
      depType: trackedModule.depType,
      risk: trackedModule.risk,
    })),
    ghoTokenAddress: params.ghoTokenAddress,
  };
}

async function loadFacilitators(
  onchain: OnchainCallers,
  ghoToken: string,
): Promise<{ facilitators: GhoFacilitatorSnapshot[]; warnings: LiveReserveWarning[] }> {
  const warnings: LiveReserveWarning[] = [];
  const facilitatorListRaw = await onchain.raw(ghoToken, GET_FACILITATORS_LIST_SELECTOR);
  if (!facilitatorListRaw) {
    return {
      facilitators: [],
      warnings: [
        reserveDegradedWarning(
          "facilitator-registry-unavailable",
          "GHO facilitator registry could not be read; residual issuance remains unlabeled",
        ),
      ],
    };
  }

  const facilitatorAddresses = decodeAddressArrayWord(facilitatorListRaw);
  if (!facilitatorAddresses) {
    return {
      facilitators: [],
      warnings: [
        reserveDegradedWarning(
          "facilitator-registry-unparseable",
          "GHO facilitator registry response could not be decoded; residual issuance remains unlabeled",
        ),
      ],
    };
  }

  const facilitators: GhoFacilitatorSnapshot[] = [];
  const facilitatorResults = await mapWithConcurrency(
    facilitatorAddresses,
    FACILITATOR_READ_CONCURRENCY,
    async (address) => {
      const facilitatorRaw = await onchain.raw(ghoToken, GET_FACILITATOR_SELECTOR + encodeAddress(address));
      if (!facilitatorRaw) {
        return {
          facilitator: null,
          warnings: [reserveDegradedWarning(
            "facilitator-read-failed",
            `GHO facilitator metadata could not be read for ${address}`,
          )],
        };
      }
      const decoded = decodeFacilitator(facilitatorRaw);
      if (!decoded) {
        return {
          facilitator: null,
          warnings: [reserveDegradedWarning(
            "facilitator-read-unparseable",
            `GHO facilitator metadata could not be decoded for ${address}`,
          )],
        };
      }
      return {
        facilitator: {
          address,
          label: decoded.label,
          bucketLevel: decoded.bucketLevel,
          bucketCapacity: decoded.bucketCapacity,
        } satisfies GhoFacilitatorSnapshot,
        warnings: [] as LiveReserveWarning[],
      };
    });

  for (const result of facilitatorResults) {
    warnings.push(...result.warnings);
    if (result.facilitator) {
      facilitators.push(result.facilitator);
    }
  }

  return { facilitators, warnings };
}

async function loadTrackedModule(
  trackedModule: GhoTrackedModuleConfig,
  onchain: OnchainCallers,
): Promise<{ module: GhoTrackedModuleSnapshot | null; warnings: LiveReserveWarning[] }> {
  const warnings: LiveReserveWarning[] = [];

  const [used, currentBackingRaw, isFrozenRaw, isSeizedRaw, feeStrategyRaw] = await Promise.all([
    onchain.uint256(trackedModule.address, GET_USED_SELECTOR),
    onchain.raw(trackedModule.address, GET_CURRENT_BACKING_SELECTOR),
    onchain.raw(trackedModule.address, GET_IS_FROZEN_SELECTOR),
    onchain.raw(trackedModule.address, GET_IS_SEIZED_SELECTOR),
    onchain.raw(trackedModule.address, GET_FEE_STRATEGY_SELECTOR),
  ]);

  if (used == null || !currentBackingRaw) {
    warnings.push(reserveDegradedWarning(
      "tracked-gsm-read-failed",
      `GHO tracked GSM module "${trackedModule.label}" could not be read on-chain`,
    ));
    return { module: null, warnings };
  }

  const currentBacking = decodeCurrentBacking(currentBackingRaw);
  if (!currentBacking) {
    warnings.push(reserveDegradedWarning(
      "tracked-gsm-read-unparseable",
      `GHO tracked GSM module "${trackedModule.label}" returned an unparseable backing response`,
    ));
    return { module: null, warnings };
  }

  const isFrozen = decodeBoolWord(isFrozenRaw);
  const isSeized = decodeBoolWord(isSeizedRaw);
  if (isFrozen == null || isSeized == null) {
    warnings.push(reserveDegradedWarning(
      "tracked-gsm-status-unavailable",
      `GHO tracked GSM module "${trackedModule.label}" status could not be fully decoded; immediate redeemability is treated conservatively`,
    ));
  }

  const currentBackingGho =
    currentBacking.deficit > 0n
      ? used > currentBacking.deficit
        ? used - currentBacking.deficit
        : 0n
      : used + currentBacking.excess;
  const swappable = isFrozen === false && isSeized === false;

  let buyFeeBps: number | null = null;
  const feeStrategyAddress =
    feeStrategyRaw && feeStrategyRaw !== "0x" ? parseEvmAddressResult(feeStrategyRaw as `0x${string}`) : null;
  if (feeStrategyAddress && feeStrategyAddress !== ZERO_ADDRESS) {
    const buyFee = await onchain.uint256(feeStrategyAddress, GET_BUY_FEE_SELECTOR + encodeUint256(ONE_GHO));
    if (buyFee != null) {
      buyFeeBps = Number((buyFee * 10_000n) / ONE_GHO);
    }
  }

  if (isFrozen) {
    warnings.push(reserveInfoWarning(
      "tracked-gsm-frozen",
      `GHO tracked GSM module "${trackedModule.label}" is currently frozen and excluded from immediate redeemable capacity`,
    ));
  }
  if (isSeized) {
    warnings.push(reserveInfoWarning(
      "tracked-gsm-seized",
      `GHO tracked GSM module "${trackedModule.label}" is currently seized and excluded from immediate redeemable capacity`,
    ));
  }

  return {
    module: {
      address: trackedModule.address,
      label: trackedModule.label,
      coinId: trackedModule.coinId,
      risk: trackedModule.risk ?? "low",
      currentBackingGho,
      swappable,
      isFrozen: isFrozen ?? true,
      isSeized: isSeized ?? false,
      buyFeeBps,
    },
    warnings,
  };
}

export interface GhoFacilitatorAllocation {
  facilitator: GhoFacilitatorSnapshot;
  share: bigint;
}

interface GhoSliceValue {
  name: string;
  value: number;
  risk: ReserveSlice["risk"];
  coinId?: string;
}

export interface GhoRedemptionTelemetry {
  immediateRedeemableRaw: bigint;
  immediateRedeemableUsd: number;
  immediateRedeemableRatio?: number;
  redemptionFeeBps?: number;
}

/**
 * Allocate a residual GHO exposure across facilitators proportional to each
 * facilitator's `bucketLevel`. Pure: takes the facilitator list and a residual
 * raw amount (18-decimal GHO units) and emits one entry per active facilitator
 * (bucketLevel > 0). Returns an empty array if no facilitators have a positive
 * bucket level — the caller decides whether to synthesize a fallback slice.
 *
 * Invariants:
 *   - `sum(allocations[*].share) === residualRaw` when at least one
 *     facilitator has bucketLevel > 0n (any rounding dust is folded into the
 *     final allocation so the residual is fully accounted for).
 *   - Allocation order matches the order of active facilitators in the input.
 */
export function allocateResidualByBucketLevel(
  facilitators: readonly GhoFacilitatorSnapshot[],
  residualRaw: bigint,
): GhoFacilitatorAllocation[] {
  if (residualRaw <= 0n) return [];
  const activeWithLevel = facilitators.filter((f) => f.bucketLevel > 0n);
  const totalActiveBucketLevel = activeWithLevel.reduce((sum, f) => sum + f.bucketLevel, 0n);
  if (totalActiveBucketLevel <= 0n) return [];

  let allocated = 0n;
  return activeWithLevel.map((facilitator, idx) => {
    const share = idx === activeWithLevel.length - 1
      ? residualRaw - allocated
      : (residualRaw * facilitator.bucketLevel) / totalActiveBucketLevel;
    allocated += share;
    return { facilitator, share };
  });
}

/**
 * Build the `ReserveSlice` value list from tracked GSM modules plus residual
 * facilitator allocations. Classifies each facilitator label via
 * `classifyFacilitatorLabel` and accumulates the raw GHO exposure routed
 * through "unknown" labels.
 *
 * If `residualRaw > 0n` but `facilitatorAllocations` is empty, a synthetic
 * "Residual facilitators / reserve buffer" high-risk slice is emitted and the
 * full residual is counted as unknown exposure.
 *
 * Invariants:
 *   - Tracked modules with `currentBackingGho <= 0n` are skipped.
 *   - `unknownResidualRaw` only accumulates `bucket === "unknown"` shares plus
 *     the no-facilitator-labels fallback.
 */
export function buildGhoSlices(
  trackedModules: readonly GhoTrackedModuleSnapshot[],
  facilitatorAllocations: readonly GhoFacilitatorAllocation[],
  residualRaw: bigint,
): { values: GhoSliceValue[]; unknownResidualRaw: bigint } {
  const values: GhoSliceValue[] = [];
  for (const trackedModule of trackedModules) {
    if (trackedModule.currentBackingGho <= 0n) continue;
    values.push({
      name: trackedModule.label,
      value: scale18ToUsd(trackedModule.currentBackingGho),
      risk: trackedModule.risk,
      ...(trackedModule.coinId ? { coinId: trackedModule.coinId } : {}),
      ...(trackedModule.depType ? { depType: trackedModule.depType } : {}),
    });
  }

  let unknownResidualRaw = 0n;
  if (residualRaw > 0n) {
    if (facilitatorAllocations.length > 0) {
      for (const { facilitator, share } of facilitatorAllocations) {
        if (share <= 0n) continue;
        const bucket = classifyFacilitatorLabel(facilitator.label);
        if (bucket === "unknown") unknownResidualRaw += share;
        values.push({
          name: facilitator.label,
          value: scale18ToUsd(share),
          risk: riskForFacilitatorBucket(bucket),
        });
      }
    } else {
      // No facilitator labels available — treat residual as unknown exposure.
      unknownResidualRaw = residualRaw;
      values.push({
        name: "Residual facilitators / reserve buffer",
        value: scale18ToUsd(residualRaw),
        risk: "high",
      });
    }
  }

  return { values, unknownResidualRaw };
}

/**
 * Pure constructor for the `redemption: {…}` block inside the GHO adapter
 * metadata. Encodes the GSM redemption telemetry (capacity USD, capacity
 * ratio, fee, route status) in the shape expected by downstream validators.
 *
 * Invariants:
 *   - `routeStatus === "open"` iff `immediateRedeemableRaw > 0n`.
 *   - Optional fields (`capacityRatioOfSupply`, `feeBps`) are omitted when
 *     undefined — the redemption schema treats absence as "not reported".
 */
export function buildGhoRedemptionMetadata(telemetry: GhoRedemptionTelemetry) {
  const { immediateRedeemableRaw, immediateRedeemableUsd, immediateRedeemableRatio, redemptionFeeBps } = telemetry;
  return {
    capacityUsd: immediateRedeemableUsd,
    ...(immediateRedeemableRatio != null ? { capacityRatioOfSupply: immediateRedeemableRatio } : {}),
    capacityKind: "live-direct" as const,
    freshnessKind: "same-run-onchain" as const,
    routeStatus: immediateRedeemableRaw > 0n ? ("open" as const) : ("paused" as const),
    routeStatusSource: "onchain" as const,
    holderEligibility: "any-holder" as const,
    settlementDelaySec: 0,
    ...(redemptionFeeBps != null ? { feeBps: redemptionFeeBps } : {}),
    sourceUrls: ["https://aave.com/help/gho-stablecoin/stability-module"],
  };
}

export function adaptGhoFacilitators(data: GhoFacilitatorData): AdapterResult {
  const trackedBackingRaw = data.trackedModules.reduce(
    (sum, trackedModule) => sum + trackedModule.currentBackingGho,
    0n,
  );
  const residualRaw =
    typeof data.totalSupply === "bigint" && data.totalSupply > trackedBackingRaw
      ? data.totalSupply - trackedBackingRaw
      : 0n;
  const immediateRedeemableRaw = data.trackedModules
    .filter((trackedModule) => trackedModule.swappable)
    .reduce((sum, trackedModule) => sum + trackedModule.currentBackingGho, 0n);

  const allocations = allocateResidualByBucketLevel(data.facilitators, residualRaw);
  const { values, unknownResidualRaw } = buildGhoSlices(data.trackedModules, allocations, residualRaw);

  if (values.length === 0) return { slices: [] };

  const activeFacilitators = data.facilitators.filter((facilitator) => facilitator.bucketLevel > 0n);
  const immediateRedeemableUsd = scale18ToUsd(immediateRedeemableRaw);
  const immediateRedeemableRatio =
    typeof data.totalSupply === "bigint" && data.totalSupply > 0n
      ? immediateRedeemableUsd / scale18ToUsd(data.totalSupply)
      : undefined;
  const buyFeeBpsValues = data.trackedModules
    .map((trackedModule) => trackedModule.buyFeeBps)
    .filter((fee): fee is number => typeof fee === "number" && Number.isFinite(fee));
  const redemptionFeeBps = buyFeeBpsValues.length > 0 ? Math.max(...buyFeeBpsValues) : undefined;

  const supplyUsd = typeof data.totalSupply === "bigint" ? scale18ToUsd(data.totalSupply) : 0;
  const unknownExposurePct = supplyUsd > 0
    ? (scale18ToUsd(unknownResidualRaw) / supplyUsd) * 100
    : 0;

  return {
    slices: slicesFromValues(values),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "aave-gho-onchain-facilitators",
      }),
      facilitatorCount: data.facilitators.length,
      activeFacilitatorCount: activeFacilitators.length,
      trackedGsmCount: data.trackedModules.length,
      activeTrackedGsmCount: data.trackedModules.filter((trackedModule) => trackedModule.currentBackingGho > 0n).length,
      swappableTrackedGsmCount: data.trackedModules.filter(
        (trackedModule) => trackedModule.swappable && trackedModule.currentBackingGho > 0n,
      ).length,
      trackedGsmBackingUsd: scale18ToUsd(trackedBackingRaw),
      residualSupplyUsd: residualRaw > 0n ? scale18ToUsd(residualRaw) : 0,
      immediateRedeemableUsd,
      ...(immediateRedeemableRatio != null ? { immediateRedeemableRatio } : {}),
      ...(typeof data.totalSupply === "bigint" ? { supplyUsd, totalReserveUsd: supplyUsd } : {}),
      ...(typeof data.totalSupply === "bigint" ? { onchainSupplyUsd: supplyUsd } : {}),
      ...(unknownExposurePct > 0 ? { unknownExposurePct } : {}),
      ...(buyFeeBpsValues.length > 0
        ? {
            redemptionFeeBps,
            buyFeeBpsMin: Math.min(...buyFeeBpsValues),
            buyFeeBpsMax: redemptionFeeBps,
          }
        : {}),
      redemption: buildGhoRedemptionMetadata({
        immediateRedeemableRaw,
        immediateRedeemableUsd,
        immediateRedeemableRatio,
        redemptionFeeBps,
      }),
      facilitatorLabels: activeFacilitators.map((facilitator) => facilitator.label),
      trackedGsmLabels: data.trackedModules.map((trackedModule) => trackedModule.label),
    },
  };
}

export async function fetchGhoReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "gho");
  if (input.chain !== "ethereum") {
    throw new Error(`gho adapter only supports ethereum, got "${input.chain}"`);
  }

  const params = readParams(config);
  const ghoToken = params.ghoTokenAddress ?? GHO_TOKEN;
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });

  const totalSupply = await onchain.uint256(ghoToken, TOTAL_SUPPLY_SELECTOR);
  if (totalSupply == null) {
    throw new Error("gho: failed to read totalSupply()");
  }

  const [{ facilitators, warnings: facilitatorWarnings }, trackedResults] = await Promise.all([
    loadFacilitators(onchain, ghoToken),
    Promise.all(params.gsmModules.map((trackedModule) => loadTrackedModule(trackedModule, onchain))),
  ]);

  const trackedModules = trackedResults.flatMap((result) => (result.module ? [result.module] : []));
  const warnings: LiveReserveWarning[] = [
    ...facilitatorWarnings,
    ...trackedResults.flatMap((result) => result.warnings),
  ];

  const adapted = adaptGhoFacilitators({
    facilitators,
    trackedModules,
    totalSupply,
  });

  // Residual decomposition and unknownExposurePct are now computed inside
  // adaptGhoFacilitators. The standard material-unknown-exposure validator
  // picks up unmapped facilitator labels from metadata.unknownExposurePct.
  return warnings.length > 0
    ? { ...adapted, warnings: [...(adapted.warnings ?? []), ...warnings] }
    : adapted;
}
