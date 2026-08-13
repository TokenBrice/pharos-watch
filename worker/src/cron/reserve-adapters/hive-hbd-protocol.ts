import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import { notApplicableFreshnessMetadata, reserveDegradedWarning, reserveInfoWarning } from "./helpers";
import { fetchJsonPostWithRetry } from "./request";

const ADAPTER_KEY = "hive-hbd-protocol";
const HIVE_PERCENT_SCALE = 10_000n;
const REQUEST_TIMEOUT_MS = 2_500;
const ATTEMPT_BUDGET_MS = 19_000;
const MAX_HEAD_AGE_SEC = 1_800;
const MAX_FUTURE_HEAD_SKEW_SEC = 60;

// These values are pinned to the reviewed HF26+ mainnet consensus regime. The
// runtime DGP start/stop fields are still checked against the pin; get_config
// is deliberately not called because the reviewed v1 budget is eight methods.
const PINNED = {
  chain: "hive-mainnet",
  hardfork: "hf26-plus",
  treasuryAccount: "hive.fund",
  hbdStartPercent: 2_000,
  hbdStopPercent: 2_000,
  hardLimitPercent: 3_000,
  maxFeedAgeSec: 604_800,
  conversionDelaySec: 302_400,
} as const;

type HiveHbdProtocolParams = LiveReserveAdapterParamsByKey["hive-hbd-protocol"];

interface HiveAsset {
  raw: string;
  symbol: "HBD" | "HIVE";
  amount: bigint;
}

interface HiveFeed {
  base: HiveAsset;
  quote: HiveAsset;
}

interface DynamicGlobalProperties {
  headBlockNumber: number;
  headBlockId: string;
  headTime: string;
  headTimestamp: number;
  lastIrreversibleBlockNumber: number;
  currentSupply: HiveAsset;
  currentHbdSupply: HiveAsset;
  virtualSupply: HiveAsset;
  hbdStartPercent: number;
  hbdStopPercent: number;
  hbdPrintRate: number;
}

interface HiveNodeSnapshot {
  url: string;
  dgp: DynamicGlobalProperties;
  feed: HiveFeed;
  treasuryHbd: HiveAsset;
  treasurySavingsHbd: HiveAsset;
  ratio: HiveDebtRatio;
}

export interface HiveDebtRatio {
  adjustedHbdSupply: bigint;
  hbdAsHive: bigint;
  adjustedVirtualSupply: bigint;
  ratioBps: bigint;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${ADAPTER_KEY}: ${label} payload is malformed`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${ADAPTER_KEY}: ${label} payload is malformed`);
  }
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${ADAPTER_KEY}: ${label} payload is malformed`);
  }
  return value;
}

export function parseHiveAsset(value: unknown, expectedSymbol: HiveAsset["symbol"], label: string): HiveAsset {
  const raw = requireString(value, label).trim();
  const match = /^(\d+)\.(\d{3})\s+([A-Z]+)$/.exec(raw);
  if (!match || match[3] !== expectedSymbol) {
    throw new Error(`${ADAPTER_KEY}: ${label} has invalid ${expectedSymbol} asset format`);
  }

  const [, whole, fraction] = match;
  const amount = BigInt(whole) * 1_000n + BigInt(fraction);
  if (amount < 0n) throw new Error(`${ADAPTER_KEY}: ${label} cannot be negative`);
  return { raw, symbol: expectedSymbol, amount };
}

function parseHeadTime(value: unknown, label: string): { raw: string; timestamp: number } {
  const raw = requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw)) {
    throw new Error(`${ADAPTER_KEY}: ${label} has invalid Hive timestamp format`);
  }
  const timestamp = Date.parse(`${raw}Z`) / 1_000;
  if (
    !Number.isSafeInteger(timestamp)
    || timestamp <= 0
    || new Date(timestamp * 1_000).toISOString().slice(0, 19) !== raw
  ) {
    throw new Error(`${ADAPTER_KEY}: ${label} has invalid Hive timestamp`);
  }
  return { raw, timestamp };
}

function parseDynamicGlobalProperties(value: unknown): DynamicGlobalProperties {
  const payload = requireRecord(value, "get_dynamic_global_properties");
  const headBlockNumber = requireSafeInteger(payload.head_block_number, "head_block_number");
  const headBlockId = requireString(payload.head_block_id, "head_block_id");
  if (!/^[0-9a-f]{40}$/i.test(headBlockId)) {
    throw new Error(`${ADAPTER_KEY}: head_block_id is malformed`);
  }
  const headTime = parseHeadTime(payload.time, "time");
  const lastIrreversibleBlockNumber = requireSafeInteger(
    payload.last_irreversible_block_num,
    "last_irreversible_block_num",
  );
  if (headBlockNumber <= 0 || lastIrreversibleBlockNumber <= 0 || lastIrreversibleBlockNumber > headBlockNumber) {
    throw new Error(`${ADAPTER_KEY}: DGP block numbers are invalid`);
  }

  const hbdStartPercent = requireSafeInteger(payload.hbd_start_percent, "hbd_start_percent");
  const hbdStopPercent = requireSafeInteger(payload.hbd_stop_percent, "hbd_stop_percent");
  const hbdPrintRate = requireSafeInteger(payload.hbd_print_rate, "hbd_print_rate");
  if (
    hbdStartPercent < 0 || hbdStartPercent > 10_000
    || hbdStopPercent < 0 || hbdStopPercent > 10_000
    || hbdPrintRate < 0 || hbdPrintRate > 10_000
  ) {
    throw new Error(`${ADAPTER_KEY}: DGP threshold values are out of range`);
  }

  const currentSupply = parseHiveAsset(payload.current_supply, "HIVE", "current_supply");
  const currentHbdSupply = parseHiveAsset(payload.current_hbd_supply, "HBD", "current_hbd_supply");
  const virtualSupply = parseHiveAsset(payload.virtual_supply, "HIVE", "virtual_supply");
  if (currentSupply.amount <= 0n || virtualSupply.amount <= 0n) {
    throw new Error(`${ADAPTER_KEY}: DGP supplies must be positive`);
  }

  return {
    headBlockNumber,
    headBlockId: headBlockId.toLowerCase(),
    headTime: headTime.raw,
    headTimestamp: headTime.timestamp,
    lastIrreversibleBlockNumber,
    currentSupply,
    currentHbdSupply,
    virtualSupply,
    hbdStartPercent,
    hbdStopPercent,
    hbdPrintRate,
  };
}

function parseFeed(value: unknown): HiveFeed {
  const payload = requireRecord(value, "get_feed_history");
  const median = requireRecord(payload.current_median_history, "current_median_history");
  return {
    base: parseHiveAsset(median.base, "HBD", "current_median_history.base"),
    quote: parseHiveAsset(median.quote, "HIVE", "current_median_history.quote"),
  };
}

function parseTreasuryAccount(value: unknown, accountName: string): { hbd: HiveAsset; savingsHbd: HiveAsset } {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`${ADAPTER_KEY}: get_accounts payload is malformed`);
  }
  const account = requireRecord(value[0], "get_accounts account");
  if (account.name !== accountName) {
    throw new Error(`${ADAPTER_KEY}: treasury account identity mismatch`);
  }
  return {
    hbd: parseHiveAsset(account.hbd_balance, "HBD", "treasury hbd_balance"),
    savingsHbd: parseHiveAsset(account.savings_hbd_balance, "HBD", "treasury savings_hbd_balance"),
  };
}

function requireRpcResult(payload: unknown, id: number, label: string): unknown {
  const response = requireRecord(payload, label);
  if (response.jsonrpc !== "2.0" || response.id !== id || response.error != null || !("result" in response)) {
    throw new Error(`${ADAPTER_KEY}: ${label} JSON-RPC response is malformed`);
  }
  return response.result;
}

function requireBatchResults(payload: unknown): Map<number, unknown> {
  if (!Array.isArray(payload) || payload.length !== 2) {
    throw new Error(`${ADAPTER_KEY}: material JSON-RPC batch response is malformed`);
  }
  const results = new Map<number, unknown>();
  for (const item of payload) {
    const response = requireRecord(item, "material JSON-RPC batch");
    const id = response.id;
    if (
      response.jsonrpc !== "2.0"
      || typeof id !== "number"
      || results.has(id)
      || response.error != null
      || !("result" in response)
    ) {
      throw new Error(`${ADAPTER_KEY}: material JSON-RPC batch response is malformed`);
    }
    results.set(id, response.result);
  }
  if (!results.has(2) || !results.has(3)) {
    throw new Error(`${ADAPTER_KEY}: material JSON-RPC batch response is missing an expected id`);
  }
  return results;
}

function dgpMaterialKey(dgp: DynamicGlobalProperties): string {
  return JSON.stringify([
    dgp.headBlockNumber,
    dgp.headBlockId,
    dgp.headTime,
    dgp.lastIrreversibleBlockNumber,
    dgp.currentSupply.amount.toString(),
    dgp.currentHbdSupply.amount.toString(),
    dgp.virtualSupply.amount.toString(),
    dgp.hbdStartPercent,
    dgp.hbdStopPercent,
    dgp.hbdPrintRate,
  ]);
}

function materialKey(snapshot: HiveNodeSnapshot): string {
  return JSON.stringify([
    dgpMaterialKey(snapshot.dgp),
    snapshot.feed.base.amount.toString(),
    snapshot.feed.quote.amount.toString(),
    snapshot.treasuryHbd.amount.toString(),
    snapshot.treasurySavingsHbd.amount.toString(),
    snapshot.ratio.adjustedHbdSupply.toString(),
    snapshot.ratio.hbdAsHive.toString(),
    snapshot.ratio.adjustedVirtualSupply.toString(),
    snapshot.ratio.ratioBps.toString(),
  ]);
}

function validateHeadRecency(dgp: DynamicGlobalProperties, nowSec: number): void {
  if (dgp.headTimestamp > nowSec + MAX_FUTURE_HEAD_SKEW_SEC) {
    throw new Error(`${ADAPTER_KEY}: head time is in the future`);
  }
  if (nowSec - dgp.headTimestamp > MAX_HEAD_AGE_SEC) {
    throw new Error(`${ADAPTER_KEY}: head time is stale`);
  }
}

/** Reproduces database::calculate_HBD_percent() after HF24/HF21. */
export function deriveHiveDebtRatio(input: {
  currentHbdSupply: bigint;
  treasuryHbd: bigint;
  currentHiveSupply: bigint;
  feed: HiveFeed;
}): HiveDebtRatio {
  if (input.currentHbdSupply < 0n || input.treasuryHbd < 0n) {
    throw new Error(`${ADAPTER_KEY}: HBD supply arithmetic contains a negative value`);
  }
  if (input.treasuryHbd > input.currentHbdSupply) {
    throw new Error(`${ADAPTER_KEY}: treasury HBD exceeds current HBD supply`);
  }
  if (input.currentHiveSupply <= 0n) {
    throw new Error(`${ADAPTER_KEY}: current HIVE supply must be positive`);
  }
  if (input.feed.base.amount <= 0n || input.feed.quote.amount <= 0n) {
    throw new Error(`${ADAPTER_KEY}: median feed denominator must be positive`);
  }

  const adjustedHbdSupply = input.currentHbdSupply - input.treasuryHbd;
  // HBD_price is base HBD / quote HIVE. HBD is the price base, so the
  // consensus operator converts it to HIVE as amount * quote / base.
  const hbdAsHive = (adjustedHbdSupply * input.feed.quote.amount) / input.feed.base.amount;
  const adjustedVirtualSupply = hbdAsHive + input.currentHiveSupply;
  if (adjustedVirtualSupply <= 0n) {
    throw new Error(`${ADAPTER_KEY}: adjusted virtual supply must be positive`);
  }

  const ratioBps = (hbdAsHive * HIVE_PERCENT_SCALE + adjustedVirtualSupply / 2n) / adjustedVirtualSupply;
  if (ratioBps < 0n || ratioBps > HIVE_PERCENT_SCALE) {
    throw new Error(`${ADAPTER_KEY}: derived debt ratio is outside 0..100%`);
  }
  return { adjustedHbdSupply, hbdAsHive, adjustedVirtualSupply, ratioBps };
}

function validatePinnedDgp(dgp: DynamicGlobalProperties, params: HiveHbdProtocolParams): void {
  if (params.chain !== PINNED.chain || params.hardfork !== PINNED.hardfork || params.treasuryAccount !== PINNED.treasuryAccount) {
    throw new Error(`${ADAPTER_KEY}: configured chain, hardfork, or treasury assumption drifted`);
  }
  if (dgp.hbdStartPercent !== PINNED.hbdStartPercent || dgp.hbdStopPercent !== PINNED.hbdStopPercent) {
    throw new Error(`${ADAPTER_KEY}: active DGP thresholds are outside the pinned HF26 regime`);
  }
}

function makeDgpRequest(id: number): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "condenser_api.get_dynamic_global_properties", params: [] };
}

function makeMaterialBatch(accountName: string): JsonRpcRequest[] {
  return [
    { jsonrpc: "2.0", id: 2, method: "condenser_api.get_feed_history", params: [] },
    { jsonrpc: "2.0", id: 3, method: "condenser_api.get_accounts", params: [[accountName]] },
  ];
}

function makeAttemptSignal(signal: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Hive adapter attempt budget exceeded", "TimeoutError")), ATTEMPT_BUDGET_MS);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (!controller.signal.aborted) controller.abort(new DOMException("Hive adapter attempt finished", "AbortError"));
    },
  };
}

async function fetchNodeSnapshot(
  url: string,
  accountName: string,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  params: HiveHbdProtocolParams,
  nowSec: number,
): Promise<HiveNodeSnapshot> {
  const dgpBeforePayload = await fetchJsonPostWithRetry(
    url,
    makeDgpRequest(1),
    signal,
    REQUEST_TIMEOUT_MS,
    ctx,
  );
  const dgpBefore = parseDynamicGlobalProperties(requireRpcResult(dgpBeforePayload, 1, "DGP-before"));
  validateHeadRecency(dgpBefore, nowSec);
  validatePinnedDgp(dgpBefore, params);

  const materialPayload = await fetchJsonPostWithRetry(
    url,
    makeMaterialBatch(accountName),
    signal,
    REQUEST_TIMEOUT_MS,
    ctx,
  );
  const materialResults = requireBatchResults(materialPayload);
  const feed = parseFeed(materialResults.get(2));
  const treasury = parseTreasuryAccount(materialResults.get(3), accountName);

  const dgpAfterPayload = await fetchJsonPostWithRetry(
    url,
    makeDgpRequest(4),
    signal,
    REQUEST_TIMEOUT_MS,
    ctx,
  );
  const dgpAfter = parseDynamicGlobalProperties(requireRpcResult(dgpAfterPayload, 4, "DGP-after"));
  validateHeadRecency(dgpAfter, nowSec);
  validatePinnedDgp(dgpAfter, params);
  if (dgpMaterialKey(dgpBefore) !== dgpMaterialKey(dgpAfter)) {
    throw new Error(`${ADAPTER_KEY}: material reads crossed a changing Hive head`);
  }

  return {
    url,
    dgp: dgpBefore,
    feed,
    treasuryHbd: treasury.hbd,
    treasurySavingsHbd: treasury.savingsHbd,
    ratio: deriveHiveDebtRatio({
      currentHbdSupply: dgpBefore.currentHbdSupply.amount,
      treasuryHbd: treasury.hbd.amount,
      currentHiveSupply: dgpBefore.currentSupply.amount,
      feed,
    }),
  };
}

function ratioPct(ratioBps: bigint): number {
  const value = Number(ratioBps) / 100;
  if (!Number.isFinite(value)) throw new Error(`${ADAPTER_KEY}: debt ratio is not finite`);
  return value;
}

function thresholdWarnings(ratioBps: bigint): LiveReserveWarning[] {
  const warnings: LiveReserveWarning[] = [];
  if (ratioBps >= BigInt(PINNED.hbdStopPercent)) {
    warnings.push(reserveInfoWarning(
      "hbd-print-stop-active",
      `Hive HBD printing is stopped at the ${PINNED.hbdStopPercent / 100}% debt threshold`,
    ));
  }
  if (ratioBps >= BigInt(PINNED.hardLimitPercent)) {
    warnings.push(reserveDegradedWarning(
      "hbd-hard-limit-reached",
      `Hive HBD debt ratio has reached the ${PINNED.hardLimitPercent / 100}% hard limit`,
    ));
  }
  return warnings;
}

export function adaptHiveHbdProtocolSnapshots(
  snapshots: readonly [HiveNodeSnapshot, HiveNodeSnapshot],
): AdapterResult {
  const [primary, fallback] = snapshots;
  if (materialKey(primary) !== materialKey(fallback)) {
    throw new Error(`${ADAPTER_KEY}: primary and fallback nodes disagree on material Hive state`);
  }

  const ratio = primary.ratio;
  const warnings = thresholdWarnings(ratio.ratioBps);
  const details = {
    proofKind: "two-node-bracketed-hive-protocol-state",
    chain: PINNED.chain,
    hardfork: PINNED.hardfork,
    treasuryAccount: PINNED.treasuryAccount,
    sourceNodes: [primary.url, fallback.url],
    headBlockNumber: primary.dgp.headBlockNumber,
    headBlockId: primary.dgp.headBlockId,
    headTime: primary.dgp.headTime,
    lastIrreversibleBlockNumber: primary.dgp.lastIrreversibleBlockNumber,
    currentSupply: primary.dgp.currentSupply.raw,
    currentHbdSupply: primary.dgp.currentHbdSupply.raw,
    dgpVirtualSupplyDiagnostic: primary.dgp.virtualSupply.raw,
    treasuryHbdBalance: primary.treasuryHbd.raw,
    treasurySavingsHbdBalance: primary.treasurySavingsHbd.raw,
    treasurySavingsTreatment: "Excluded from the consensus debt numerator; only liquid treasury HBD is subtracted.",
    nonTreasuryHbdDebtMilliunits: ratio.adjustedHbdSupply.toString(),
    medianFeed: { base: primary.feed.base.raw, quote: primary.feed.quote.raw },
    consensusHbdAsHiveMilliunits: ratio.hbdAsHive.toString(),
    consensusVirtualSupplyHiveMilliunits: ratio.adjustedVirtualSupply.toString(),
    protocolDebtRatioBps: Number(ratio.ratioBps),
    protocolDebtRatioPct: ratioPct(ratio.ratioBps),
    hbdStartPercent: primary.dgp.hbdStartPercent / 100,
    hbdStopPercent: primary.dgp.hbdStopPercent / 100,
    hbdPrintRatePercent: primary.dgp.hbdPrintRate / 100,
    hardLimitPercent: PINNED.hardLimitPercent / 100,
    conversionDelaySec: PINNED.conversionDelaySec,
    maxFeedAgeSec: PINNED.maxFeedAgeSec,
    feedTimestampNote: "Current median is consensus-filtered by the pinned maximum feed age; no independent feed timestamp is exposed.",
    thresholdState: ratio.ratioBps >= BigInt(PINNED.hardLimitPercent)
      ? "hard-limit"
      : ratio.ratioBps >= BigInt(PINNED.hbdStopPercent)
        ? "print-stop"
        : "below-print-stop",
  };

  const slice: ReserveSlice = {
    name: "Hive protocol HIVE conversion mechanism (endogenous HIVE value)",
    pct: 100,
    risk: "high",
    assetClass: "other",
    issuerOrObligor: "Hive blockchain protocol / witness-median-price conversion mechanism",
    riskFactors: ["market", "liquidity", "concentration"],
    liquidityHorizon: "seven-days",
  };

  return {
    slices: [slice],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata(details),
    },
  };
}

export async function fetchHiveHbdProtocolReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primary = config.inputs.primary;
  if (primary.kind !== "http-json") {
    throw new Error(`${ADAPTER_KEY} adapter requires an http-json primary input`);
  }
  const fallbacks = config.inputs.fallbacks ?? [];
  if (fallbacks.length !== 1 || fallbacks[0]?.kind !== "http-json") {
    throw new Error(`${ADAPTER_KEY} adapter requires exactly one http-json fallback node`);
  }

  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const nowSec = ctx?.nowSec ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(nowSec) || nowSec <= 0) {
    throw new Error(`${ADAPTER_KEY}: current time is invalid`);
  }

  const attempt = makeAttemptSignal(signal);
  const requestContext = { ...ctx, abortSignal: attempt.signal };
  try {
    const [primarySnapshot, fallbackSnapshot] = await Promise.all([
      fetchNodeSnapshot(primary.url, params.treasuryAccount, attempt.signal, requestContext, params, nowSec),
      fetchNodeSnapshot(fallbacks[0].url, params.treasuryAccount, attempt.signal, requestContext, params, nowSec),
    ]);
    return adaptHiveHbdProtocolSnapshots([primarySnapshot, fallbackSnapshot]);
  } finally {
    attempt.dispose();
  }
}
