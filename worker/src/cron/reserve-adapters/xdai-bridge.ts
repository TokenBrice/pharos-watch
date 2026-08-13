import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import {
  fetchEvmBlockHeader,
  fetchEvmBlockHeaderAtTag,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmStorageAtBlock,
  type EvmBlockHeader,
  type EvmMulticall3Call,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import { encodeAddress } from "../../lib/evm-selectors";
import { decodeStrictAddressWord, decodeUint256Word } from "./abi-decode";
import { runAdapterIo } from "./concurrency";
import { multicallResultByLabel } from "./onchain-identity";
import { normalizeSlices, decimalNumberFromBigInt } from "./slice-math";
import { reserveDegradedWarning, reserveInfoWarning } from "./warnings";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "xdai-bridge";
const ETHEREUM_CHAIN = "ethereum";
const GNOSIS_CHAIN = "gnosis";
const RATIO_SCALE = 1_000_000_000_000n;

const DEFAULTS = {
  maxBlockAgeSec: 1_800,
  maxFutureBlockSkewSec: 60,
  crossChainSkewWarningSec: 30,
  maxCrossChainSkewSec: 60,
  coverageShortfallWarningRatio: 0.995,
  surplusWarningRatio: 1.05,
  maxSurplusRatio: 1.2,
  legacyWarningPct: 0.01,
  legacyMaterialityPct: 0.1,
  maxWithdrawDivergencePct: 1,
  rpcTimeoutMs: 3_000,
  attemptBudgetMs: 19_000,
  maxAlignmentProbeCount: 20,
} as const;

const SELECTORS = {
  daiToken: "0xbe22f546",
  sDaiToken: "0x3853b7a1",
  erc20token: "0x1dcea427",
  isInterestEnabled: "0xd2ef8660",
  investedAmount: "0xcff77444",
  balanceOf: "0x70a08231",
  asset: "0x38d52e0f",
  convertToAssets: "0x07a2d13a",
  maxWithdraw: "0xce96cb77",
  decimals: "0x313ce567",
  mintedTotallyByBridge: "0xb4a523e8",
  totalBurntCoins: "0x0e8162ba",
  blockRewardContract: "0x56b54bae",
  usdsDepositContract: "0xd7ef34bc",
  getBridgeMode: "0x437764df",
} as const;

// keccak256(abi.encode(bytes32("bridgeOnOtherSide"), uint256(2))) for the
// EternalStorage addressStorage mapping (slot 2).
const FOREIGN_BRIDGE_OTHER_SIDE_STORAGE_SLOT =
  "0x21ffdf150a5d180f96d98d16f50e7b4dd63e2a067adc8386cf5af55dcecd8dd9";

export type XdaiBridgeParams = LiveReserveAdapterParamsByKey["xdai-bridge"];

export interface XdaiBridgeBlock extends EvmBlockHeader {
  finalityTag: "safe" | "finalized";
}

export interface XdaiBridgeObservation {
  ethereumBlock: XdaiBridgeBlock;
  gnosisBlock: XdaiBridgeBlock;
  liquidUsds: bigint;
  susdsShares: bigint;
  susdsAssets: bigint;
  susdsMaxWithdraw: bigint;
  investedUsds: bigint;
  interestEnabled: boolean;
  legacyDai: bigint;
  legacySdai: bigint;
  outstanding: bigint;
}

function encodeAddressCall(selector: string, address: string): `0x${string}` {
  return `${selector}${encodeAddress(address)}` as `0x${string}`;
}

function call(label: string, contract: string, data: string): EvmMulticall3Call {
  return { label, target: contract, callData: data, allowFailure: true };
}

function requireResult(results: readonly EvmMulticall3Result[], label: string): `0x${string}` {
  const raw = multicallResultByLabel(results, label);
  if (raw == null) throw new Error(`${ADAPTER_KEY}: ${label} returned no successful payload`);
  return raw;
}

function requireUint(results: readonly EvmMulticall3Result[], label: string): bigint {
  const value = decodeUint256Word(requireResult(results, label));
  if (value == null) throw new Error(`${ADAPTER_KEY}: ${label} returned malformed uint256 payload`);
  return value;
}

function requireAddress(results: readonly EvmMulticall3Result[], label: string): string {
  const value = decodeStrictAddressWord(requireResult(results, label));
  if (value == null) throw new Error(`${ADAPTER_KEY}: ${label} returned malformed address payload`);
  return value.toLowerCase();
}

function requireBool(results: readonly EvmMulticall3Result[], label: string): boolean {
  const value = requireUint(results, label);
  if (value !== 0n && value !== 1n) throw new Error(`${ADAPTER_KEY}: ${label} returned malformed bool payload`);
  return value === 1n;
}

function requireBridgeMode(results: readonly EvmMulticall3Result[], label: string): void {
  const raw = requireResult(results, label);
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw) || raw.slice(2, 10).toLowerCase() !== "18762d46") {
    throw new Error(`${ADAPTER_KEY}: ${label} identity mismatch`);
  }
}

function requireExactAddress(actual: string, expected: string, label: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${ADAPTER_KEY}: ${label} identity mismatch (${actual} != ${expected})`);
  }
}

function requireDecimals(results: readonly EvmMulticall3Result[], label: string): void {
  if (requireUint(results, label) !== 18n) {
    throw new Error(`${ADAPTER_KEY}: ${label} decimals drifted from reviewed 18 decimals`);
  }
}

function ratioFromBigInts(numerator: bigint, denominator: bigint, label: string): number {
  if (denominator <= 0n) throw new Error(`${ADAPTER_KEY}: ${label} denominator must be positive`);
  const scaled = (numerator * RATIO_SCALE) / denominator;
  const ratio = Number(scaled) / Number(RATIO_SCALE);
  if (!Number.isFinite(ratio) || ratio < 0) throw new Error(`${ADAPTER_KEY}: ${label} is not finite`);
  return ratio;
}

function percentageFromBigInts(numerator: bigint, denominator: bigint, label: string): number {
  return ratioFromBigInts(numerator, denominator, label) * 100;
}

function relativeDifferencePct(left: bigint, right: bigint, label: string): number {
  if (right <= 0n) throw new Error(`${ADAPTER_KEY}: ${label} reference must be positive`);
  const difference = left >= right ? left - right : right - left;
  return percentageFromBigInts(difference, right, label);
}

function blockFromHeader(header: EvmBlockHeader, finalityTag: XdaiBridgeBlock["finalityTag"]): XdaiBridgeBlock {
  if (
    !Number.isSafeInteger(header.number) ||
    header.number < 0 ||
    !Number.isSafeInteger(header.timestamp) ||
    header.timestamp <= 0 ||
    !/^0x[0-9a-f]{64}$/.test(header.hash)
  ) {
    throw new Error(`${ADAPTER_KEY}: finalized block header was malformed`);
  }
  return { ...header, finalityTag };
}

function addressRpcOptions(
  chain: string,
  params: XdaiBridgeParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  deadlineMs: number,
) {
  const isEthereum = chain === ETHEREUM_CHAIN;
  const rpcUrl = isEthereum ? params.ethereumRpcUrl : params.gnosisRpcUrl;
  const fallbackRpcUrl = isEthereum ? params.ethereumFallbackRpcUrl : params.gnosisFallbackRpcUrl;
  return {
    extraRpcUrls: [rpcUrl, fallbackRpcUrl].filter((value): value is string => value != null),
    signal,
    timeoutMs: DEFAULTS.rpcTimeoutMs,
    maxRetries: 0,
    deadlineMs,
    chainRpcs: ctx?.chainRpcs,
  };
}

async function readFinalizedBlock(
  chain: string,
  params: XdaiBridgeParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  deadlineMs: number,
  nowSec: number,
): Promise<XdaiBridgeBlock> {
  const header = await runAdapterIo(
    ctx,
    `${ADAPTER_KEY}:${chain}:finalized-header`,
    () => fetchEvmBlockHeaderAtTag(
      chain,
      params.finalityTag ?? "finalized",
      addressRpcOptions(chain, params, signal, ctx, deadlineMs),
    ),
    { signal },
  );
  if (header == null) throw new Error(`${ADAPTER_KEY}: ${chain} finalized block header unavailable`);
  const block = blockFromHeader(header, params.finalityTag ?? "finalized");
  const maxAgeSec = params.maxBlockAgeSec ?? DEFAULTS.maxBlockAgeSec;
  const futureSkewSec = params.maxFutureBlockSkewSec ?? DEFAULTS.maxFutureBlockSkewSec;
  if (block.timestamp > nowSec + futureSkewSec) {
    throw new Error(`${ADAPTER_KEY}: ${chain} finalized block timestamp is in the future`);
  }
  if (nowSec - block.timestamp > maxAgeSec) {
    throw new Error(`${ADAPTER_KEY}: ${chain} finalized block is stale`);
  }
  return block;
}

async function recheckBlockHash(
  chain: string,
  block: XdaiBridgeBlock,
  params: XdaiBridgeParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  deadlineMs: number,
): Promise<void> {
  const header = await runAdapterIo(
    ctx,
    `${ADAPTER_KEY}:${chain}:reorg-check`,
    () => fetchEvmBlockHeader(chain, block.number, addressRpcOptions(chain, params, signal, ctx, deadlineMs)),
    { signal },
  );
  if (
    header == null ||
    header.number !== block.number ||
    header.timestamp !== block.timestamp ||
    header.hash.toLowerCase() !== block.hash.toLowerCase()
  ) {
    throw new Error(`${ADAPTER_KEY}: ${chain} finalized block changed during the read`);
  }
}

async function readExplicitBlock(
  chain: string,
  blockNumber: number,
  finalityTag: XdaiBridgeBlock["finalityTag"],
  params: XdaiBridgeParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  deadlineMs: number,
): Promise<XdaiBridgeBlock> {
  const header = await runAdapterIo(
    ctx,
    `${ADAPTER_KEY}:${chain}:alignment-header:${blockNumber}`,
    () => fetchEvmBlockHeader(chain, blockNumber, addressRpcOptions(chain, params, signal, ctx, deadlineMs)),
    { signal },
  );
  if (header == null) throw new Error(`${ADAPTER_KEY}: ${chain} alignment block header unavailable`);
  return blockFromHeader(header, finalityTag);
}

/**
 * Finalized tags do not represent a common cross-chain instant. When the
 * finalized anchors differ materially, walk backward on the newer chain and
 * binary-search an explicit block at or before the older anchor's timestamp.
 * Every candidate is at or below the finalized anchor, so the aligned block
 * remains finality-bounded without using a latest-state read for balances.
 */
async function alignFinalizedBlocks(
  ethereumAnchor: XdaiBridgeBlock,
  gnosisAnchor: XdaiBridgeBlock,
  maxCrossChainSkewSec: number,
  params: XdaiBridgeParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  deadlineMs: number,
): Promise<[XdaiBridgeBlock, XdaiBridgeBlock]> {
  if (Math.abs(ethereumAnchor.timestamp - gnosisAnchor.timestamp) <= maxCrossChainSkewSec) {
    return [ethereumAnchor, gnosisAnchor];
  }

  const ethereumIsNewer = ethereumAnchor.timestamp > gnosisAnchor.timestamp;
  const newerChain = ethereumIsNewer ? ETHEREUM_CHAIN : GNOSIS_CHAIN;
  const newerAnchor = ethereumIsNewer ? ethereumAnchor : gnosisAnchor;
  const olderTimestamp = ethereumIsNewer ? gnosisAnchor.timestamp : ethereumAnchor.timestamp;
  let high = newerAnchor;
  let low: XdaiBridgeBlock | null = null;
  let step = 1;

  for (let probe = 0; probe < DEFAULTS.maxAlignmentProbeCount; probe += 1) {
    const candidateNumber = Math.max(0, newerAnchor.number - step);
    const candidate = await readExplicitBlock(
      newerChain,
      candidateNumber,
      newerAnchor.finalityTag,
      params,
      signal,
      ctx,
      deadlineMs,
    );
    if (candidate.timestamp <= olderTimestamp) {
      low = candidate;
      break;
    }
    high = candidate;
    if (candidateNumber === 0) break;
    step *= 2;
  }

  if (low == null) {
    throw new Error(`${ADAPTER_KEY}: could not align finalized blocks within the bounded search window`);
  }

  while (low.number + 1 < high.number) {
    const middleNumber = Math.floor((low.number + high.number) / 2);
    const middle = await readExplicitBlock(
      newerChain,
      middleNumber,
      newerAnchor.finalityTag,
      params,
      signal,
      ctx,
      deadlineMs,
    );
    if (middle.timestamp <= olderTimestamp) low = middle;
    else high = middle;
  }

  return ethereumIsNewer ? [low, gnosisAnchor] : [ethereumAnchor, low];
}

async function readMulticall(
  chain: string,
  calls: readonly EvmMulticall3Call[],
  block: XdaiBridgeBlock,
  params: XdaiBridgeParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  deadlineMs: number,
): Promise<EvmMulticall3Result[]> {
  const results = await runAdapterIo(
    ctx,
    `${ADAPTER_KEY}:${chain}:multicall:${calls.length}`,
    () => fetchEvmMulticall3Aggregate3AtBlock(
      chain,
      calls,
      block.number,
      addressRpcOptions(chain, params, signal, ctx, deadlineMs),
    ),
    { signal },
  );
  if (results == null) throw new Error(`${ADAPTER_KEY}: ${chain} multicall unavailable`);
  if (results.length !== calls.length) throw new Error(`${ADAPTER_KEY}: ${chain} multicall result count mismatch`);
  return results;
}

async function requireCode(
  chain: string,
  address: string,
  block: XdaiBridgeBlock,
  params: XdaiBridgeParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  deadlineMs: number,
): Promise<void> {
  const code = await runAdapterIo(
    ctx,
    `${ADAPTER_KEY}:${chain}:code:${address}`,
    () => fetchEvmCodeAtBlock(
      chain,
      address,
      block.number,
      addressRpcOptions(chain, params, signal, ctx, deadlineMs),
    ),
    { signal },
  );
  if (code == null || code === "0x" || !/^0x[0-9a-fA-F]+$/.test(code)) {
    throw new Error(`${ADAPTER_KEY}: ${chain} ${address} has no readable contract code`);
  }
}

async function readForeignBridgeOtherSide(
  params: XdaiBridgeParams,
  block: XdaiBridgeBlock,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  deadlineMs: number,
): Promise<string> {
  const raw = await runAdapterIo(
    ctx,
    `${ADAPTER_KEY}:${ETHEREUM_CHAIN}:foreign-bridge-wiring`,
    () => fetchEvmStorageAtBlock(
      ETHEREUM_CHAIN,
      params.foreignBridgeAddress,
      FOREIGN_BRIDGE_OTHER_SIDE_STORAGE_SLOT,
      block.number,
      addressRpcOptions(ETHEREUM_CHAIN, params, signal, ctx, deadlineMs),
    ),
    { signal },
  );
  const address = decodeStrictAddressWord(raw);
  if (address == null) throw new Error(`${ADAPTER_KEY}: foreign bridge wiring storage was malformed`);
  return address.toLowerCase();
}

function ethereumCalls(params: XdaiBridgeParams): EvmMulticall3Call[] {
  const bridge = params.foreignBridgeAddress;
  const usds = params.usdsAddress;
  const susds = params.susdsAddress;
  return [
    call("foreign-daiToken", bridge, SELECTORS.daiToken),
    call("foreign-sDaiToken", bridge, SELECTORS.sDaiToken),
    call("foreign-erc20token", bridge, SELECTORS.erc20token),
    call("foreign-interestEnabled", bridge, encodeAddressCall(SELECTORS.isInterestEnabled, usds)),
    call("foreign-investedAmount", bridge, encodeAddressCall(SELECTORS.investedAmount, usds)),
    call("foreign-bridgeMode", bridge, SELECTORS.getBridgeMode),
    call("usds-balance", usds, encodeAddressCall(SELECTORS.balanceOf, bridge)),
    call("usds-decimals", usds, SELECTORS.decimals),
    call("susds-balance", susds, encodeAddressCall(SELECTORS.balanceOf, bridge)),
    call("susds-asset", susds, SELECTORS.asset),
    call("susds-decimals", susds, SELECTORS.decimals),
    call("susds-maxWithdraw", susds, encodeAddressCall(SELECTORS.maxWithdraw, bridge)),
    call("dai-balance", params.daiAddress, encodeAddressCall(SELECTORS.balanceOf, bridge)),
    call("dai-decimals", params.daiAddress, SELECTORS.decimals),
    call("sdai-balance", params.sdaiAddress, encodeAddressCall(SELECTORS.balanceOf, bridge)),
    call("sdai-decimals", params.sdaiAddress, SELECTORS.decimals),
  ];
}

function susdsConversionCall(
  params: XdaiBridgeParams,
  susdsShares: bigint,
): EvmMulticall3Call {
  return call(
    "susds-convertToAssets",
    params.susdsAddress,
    `${SELECTORS.convertToAssets}${susdsShares.toString(16).padStart(64, "0")}`,
  );
}

function gnosisCalls(params: XdaiBridgeParams): EvmMulticall3Call[] {
  const home = params.homeBridgeAddress;
  return [
    call("home-blockReward", home, SELECTORS.blockRewardContract),
    call("home-usdsDeposit", home, SELECTORS.usdsDepositContract),
    call("home-bridgeMode", home, SELECTORS.getBridgeMode),
    call("mintedTotallyByBridge", params.blockRewardAddress, encodeAddressCall(SELECTORS.mintedTotallyByBridge, home)),
    call("totalBurntCoins", home, SELECTORS.totalBurntCoins),
  ];
}

function validateIdentities(
  ethereum: readonly EvmMulticall3Result[],
  gnosis: readonly EvmMulticall3Result[],
  params: XdaiBridgeParams,
): void {
  requireExactAddress(requireAddress(ethereum, "foreign-daiToken"), params.usdsAddress, "foreign.daiToken()");
  requireExactAddress(requireAddress(ethereum, "foreign-sDaiToken"), params.susdsAddress, "foreign.sDaiToken()");
  requireExactAddress(requireAddress(ethereum, "foreign-erc20token"), params.usdsAddress, "foreign.erc20token()");
  requireExactAddress(requireAddress(gnosis, "home-blockReward"), params.blockRewardAddress, "home block-reward wiring");
  requireExactAddress(requireAddress(gnosis, "home-usdsDeposit"), params.usdsDepositContractAddress, "home USDS deposit wiring");
  requireBridgeMode(ethereum, "foreign-bridgeMode");
  requireBridgeMode(gnosis, "home-bridgeMode");
  requireExactAddress(requireAddress(ethereum, "susds-asset"), params.usdsAddress, "sUSDS.asset()");
  requireDecimals(ethereum, "usds-decimals");
  requireDecimals(ethereum, "susds-decimals");
  requireDecimals(ethereum, "dai-decimals");
  requireDecimals(ethereum, "sdai-decimals");
  if (!requireBool(ethereum, "foreign-interestEnabled")) {
    throw new Error(`${ADAPTER_KEY}: foreign bridge interest wiring is disabled for USDS`);
  }
}

function readObservation(
  ethereum: readonly EvmMulticall3Result[],
  gnosis: readonly EvmMulticall3Result[],
  ethereumBlock: XdaiBridgeBlock,
  gnosisBlock: XdaiBridgeBlock,
): XdaiBridgeObservation {
  const minted = requireUint(gnosis, "mintedTotallyByBridge");
  const burnt = requireUint(gnosis, "totalBurntCoins");
  if (burnt > minted) throw new Error(`${ADAPTER_KEY}: burnt xDAI exceeds minted xDAI`);

  const liquidUsds = requireUint(ethereum, "usds-balance");
  const susdsShares = requireUint(ethereum, "susds-balance");
  const susdsAssets = requireUint(ethereum, "susds-convertToAssets");
  const susdsMaxWithdraw = requireUint(ethereum, "susds-maxWithdraw");
  if (susdsShares > 0n && susdsAssets === 0n) {
    throw new Error(`${ADAPTER_KEY}: sUSDS convertToAssets() returned zero for nonzero shares`);
  }

  return {
    ethereumBlock,
    gnosisBlock,
    liquidUsds,
    susdsShares,
    susdsAssets,
    susdsMaxWithdraw,
    investedUsds: requireUint(ethereum, "foreign-investedAmount"),
    interestEnabled: requireBool(ethereum, "foreign-interestEnabled"),
    legacyDai: requireUint(ethereum, "dai-balance"),
    legacySdai: requireUint(ethereum, "sdai-balance"),
    outstanding: minted - burnt,
  };
}

export function adaptXdaiBridgeResponse(
  observation: XdaiBridgeObservation,
  params: XdaiBridgeParams,
): AdapterResult {
  const collateral = observation.liquidUsds + observation.susdsAssets;
  if (collateral <= 0n) throw new Error(`${ADAPTER_KEY}: measured collateral is zero`);
  if (observation.outstanding <= 0n) throw new Error(`${ADAPTER_KEY}: outstanding xDAI liability is not positive`);

  const coverageRatio = ratioFromBigInts(collateral, observation.outstanding, "coverage ratio");
  const legacy = observation.legacyDai + observation.legacySdai;
  const legacyDenominator = collateral + legacy;
  const legacyPct = percentageFromBigInts(legacy, legacyDenominator, "legacy exposure");
  const maxWithdrawDivergencePct = observation.susdsAssets > 0n
    ? relativeDifferencePct(observation.susdsMaxWithdraw, observation.susdsAssets, "sUSDS maxWithdraw diagnostic")
    : 0;
  const timestampSkewSec = Math.abs(observation.ethereumBlock.timestamp - observation.gnosisBlock.timestamp);
  const slices: ReserveSlice[] = normalizeSlices([
    {
      name: "sUSDS held by the Ethereum xDAI Foreign Bridge",
      pct: percentageFromBigInts(observation.susdsAssets, collateral, "sUSDS collateral share"),
      risk: "low",
      coinId: "susds-sky",
      depType: "collateral",
    },
    {
      name: "Liquid USDS held by the Ethereum xDAI Foreign Bridge",
      pct: percentageFromBigInts(observation.liquidUsds, collateral, "liquid USDS collateral share"),
      risk: "low",
      coinId: "usds-sky",
      depType: "collateral",
    },
  ]);
  if (slices.length === 0) throw new Error(`${ADAPTER_KEY}: reserve slices are empty`);

  const warnings: LiveReserveWarning[] = [];
  const crossChainSkewWarningSec = params.crossChainSkewWarningSec ?? DEFAULTS.crossChainSkewWarningSec;
  if (timestampSkewSec > crossChainSkewWarningSec) {
    warnings.push(reserveInfoWarning(
      "xdai-cross-chain-timestamp-skew",
      `Ethereum/Gnosis finalized block timestamps differ by ${timestampSkewSec}s`,
    ));
  }
  const shortfallThreshold = params.coverageShortfallWarningRatio ?? DEFAULTS.coverageShortfallWarningRatio;
  if (coverageRatio < shortfallThreshold) {
    warnings.push(reserveDegradedWarning(
      "xdai-reserve-undercollateralized",
      `Measured USDS collateral covers ${(coverageRatio * 100).toFixed(2)}% of bridge-minted xDAI liability`,
    ));
  } else if (coverageRatio < 1) {
    warnings.push(reserveInfoWarning(
      "xdai-coverage-near-shortfall",
      `Measured USDS collateral covers ${(coverageRatio * 100).toFixed(2)}% of bridge-minted xDAI liability`,
    ));
  }
  const surplusWarningRatio = params.surplusWarningRatio ?? DEFAULTS.surplusWarningRatio;
  const maxSurplusRatio = params.maxSurplusRatio ?? DEFAULTS.maxSurplusRatio;
  if (coverageRatio > maxSurplusRatio) {
    warnings.push(reserveDegradedWarning(
      "xdai-implausible-surplus",
      `Measured collateralization is ${(coverageRatio * 100).toFixed(2)}%, above the reviewed ${maxSurplusRatio * 100}% surplus bound`,
    ));
  } else if (coverageRatio > surplusWarningRatio) {
    warnings.push(reserveInfoWarning(
      "xdai-large-surplus",
      `Measured collateralization is ${(coverageRatio * 100).toFixed(2)}%`,
    ));
  }
  const legacyWarningPct = params.legacyWarningPct ?? DEFAULTS.legacyWarningPct;
  const legacyMaterialityPct = params.legacyMaterialityPct ?? DEFAULTS.legacyMaterialityPct;
  if (legacyPct >= legacyMaterialityPct) {
    throw new Error(`${ADAPTER_KEY}: material legacy DAI/sDAI balance (${legacyPct.toFixed(4)}%) requires reviewed mapping`);
  }
  if (legacyPct >= legacyWarningPct) {
    warnings.push(reserveInfoWarning(
      "xdai-legacy-balance",
      `Legacy DAI/sDAI balances are ${legacyPct.toFixed(4)}% of measured bridge-held assets`,
    ));
  }
  const maxWithdrawDivergenceLimit = params.maxWithdrawDivergencePct ?? DEFAULTS.maxWithdrawDivergencePct;
  if (maxWithdrawDivergencePct > maxWithdrawDivergenceLimit) {
    warnings.push(reserveDegradedWarning(
      "xdai-susds-withdraw-diagnostic-divergence",
      `sUSDS maxWithdraw differs from convertToAssets value by ${maxWithdrawDivergencePct.toFixed(2)}%`,
    ));
  }

  const collateralUsd = decimalNumberFromBigInt(collateral, 18);
  const outstandingUsd = decimalNumberFromBigInt(observation.outstanding, 18);
  return {
    slices,
    warnings,
    metadata: {
      freshnessMode: "not-applicable",
      totalReserveUsd: collateralUsd,
      supplyUsd: outstandingUsd,
      collateralizationRatio: coverageRatio,
      details: {
        finalityTag: observation.ethereumBlock.finalityTag,
        ethereumBlock: observation.ethereumBlock,
        gnosisBlock: observation.gnosisBlock,
        crossChainTimestampSkewSec: timestampSkewSec,
        liquidUsdsRaw: observation.liquidUsds.toString(),
        susdsSharesRaw: observation.susdsShares.toString(),
        susdsAssetsRaw: observation.susdsAssets.toString(),
        susdsMaxWithdrawRaw: observation.susdsMaxWithdraw.toString(),
        investedUsdsRaw: observation.investedUsds.toString(),
        interestEnabled: observation.interestEnabled,
        legacyDaiRaw: observation.legacyDai.toString(),
        legacySdaiRaw: observation.legacySdai.toString(),
        legacyExposurePct: legacyPct,
        bridgeMintedMinusBurntRaw: observation.outstanding.toString(),
        collateralRaw: collateral.toString(),
        collateralUsd,
        outstandingUsd,
        maxWithdrawDivergencePct,
        redemptionTelemetry: "omitted-v1",
      },
    },
  };
}

function readParams(config: LiveReservesConfig): XdaiBridgeParams {
  return parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
}

export async function fetchXdaiBridgeReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  if (config.inputs.primary.kind !== "onchain-evm") {
    throw new Error(`${ADAPTER_KEY} adapter requires an onchain-evm primary input`);
  }
  const params = readParams(config);
  const nowSec = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
  const deadlineMs = Date.now() + DEFAULTS.attemptBudgetMs;
  const [ethereumAnchor, gnosisAnchor] = await Promise.all([
    readFinalizedBlock(ETHEREUM_CHAIN, params, signal, ctx, deadlineMs, nowSec),
    readFinalizedBlock(GNOSIS_CHAIN, params, signal, ctx, deadlineMs, nowSec),
  ]);
  const maxCrossChainSkewSec = params.maxCrossChainSkewSec ?? DEFAULTS.maxCrossChainSkewSec;
  const [ethereumBlock, gnosisBlock] = await alignFinalizedBlocks(
    ethereumAnchor,
    gnosisAnchor,
    maxCrossChainSkewSec,
    params,
    signal,
    ctx,
    deadlineMs,
  );
  const timestampSkewSec = Math.abs(ethereumBlock.timestamp - gnosisBlock.timestamp);
  if (timestampSkewSec > maxCrossChainSkewSec) {
    throw new Error(`${ADAPTER_KEY}: cross-chain finalized block timestamp skew ${timestampSkewSec}s exceeds ${maxCrossChainSkewSec}s`);
  }

  const [ethereumResults, gnosisResults] = await Promise.all([
    readMulticall(ETHEREUM_CHAIN, ethereumCalls(params), ethereumBlock, params, signal, ctx, deadlineMs),
    readMulticall(GNOSIS_CHAIN, gnosisCalls(params), gnosisBlock, params, signal, ctx, deadlineMs),
  ]);
  validateIdentities(ethereumResults, gnosisResults, params);
  requireExactAddress(
    await readForeignBridgeOtherSide(params, ethereumBlock, signal, ctx, deadlineMs),
    params.homeBridgeAddress,
    "foreign bridge storage wiring",
  );

  // ERC-4626 conversion must use the exact shares read in the same pinned
  // Ethereum snapshot. A second tiny multicall keeps the argument dynamic
  // without falling back to a latest-state call.
  const susdsShares = requireUint(ethereumResults, "susds-balance");
  const conversionResults = await readMulticall(
    ETHEREUM_CHAIN,
    [susdsConversionCall(params, susdsShares)],
    ethereumBlock,
    params,
    signal,
    ctx,
    deadlineMs,
  );
  const allEthereumResults = [...ethereumResults, ...conversionResults];

  await Promise.all([
    ...[
      params.foreignBridgeAddress,
      params.usdsAddress,
      params.susdsAddress,
      params.daiAddress,
      params.sdaiAddress,
    ].map((address) => requireCode(ETHEREUM_CHAIN, address, ethereumBlock, params, signal, ctx, deadlineMs)),
    ...[
      params.homeBridgeAddress,
      params.blockRewardAddress,
      params.usdsDepositContractAddress,
    ].map((address) => requireCode(GNOSIS_CHAIN, address, gnosisBlock, params, signal, ctx, deadlineMs)),
  ]);

  const observation = readObservation(allEthereumResults, gnosisResults, ethereumBlock, gnosisBlock);
  await Promise.all([
    recheckBlockHash(ETHEREUM_CHAIN, ethereumBlock, params, signal, ctx, deadlineMs),
    recheckBlockHash(GNOSIS_CHAIN, gnosisBlock, params, signal, ctx, deadlineMs),
  ]);
  return adaptXdaiBridgeResponse(observation, params);
}
