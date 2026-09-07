import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { encodeAddress, encodeUint256 } from "../../lib/evm-selectors";
import {
  fetchEvmRpcBatch,
  fetchEvmRpcBatchDetailed,
  parseUint256Hex,
  type EvmRpcBatchCall,
} from "../../lib/evm-rpc";
import {
  EIP1967_IMPLEMENTATION_SLOT,
  implementationAddressFromSlot,
  runtimeCodeHash,
} from "./onchain-identity";
import {
  fetchDefiLlamaPrices,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromValues,
} from "./helpers";
import { runAdapterIo } from "./concurrency";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "moc-v3-buckets";
const ROOTSTOCK_CHAIN = "rootstock";
const WAD = 10n ** 18n;
const MAX_PROTOCOL_COVERAGE_DIFF_PCT = 0.5;

const SELECTORS = {
  nACcb: "0xf30b5614",
  qACLockedInPending: "0x5cfbe578",
  acToken: "0x25bc6c41",
  tpTokens: "0x01f1b684",
  pegContainer: "0x4b746001",
  getCglb: "0x826fcd58",
  getPACtp: "0xfadda424",
  totalSupply: "0x18160ddd",
  balanceOf: "0x70a08231",
  decimals: "0x313ce567",
  liquidated: "0x23b98cde",
  paused: "0x5c975abb",
} as const;

type MocV3Params = LiveReserveAdapterParamsByKey["moc-v3-buckets"];
type BucketParams = MocV3Params["rifBucket"];

interface BucketObservation {
  label: "rif" | "doc";
  params: BucketParams;
  collateralRaw: bigint;
  pendingRaw: bigint;
  walletRaw: bigint;
  liabilityRaw: bigint;
  protocolPriceRaw: bigint;
  protocolCoverageRaw: bigint;
  collateralAddress: string;
  pegProvider: string;
  priceProvider: string;
  liquidated: boolean;
  paused: boolean;
}

function rpcOptions(params: MocV3Params, signal: AbortSignal) {
  return {
    extraRpcUrls: [params.rpcUrl, params.fallbackRpcUrl],
    signal,
    timeoutMs: 8_000,
    maxRetries: 1,
  };
}

function toBlockTag(blockNumber: number): string {
  return `0x${blockNumber.toString(16)}`;
}

function call(to: string, data: string, blockTag: string): EvmRpcBatchCall {
  return {
    method: "eth_call",
    params: [{ to, data }, blockTag],
  };
}

function codeCall(address: string, blockTag: string): EvmRpcBatchCall {
  return { method: "eth_getCode", params: [address, blockTag] };
}

function storageCall(address: string, blockTag: string): EvmRpcBatchCall {
  return { method: "eth_getStorageAt", params: [address, EIP1967_IMPLEMENTATION_SLOT, blockTag] };
}

function addressCall(selector: string, address: string): string {
  return `${selector}${encodeAddress(address)}`;
}

function indexedCall(selector: string, index: number): string {
  return `${selector}${encodeUint256(index)}`;
}

function requireHex(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new Error(`${ADAPTER_KEY}: ${label} returned malformed hex`);
  }
  return value as `0x${string}`;
}

function requireWords(value: unknown, count: number, label: string): bigint[] {
  const raw = requireHex(value, label);
  const body = raw.slice(2);
  if (body.length !== count * 64) throw new Error(`${ADAPTER_KEY}: ${label} returned the wrong word count`);
  const words: bigint[] = [];
  for (let offset = 0; offset < body.length; offset += 64) {
    words.push(BigInt(`0x${body.slice(offset, offset + 64)}`));
  }
  return words;
}

function requireUint(value: unknown, label: string): bigint {
  const parsed = parseUint256Hex(value);
  if (parsed == null) throw new Error(`${ADAPTER_KEY}: ${label} read failed`);
  return parsed;
}

function requireAddressWord(value: unknown, label: string): string {
  const raw = requireUint(value, label);
  if (raw === 0n || raw >= 1n << 160n) throw new Error(`${ADAPTER_KEY}: ${label} returned an invalid address`);
  return `0x${raw.toString(16).padStart(40, "0")}`;
}

function requireBool(value: unknown, label: string): boolean {
  const raw = requireUint(value, label);
  if (raw !== 0n && raw !== 1n) throw new Error(`${ADAPTER_KEY}: ${label} returned an invalid boolean`);
  return raw === 1n;
}

function requireCodeHash(value: unknown, expected: string, label: string): string {
  const code = requireHex(value, label);
  const hash = runtimeCodeHash(code);
  if (hash == null || hash !== expected.toLowerCase()) {
    throw new Error(`${ADAPTER_KEY}: ${label} code hash mismatch`);
  }
  return hash;
}

function requireImplementation(value: unknown, expected: string, label: string): string {
  const slot = requireHex(value, label);
  const implementation = implementationAddressFromSlot(slot);
  if (implementation == null || implementation.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${ADAPTER_KEY}: ${label} implementation mismatch`);
  }
  return implementation;
}

function parseBlockHeader(value: unknown, label: string): { number: number; timestamp: number; hash: string } {
  if (!value || typeof value !== "object") throw new Error(`${ADAPTER_KEY}: ${label} missing`);
  const row = value as { number?: unknown; timestamp?: unknown; hash?: unknown };
  const number = requireUint(row.number, `${label}.number`);
  const timestamp = requireUint(row.timestamp, `${label}.timestamp`);
  if (number > BigInt(Number.MAX_SAFE_INTEGER) || timestamp > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${ADAPTER_KEY}: ${label} exceeds safe integer bounds`);
  }
  if (typeof row.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(row.hash)) {
    throw new Error(`${ADAPTER_KEY}: ${label}.hash is invalid`);
  }
  return { number: Number(number), timestamp: Number(timestamp), hash: row.hash.toLowerCase() };
}

function expectedRevert(
  errors: Array<{ index: number; message?: string }>,
  index: number,
  label: string,
): void {
  const error = errors.find((candidate) => candidate.index === index);
  if (!error || !error.message || !/revert|out[- ]of[- ]range|out[- ]of[- ]bounds|invalid index|index/i.test(error.message)) {
    throw new Error(`${ADAPTER_KEY}: ${label} must revert for the reviewed sole-token invariant`);
  }
}

function percentDifference(left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right) || right <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / right * 100;
}

function decimal(raw: bigint, decimals: number, label: string): number {
  const value = Number(raw) / 10 ** decimals;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${ADAPTER_KEY}: ${label} is not safely representable`);
  return value;
}

function protocolCoverage(collateralRaw: bigint, priceRaw: bigint, liabilityRaw: bigint, label: string): number {
  if (liabilityRaw <= 0n) throw new Error(`${ADAPTER_KEY}: ${label} has zero liability`);
  const ratio = Number(collateralRaw * priceRaw) / Number(liabilityRaw * WAD);
  if (!Number.isFinite(ratio) || ratio < 0) throw new Error(`${ADAPTER_KEY}: ${label} protocol coverage is invalid`);
  return ratio;
}

function verifyTrackedToken(coin: StablecoinMeta, params: MocV3Params): void {
  const rootstock = coin.contracts?.find((contract) => contract.chain === ROOTSTOCK_CHAIN);
  if (!rootstock
    || rootstock.address.toLowerCase() !== params.canonicalUsdrif.address.toLowerCase()
    || rootstock.decimals !== params.canonicalUsdrif.decimals) {
    throw new Error(`${ADAPTER_KEY}: tracked Rootstock USDRIF contract metadata drifted`);
  }
}

function buildCalls(params: MocV3Params, targetBlock: number): EvmRpcBatchCall[] {
  const blockTag = toBlockTag(targetBlock);
  const rif = params.rifBucket;
  const doc = params.docBucket;
  const calls: EvmRpcBatchCall[] = [
    { method: "eth_getBlockByNumber", params: [blockTag, false] },
    codeCall(rif.address, blockTag),
    codeCall(doc.address, blockTag),
    codeCall(rif.expectedImplementationAddress, blockTag),
    codeCall(doc.expectedImplementationAddress, blockTag),
    codeCall(params.canonicalUsdrif.address, blockTag),
    codeCall(params.rifToken.address, blockTag),
    codeCall(params.docToken.address, blockTag),
    storageCall(rif.address, blockTag),
    storageCall(doc.address, blockTag),
    call(params.canonicalUsdrif.address, SELECTORS.totalSupply, blockTag),
    call(params.canonicalUsdrif.address, SELECTORS.decimals, blockTag),
  ];

  for (const bucket of [rif, doc]) {
    calls.push(
      call(bucket.address, SELECTORS.nACcb, blockTag),
      call(bucket.address, SELECTORS.qACLockedInPending, blockTag),
      call(bucket.address, SELECTORS.acToken, blockTag),
      call(bucket.address, indexedCall(SELECTORS.tpTokens, 0), blockTag),
      call(bucket.address, indexedCall(SELECTORS.tpTokens, 1), blockTag),
      call(bucket.address, indexedCall(SELECTORS.pegContainer, 0), blockTag),
      call(bucket.address, addressCall(SELECTORS.getPACtp, params.canonicalUsdrif.address), blockTag),
      call(bucket.address, SELECTORS.getCglb, blockTag),
      call(bucket.address, SELECTORS.liquidated, blockTag),
      call(bucket.address, SELECTORS.paused, blockTag),
    );
  }
  calls.push(
    call(params.rifToken.address, addressCall(SELECTORS.balanceOf, rif.address), blockTag),
    call(params.docToken.address, addressCall(SELECTORS.balanceOf, doc.address), blockTag),
    call(params.rifToken.address, SELECTORS.decimals, blockTag),
    call(params.docToken.address, SELECTORS.decimals, blockTag),
  );
  return calls;
}

function readBucket(
  label: "rif" | "doc",
  params: BucketParams,
  values: Array<unknown | undefined>,
  errors: Array<{ index: number; code?: number; message?: string }>,
  offset: number,
  canonicalUsdrif: string,
  expectedCollateralDecimals: number,
  walletRaw: bigint,
): BucketObservation {
  const nACcb = requireUint(values[offset], `${label} nACcb()`);
  const pending = requireUint(values[offset + 1], `${label} qACLockedInPending()`);
  const collateralAddress = requireAddressWord(values[offset + 2], `${label} acToken()`);
  if (collateralAddress.toLowerCase() !== params.collateralToken.toLowerCase()) {
    throw new Error(`${ADAPTER_KEY}: ${label} acToken() identity mismatch`);
  }
  const tpToken = requireAddressWord(values[offset + 3], `${label} tpTokens(0)`);
  if (tpToken.toLowerCase() !== canonicalUsdrif.toLowerCase()) {
    throw new Error(`${ADAPTER_KEY}: ${label} tpTokens(0) is not canonical USDRIF`);
  }
  expectedRevert(errors, offset + 4, `${label} tpTokens(1)`);
  const pegWords = requireWords(values[offset + 5], 2, `${label} pegContainer(0)`);
  const liabilityRaw = pegWords[0];
  const pegProvider = `0x${pegWords[1].toString(16).padStart(64, "0").slice(-40)}`;
  if (pegProvider.toLowerCase() !== params.expectedPegContainerProvider.toLowerCase()) {
    throw new Error(`${ADAPTER_KEY}: ${label} pegContainer(0) provider mismatch`);
  }
  const priceRaw = requireHex(values[offset + 6], `${label} getPACtp(USDRIF)`);
  if (priceRaw.length !== 66 && priceRaw.length !== 130) {
    throw new Error(`${ADAPTER_KEY}: ${label} getPACtp(USDRIF) returned the wrong word count`);
  }
  const protocolPriceRaw = BigInt(`0x${priceRaw.slice(2, 66)}`);
  const extraPriceWords = priceRaw.length === 130 ? BigInt(`0x${priceRaw.slice(66)}`) : null;
  const priceProvider = extraPriceWords == null
    ? params.expectedPriceProvider
    : `0x${extraPriceWords.toString(16).padStart(64, "0").slice(-40)}`;
  if (priceProvider.toLowerCase() !== params.expectedPriceProvider.toLowerCase()) {
    throw new Error(`${ADAPTER_KEY}: ${label} getPACtp() price-provider mismatch`);
  }
  const protocolCoverageRaw = requireUint(values[offset + 7], `${label} getCglb()`);
  const liquidated = requireBool(values[offset + 8], `${label} liquidated()`);
  const paused = requireBool(values[offset + 9], `${label} paused()`);
  if (nACcb < 0n || pending < 0n || walletRaw < 0n || liabilityRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY}: ${label} returned impossible negative/zero accounting`);
  }
  if (expectedCollateralDecimals !== params.collateralDecimals) {
    throw new Error(`${ADAPTER_KEY}: ${label} collateral decimal configuration mismatch`);
  }
  return {
    label,
    params,
    collateralRaw: nACcb,
    pendingRaw: pending,
    walletRaw,
    liabilityRaw,
    protocolPriceRaw,
    protocolCoverageRaw,
    collateralAddress,
    pegProvider,
    priceProvider,
    liquidated,
    paused,
  };
}

export async function fetchUsdrifRifReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  if (input.chain !== ROOTSTOCK_CHAIN || input.rpcMode !== "public-rpc") {
    throw new Error(`${ADAPTER_KEY}: primary input must be Rootstock public RPC`);
  }
  verifyTrackedToken(coin, params);

  const options = rpcOptions(params, signal);
  const headValues = await runAdapterIo(ctx, `${ADAPTER_KEY}:head`, () =>
    fetchEvmRpcBatch(undefined, [{ method: "eth_blockNumber", params: [] }], options));
  const head = requireUint(headValues?.[0], "eth_blockNumber");
  if (head > BigInt(Number.MAX_SAFE_INTEGER) || head <= BigInt(params.confirmationDepth)) {
    throw new Error(`${ADAPTER_KEY}: Rootstock head is outside safe confirmation bounds`);
  }
  const targetBlock = Number(head) - params.confirmationDepth;
  const calls = buildCalls(params, targetBlock);
  const batch = await runAdapterIo(ctx, `${ADAPTER_KEY}:pinned-batch`, () =>
    fetchEvmRpcBatchDetailed(undefined, calls, options));
  if (!batch) throw new Error(`${ADAPTER_KEY}: pinned Rootstock batch failed`);

  const expectedErrorIndexes = new Set([16, 26]);
  for (const error of batch.errors) {
    if (!expectedErrorIndexes.has(error.index)) {
      throw new Error(`${ADAPTER_KEY}: pinned RPC call ${error.index} failed: ${error.message ?? "unknown error"}`);
    }
  }
  if (batch.errors.length !== expectedErrorIndexes.size) {
    throw new Error(`${ADAPTER_KEY}: pinned batch did not return both reviewed tpTokens(1) reverts`);
  }
  const header = parseBlockHeader(batch.results[0], "target block");
  if (header.number !== targetBlock) throw new Error(`${ADAPTER_KEY}: target block number drifted`);
  const nowSec = Math.floor(ctx?.nowSec ?? Date.now() / 1000);
  if (header.timestamp > nowSec + params.maxFutureSkewSec) {
    throw new Error(`${ADAPTER_KEY}: target Rootstock block is in the future`);
  }
  if (nowSec - header.timestamp > params.maxBlockAgeSec) {
    throw new Error(`${ADAPTER_KEY}: target Rootstock block is stale`);
  }

  requireCodeHash(batch.results[1], params.rifBucket.expectedProxyCodeHash, "RIF bucket proxy");
  requireCodeHash(batch.results[2], params.docBucket.expectedProxyCodeHash, "DOC bucket proxy");
  requireCodeHash(batch.results[3], params.rifBucket.expectedImplementationCodeHash, "RIF bucket implementation");
  requireCodeHash(batch.results[4], params.docBucket.expectedImplementationCodeHash, "DOC bucket implementation");
  requireCodeHash(batch.results[5], params.canonicalUsdrif.expectedProxyCodeHash, "canonical USDRIF");
  requireCodeHash(batch.results[6], params.rifToken.expectedCodeHash, "RIF token");
  requireCodeHash(batch.results[7], params.docToken.expectedCodeHash, "DOC token");
  requireImplementation(batch.results[8], params.rifBucket.expectedImplementationAddress, "RIF bucket proxy slot");
  requireImplementation(batch.results[9], params.docBucket.expectedImplementationAddress, "DOC bucket proxy slot");

  const totalSupplyRaw = requireUint(batch.results[10], "USDRIF totalSupply()");
  const usdrifDecimals = Number(requireUint(batch.results[11], "USDRIF decimals()"));
  if (usdrifDecimals !== params.canonicalUsdrif.decimals) throw new Error(`${ADAPTER_KEY}: USDRIF decimals mismatch`);
  const rifWalletRaw = requireUint(batch.results[32], "RIF bucket wallet balance");
  const docWalletRaw = requireUint(batch.results[33], "DOC bucket wallet balance");
  const rifDecimals = Number(requireUint(batch.results[34], "RIF decimals()"));
  const docDecimals = Number(requireUint(batch.results[35], "DOC decimals()"));
  if (rifDecimals !== params.rifToken.decimals || docDecimals !== params.docToken.decimals) {
    throw new Error(`${ADAPTER_KEY}: collateral token decimals mismatch`);
  }

  const rif = readBucket("rif", params.rifBucket, batch.results, batch.errors, 12, params.canonicalUsdrif.address, rifDecimals, rifWalletRaw);
  const doc = readBucket("doc", params.docBucket, batch.results, batch.errors, 22, params.canonicalUsdrif.address, docDecimals, docWalletRaw);
  if (rif.liabilityRaw + doc.liabilityRaw !== totalSupplyRaw) {
    throw new Error(`${ADAPTER_KEY}: bucket liabilities do not equal canonical USDRIF total supply`);
  }

  const priceMap = await fetchDefiLlamaPrices([
    { key: "rif", chain: ROOTSTOCK_CHAIN, address: params.rifToken.address },
    { key: "doc", chain: ROOTSTOCK_CHAIN, address: params.docToken.address },
  ], signal, ctx);
  const rifMarketPrice = priceMap.get("rif");
  const docMarketPrice = priceMap.get("doc");
  if (rifMarketPrice == null || docMarketPrice == null || rifMarketPrice <= 0 || docMarketPrice <= 0) {
    throw new Error(`${ADAPTER_KEY}: DefiLlama market prices for RIF and DOC are required`);
  }

  const warnings: LiveReserveWarning[] = [];
  const branchDetails: Record<string, unknown>[] = [];
  const marketValues: Array<{ branch: BucketObservation; marketPrice: number; marketValueUsd: number; protocolCoverage: number }> = [];
  for (const branch of [rif, doc]) {
    const marketPrice = branch.label === "rif" ? rifMarketPrice : docMarketPrice;
    const collateralAmount = decimal(branch.collateralRaw, branch.params.collateralDecimals, `${branch.label} collateral`);
    const liabilityAmount = decimal(branch.liabilityRaw, params.canonicalUsdrif.decimals, `${branch.label} liability`);
    const protocolPrice = decimal(branch.protocolPriceRaw, WAD.toString().length - 1, `${branch.label} protocol price`);
    if (protocolPrice <= 0) throw new Error(`${ADAPTER_KEY}: ${branch.label} protocol price is not positive`);
    const marketValueUsd = collateralAmount * marketPrice;
    const coverage = protocolCoverage(branch.collateralRaw, branch.protocolPriceRaw, branch.liabilityRaw, branch.label);
    const reportedCoverage = decimal(branch.protocolCoverageRaw, WAD.toString().length - 1, `${branch.label} getCglb`);
    if (percentDifference(coverage, reportedCoverage) > MAX_PROTOCOL_COVERAGE_DIFF_PCT) {
      throw new Error(`${ADAPTER_KEY}: ${branch.label} getCglb does not reconcile with bucket accounting`);
    }
    const priceDivergence = percentDifference(marketPrice, protocolPrice);
    if (priceDivergence > params.maxMarketProtocolDivergencePct) {
      warnings.push(reserveDegradedWarning(
        "moc-v3-market-protocol-price-divergence",
        `${branch.label.toUpperCase()} market price $${marketPrice.toFixed(6)} diverges ${priceDivergence.toFixed(2)}% from MoC price $${protocolPrice.toFixed(6)}`,
      ));
    }
    const walletMinimum = branch.collateralRaw + branch.pendingRaw;
    if (branch.walletRaw < walletMinimum) {
      throw new Error(`${ADAPTER_KEY}: ${branch.label} wallet balance is below nACcb plus pending collateral`);
    }
    const walletExcess = branch.walletRaw - walletMinimum;
    const walletExcessPct = branch.collateralRaw > 0n
      ? Number(walletExcess * 10_000n / branch.collateralRaw) / 100
      : (walletExcess > 0n ? Number.POSITIVE_INFINITY : 0);
    if (walletExcessPct >= params.walletExcessDegradedPct) {
      warnings.push(reserveDegradedWarning(
        "moc-v3-wallet-accounting-excess",
        `${branch.label.toUpperCase()} wallet has ${decimal(walletExcess, branch.params.collateralDecimals, `${branch.label} wallet excess`)} identified collateral above nACcb plus pending (${walletExcessPct.toFixed(2)}%); excluded from backing`,
      ));
    } else if (walletExcessPct >= params.walletExcessInfoPct && walletExcess > 0n) {
      warnings.push(reserveInfoWarning(
        "moc-v3-wallet-accounting-excess",
        `${branch.label.toUpperCase()} wallet has ${decimal(walletExcess, branch.params.collateralDecimals, `${branch.label} wallet excess`)} identified collateral above nACcb plus pending (${walletExcessPct.toFixed(2)}%); excluded from backing`,
      ));
    }
    const liabilitySharePct = Number(branch.liabilityRaw * 10_000n / totalSupplyRaw) / 100;
    if (coverage < 1) {
      const warning = liabilitySharePct >= params.branchMaterialityPct
        ? reserveDegradedWarning
        : reserveInfoWarning;
      warnings.push(warning(
        "moc-v3-branch-coverage-shortfall",
        `${branch.label.toUpperCase()} MoC branch coverage is ${(coverage * 100).toFixed(2)}% for ${liabilitySharePct.toFixed(3)}% of USDRIF liabilities`,
      ));
    }
    if (branch.liquidated || branch.paused) {
      warnings.push(reserveDegradedWarning(
        "moc-v3-branch-health",
        `${branch.label.toUpperCase()} MoC bucket reports ${branch.liquidated ? "liquidated" : "paused"} state`,
      ));
    }
    marketValues.push({ branch, marketPrice, marketValueUsd, protocolCoverage: coverage });
    branchDetails.push({
      bucket: branch.params.address,
      collateralToken: branch.collateralAddress,
      collateralRaw: branch.collateralRaw.toString(),
      collateralAmount,
      pendingRaw: branch.pendingRaw.toString(),
      walletRaw: branch.walletRaw.toString(),
      walletExcessRaw: walletExcess.toString(),
      walletExcessPct,
      liabilityRaw: branch.liabilityRaw.toString(),
      liabilityAmount,
      marketPriceUsd: marketPrice,
      protocolPriceUsd: protocolPrice,
      marketProtocolDivergencePct: priceDivergence,
      protocolCoverageRatio: coverage,
      reportedGetCglb: reportedCoverage,
      pegContainerProvider: branch.pegProvider,
      priceProvider: branch.priceProvider,
      liquidated: branch.liquidated,
      paused: branch.paused,
    });
  }

  const totalLiabilitiesUsd = decimal(totalSupplyRaw, params.canonicalUsdrif.decimals, "USDRIF liabilities");
  const totalReserveUsd = marketValues.reduce((sum, value) => sum + value.marketValueUsd, 0);
  const collateralizationRatio = totalReserveUsd / totalLiabilitiesUsd;
  if (!Number.isFinite(collateralizationRatio) || collateralizationRatio <= 0) {
    throw new Error(`${ADAPTER_KEY}: overall collateralization is invalid`);
  }
  if (collateralizationRatio < 1) {
    warnings.push(reserveDegradedWarning(
      "moc-v3-overall-coverage-shortfall",
      `Market-valued MoC collateral covers ${(collateralizationRatio * 100).toFixed(2)}% of USDRIF liabilities`,
    ));
  }

  const closing = await runAdapterIo(ctx, `${ADAPTER_KEY}:closing-header`, () =>
    fetchEvmRpcBatch(undefined, [{ method: "eth_getBlockByNumber", params: [toBlockTag(targetBlock), false] }], options));
  const closingHeader = parseBlockHeader(closing?.[0], "closing target block");
  if (closingHeader.hash !== header.hash) throw new Error(`${ADAPTER_KEY}: target block hash changed during observation`);

  return {
    slices: slicesFromValues([
      {
        sourceKey: "moc-v3-buckets:usdrif:rif",
        value: marketValues.find((value) => value.branch.label === "rif")?.marketValueUsd ?? 0,
        name: "RIF collateral admitted to the RIF On Chain V3 RIF bucket",
        risk: "high",
      },
      {
        sourceKey: "moc-v3-buckets:usdrif:doc",
        value: marketValues.find((value) => value.branch.label === "doc")?.marketValueUsd ?? 0,
        name: "DOC collateral admitted to the RIF On Chain V3 DOC bucket",
        risk: "high",
        coinId: "doc-money-on-chain",
        depType: "collateral",
      },
    ], 10),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata(),
      sourceTimestamp: header.timestamp,
      supplyUsd: totalLiabilitiesUsd,
      totalReserveUsd,
      totalAssetsUsd: totalReserveUsd,
      totalLiabilitiesUsd,
      collateralizationRatio,
      unknownExposurePct: 0,
      details: {
        basis: "market-valued MoC V3 admitted collateral; protocol coverage retained separately",
        rpc: params.rpcUrl,
        fallbackRpc: params.fallbackRpcUrl,
        pinnedBlock: targetBlock,
        pinnedBlockHash: header.hash,
        confirmationDepth: params.confirmationDepth,
        canonicalTotalSupplyRaw: totalSupplyRaw.toString(),
        branchLiabilitySumRaw: (rif.liabilityRaw + doc.liabilityRaw).toString(),
        protocolCoverage: marketValues.map((value) => ({
          bucket: value.branch.params.address,
          ratio: value.protocolCoverage,
          priceUsd: decimal(value.branch.protocolPriceRaw, 18, "protocol price"),
          provider: value.branch.priceProvider,
        })),
        branches: branchDetails,
        oracleFreshness: "provider timestamp unavailable; market-price agreement guard enforced",
        sourceUrls: params.sourceUrls,
      },
    },
  };
}
