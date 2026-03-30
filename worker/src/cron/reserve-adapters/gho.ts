import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveInput, LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import { parseEvmAddressResult } from "./evm";
import {
  decimalNumberFromBigInt,
  fetchOnchainRawCall,
  fetchOnchainUint256,
  notApplicableFreshnessMetadata,
  reserveDegradedWarning,
  reserveInfoWarning,
  requireOnchainInput,
  slicesFromValues,
} from "./helpers";

const GHO_TOKEN = "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f";
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
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
const FACILITATOR_READ_CONCURRENCY = 4;
const RESIDUAL_DEGRADED_THRESHOLD_PCT = 1;
const textDecoder = new TextDecoder();

interface GhoParams {
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  gsmModules: GhoTrackedModuleConfig[];
}

type OnchainGhoInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;
type GhoCallOpts = Pick<OnchainGhoInput, "rpcMode" | "chain"> & {
  rpcUrl?: string;
  fallbackRpcUrl?: string;
};

export interface GhoTrackedModuleConfig {
  address: string;
  label: string;
  coinId?: string;
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

function normalizeAddress(value: string): string {
  return value.toLowerCase();
}

function scale18ToUsd(value: bigint): number {
  return decimalNumberFromBigInt(value, 18);
}

function encodeAddressArg(address: string): string {
  return normalizeAddress(address).slice(2).padStart(64, "0");
}

function encodeUint256Arg(value: bigint): string {
  return value.toString(16).padStart(64, "0");
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

function decodeBool(raw: string): boolean | null {
  const words = hexWords(raw);
  if (words.length < 1) return null;
  return parseUintWord(words[0]) !== 0n;
}

function decodeAddressArray(raw: string): string[] | null {
  const words = hexWords(raw);
  if (words.length < 2) return null;
  const start = Number(parseUintWord(words[0]) / 32n);
  if (!Number.isInteger(start) || start < 0 || start >= words.length) return null;
  const length = Number(parseUintWord(words[start]));
  if (!Number.isInteger(length) || length < 0 || start + 1 + length > words.length) return null;
  return words.slice(start + 1, start + 1 + length).map((word) => `0x${word.slice(-40).toLowerCase()}`);
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
      risk: trackedModule.risk,
    })),
  };
}

async function mapWithConcurrency<T, TResult>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<TResult>,
): Promise<TResult[]> {
  if (values.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, values.length));
  const results = new Array<TResult>(values.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: limit }, async () => {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex]);
    }
  }));

  return results;
}

async function loadFacilitators(
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  callOpts: GhoCallOpts,
): Promise<{ facilitators: GhoFacilitatorSnapshot[]; warnings: LiveReserveWarning[] }> {
  const warnings: LiveReserveWarning[] = [];
  const facilitatorListRaw = await fetchOnchainRawCall({
    contract: GHO_TOKEN,
    data: GET_FACILITATORS_LIST_SELECTOR,
    signal,
    ctx,
    rpcMode: callOpts.rpcMode,
    chain: callOpts.chain,
    rpcUrl: callOpts.rpcUrl,
    fallbackRpcUrl: callOpts.fallbackRpcUrl,
  });
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

  const facilitatorAddresses = decodeAddressArray(facilitatorListRaw);
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
    const facilitatorRaw = await fetchOnchainRawCall({
      contract: GHO_TOKEN,
      data: GET_FACILITATOR_SELECTOR + encodeAddressArg(address),
      signal,
      ctx,
      rpcMode: callOpts.rpcMode,
      chain: callOpts.chain,
      rpcUrl: callOpts.rpcUrl,
      fallbackRpcUrl: callOpts.fallbackRpcUrl,
    });
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
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  callOpts: GhoCallOpts,
): Promise<{ module: GhoTrackedModuleSnapshot | null; warnings: LiveReserveWarning[] }> {
  const warnings: LiveReserveWarning[] = [];
  const moduleCallOpts = {
    signal,
    ctx,
    rpcMode: callOpts.rpcMode,
    chain: callOpts.chain,
    rpcUrl: callOpts.rpcUrl,
    fallbackRpcUrl: callOpts.fallbackRpcUrl,
    contract: trackedModule.address,
  };

  const [used, currentBackingRaw, isFrozenRaw, isSeizedRaw, feeStrategyRaw] = await Promise.all([
    fetchOnchainUint256({ ...moduleCallOpts, data: GET_USED_SELECTOR }),
    fetchOnchainRawCall({ ...moduleCallOpts, data: GET_CURRENT_BACKING_SELECTOR }),
    fetchOnchainRawCall({ ...moduleCallOpts, data: GET_IS_FROZEN_SELECTOR }),
    fetchOnchainRawCall({ ...moduleCallOpts, data: GET_IS_SEIZED_SELECTOR }),
    fetchOnchainRawCall({ ...moduleCallOpts, data: GET_FEE_STRATEGY_SELECTOR }),
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

  const isFrozen = decodeBool(isFrozenRaw ?? "");
  const isSeized = decodeBool(isSeizedRaw ?? "");
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
    const buyFee = await fetchOnchainUint256({
      contract: feeStrategyAddress,
      data: GET_BUY_FEE_SELECTOR + encodeUint256Arg(ONE_GHO),
      signal,
      ctx,
      rpcMode: callOpts.rpcMode,
      chain: callOpts.chain,
      rpcUrl: callOpts.rpcUrl,
      fallbackRpcUrl: callOpts.fallbackRpcUrl,
    });
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

  const values: Array<{ name: string; value: number; risk: ReserveSlice["risk"]; coinId?: string }> = [];
  for (const trackedModule of data.trackedModules) {
    if (trackedModule.currentBackingGho <= 0n) continue;
    values.push({
      name: trackedModule.label,
      value: scale18ToUsd(trackedModule.currentBackingGho),
      risk: trackedModule.risk,
      ...(trackedModule.coinId ? { coinId: trackedModule.coinId } : {}),
    });
  }
  if (residualRaw > 0n) {
    values.push({
      name: "Residual facilitators / reserve buffer",
      value: scale18ToUsd(residualRaw),
      risk: "medium",
    });
  }

  if (values.length === 0) return { slices: [] };

  const activeFacilitators = data.facilitators.filter((facilitator) => facilitator.bucketLevel > 0n);
  const buyFeeBpsValues = data.trackedModules
    .map((trackedModule) => trackedModule.buyFeeBps)
    .filter((fee): fee is number => typeof fee === "number" && Number.isFinite(fee));

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
      immediateRedeemableUsd: scale18ToUsd(immediateRedeemableRaw),
      ...(typeof data.totalSupply === "bigint" && data.totalSupply > 0n
        ? { immediateRedeemableRatio: scale18ToUsd(immediateRedeemableRaw) / scale18ToUsd(data.totalSupply) }
        : {}),
      ...(typeof data.totalSupply === "bigint" ? { supplyUsd: scale18ToUsd(data.totalSupply), totalReserveUsd: scale18ToUsd(data.totalSupply) } : {}),
      ...(typeof data.totalSupply === "bigint" ? { onchainSupplyUsd: scale18ToUsd(data.totalSupply) } : {}),
      ...(buyFeeBpsValues.length > 0
        ? {
            redemptionFeeBps: Math.max(...buyFeeBpsValues),
            buyFeeBpsMin: Math.min(...buyFeeBpsValues),
            buyFeeBpsMax: Math.max(...buyFeeBpsValues),
          }
        : {}),
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
  const callOpts = {
    rpcMode: input.rpcMode,
    chain: input.chain,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  };

  const totalSupply = await fetchOnchainUint256({
    contract: GHO_TOKEN,
    data: TOTAL_SUPPLY_SELECTOR,
    signal,
    ctx,
    ...callOpts,
  });
  if (totalSupply == null) {
    throw new Error("gho: failed to read totalSupply()");
  }

  const [{ facilitators, warnings: facilitatorWarnings }, trackedResults] = await Promise.all([
    loadFacilitators(signal, ctx, callOpts),
    Promise.all(params.gsmModules.map((trackedModule) => loadTrackedModule(trackedModule, signal, ctx, callOpts))),
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

  const trackedBackingRaw = trackedModules.reduce((sum, trackedModule) => sum + trackedModule.currentBackingGho, 0n);
  if (trackedBackingRaw < totalSupply) {
    const activeLabels = facilitators
      .filter((facilitator) => facilitator.bucketLevel > 0n)
      .map((facilitator) => facilitator.label);
    const residualPct = totalSupply > 0n ? Number((totalSupply - trackedBackingRaw) * 10_000n / totalSupply) / 100 : 0;
    const message =
      activeLabels.length > 0
        ? `Residual GHO issuance outside tracked GSM backing remains aggregated (${activeLabels.join(", ")})`
        : "Residual GHO issuance outside tracked GSM backing remains aggregated";
    warnings.push(
      residualPct > RESIDUAL_DEGRADED_THRESHOLD_PCT
        ? reserveDegradedWarning("aggregated-residual-issuance", `${message} (${residualPct.toFixed(2)}%)`)
        : reserveInfoWarning("aggregated-residual-issuance", `${message} (${residualPct.toFixed(2)}%)`),
    );
  }

  return warnings.length > 0 ? { ...adapted, warnings } : adapted;
}
