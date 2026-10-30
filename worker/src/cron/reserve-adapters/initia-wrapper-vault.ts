import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "@shared/lib/live-reserve-freshness";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { throwIfAborted } from "../../lib/abort";
import { LIVE_RESERVE_FRESHNESS_SEC } from "../../lib/live-reserves/store-shared";
import {
  decimalNumberFromBigInt,
  notApplicableFreshnessMetadata,
  requireJsonInput,
  reserveInfoWarning,
  reserveDegradedWarning,
} from "./helpers";
import { fetchJsonPostWithRetry, fetchJsonWithRetry } from "./request";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER = "initia-wrapper-vault" as const;
type InitiaWrapperVaultParams = LiveReserveAdapterParamsByKey[typeof ADAPTER];
const MOVE_METADATA_TYPE = "0x1::fungible_asset::Metadata";
const MOVE_OBJECT_CORE_TYPE = "0x1::object::ObjectCore";
const MOVE_VIEW_URL = "/initia/move/v1/view/json";
const BANK_SUPPLY_URL = "/cosmos/bank/v1beta1/supply/by_denom";
const RESOURCES_BY_STRUCT_TAG_URL = "/initia/move/v1/accounts";
const NODE_INFO_URL = "/cosmos/base/tendermint/v1beta1/node_info";
const LATEST_BLOCK_URL = "/cosmos/base/tendermint/v1beta1/blocks/latest";
const EXPECTED_AUSD0_SYMBOL = "AUSD0";
const EXPECTED_AUSD0_PROJECT_URI = "https://www.agora.finance";
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * Initia mainnet. A chain-object or network migration changes what every read
 * below means, so the adapter only ever reads this reviewed chain.
 */
const REVIEWED_CHAIN_ID = "interwoven-1";
/**
 * Reviewed transport allowlist bound. The params list may not grow past three
 * endpoints without a code review of the failover and corroboration contract.
 */
const MAX_REVIEWED_LCD_ENDPOINTS = 3;
/**
 * A latest-state batch is only one coherent observation when the head it
 * starts from and the head it ends at are close. Initia produces roughly a
 * block every 2.3s; twenty blocks (~46s) comfortably contains four sequential
 * LCD reads while still catching a load-balanced provider whose reads land on
 * different replicas. Crossing it retries the batch once, then publishes with
 * `latest-state-height-drift`.
 */
const MAX_BATCH_BLOCK_HEIGHT_DRIFT = 20;
/**
 * The two reviewed heights showed the parent supply exceeding iUSD supply by
 * about 2.56 AUSD0. Keep a small, explicit base-unit tolerance for that stable
 * parent-side dust instead of rounding the live coverage ratio to 100%.
 *
 * The adapter reads the vault's balance, not the parent's total supply, so a
 * balance surplus within this tolerance is informational and keeps its exact
 * collateralizationRatio. Larger surpluses remain informational; shortfalls degrade.
 */
const DUST_TOLERANCE_RAW = 5_000_000n;
const DUST_TOLERANCE_TOKENS = 5;

/**
 * A deliberate repeat read of the same URL inside one adapter run. The shared
 * request cache exists to coalesce callers, so the head reads that bracket the
 * batch (and every read replayed by a height-drift retry) must opt out of it.
 */
const REPEAT_READ_OPTIONS = { onResponse: () => undefined } as const;

interface InitiaViewResponse {
  data?: unknown;
}

interface InitiaSupplyResponse {
  amount?: unknown;
}

interface InitiaResourceEnvelope {
  resource?: {
    address?: unknown;
    struct_tag?: unknown;
    move_resource?: unknown;
  };
}

interface ParsedMoveResource {
  type: string;
  data: Record<string, unknown>;
}

interface Ausd0Metadata {
  name: string;
  symbol: string;
  decimals: number;
  projectUri: string;
}

interface ReviewedLcdEndpoints {
  endpoints: string[];
  chainId: string;
}

interface BlockHeaderObservation {
  height: number;
  timeSec: number;
  timeIso: string;
}

interface EndpointBatchObservation {
  before: BlockHeaderObservation;
  after: BlockHeaderObservation;
  vaultBalanceRaw: bigint;
  iusdSupplyRaw: bigint;
  ausd0Metadata: Ausd0Metadata;
  heightDriftBlocks: number;
}

interface EndpointObservation extends EndpointBatchObservation {
  provider: string;
  heightDriftRetried: boolean;
}

interface SupplyObservation {
  provider: string;
  supplyRaw: bigint;
}

interface TransportFailure {
  provider: string;
  reason: string;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${ADAPTER}: ${label} is missing or malformed`);
  }
  return value as Record<string, unknown>;
}

function parseMoveResource(value: unknown, label: string): ParsedMoveResource {
  if (typeof value !== "string") {
    throw new Error(`${ADAPTER}: ${label} move_resource is missing or malformed`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error(`${ADAPTER}: ${label} move_resource is not valid JSON`);
  }
  const resource = readRecord(decoded, `${label} move_resource`);
  const type = resource.type;
  const data = readRecord(resource.data, `${label} move_resource.data`);
  if (typeof type !== "string" || type.length === 0) {
    throw new Error(`${ADAPTER}: ${label} move_resource.type is missing`);
  }
  return { type, data };
}

function assertResourceIdentity(
  response: InitiaResourceEnvelope,
  expectedAddress: string,
  expectedStructTag: string,
  label: string,
): ParsedMoveResource {
  const resource = readRecord(response.resource, `${label} resource`);
  if (resource.address !== expectedAddress) {
    throw new Error(
      `${ADAPTER}: ${label} address mismatch (expected ${expectedAddress}, got ${String(resource.address)})`,
    );
  }
  if (resource.struct_tag !== expectedStructTag) {
    throw new Error(
      `${ADAPTER}: ${label} struct tag mismatch (expected ${expectedStructTag}, got ${String(resource.struct_tag)})`,
    );
  }
  const parsed = parseMoveResource(resource.move_resource, label);
  if (parsed.type !== expectedStructTag) {
    throw new Error(
      `${ADAPTER}: ${label} move resource type mismatch (expected ${expectedStructTag}, got ${parsed.type})`,
    );
  }
  return parsed;
}

function parseRawUnsigned(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${ADAPTER}: ${label} must be a non-negative integer string`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${ADAPTER}: ${label} is outside the supported integer range`);
  }
}

/** Initia's JSON view wraps the u64 return value in an escaped JSON string. */
function parseViewBalance(response: InitiaViewResponse): bigint {
  if (typeof response.data !== "string") {
    throw new Error(`${ADAPTER}: view response data is missing or malformed`);
  }

  let value: unknown = response.data;
  try {
    const decoded = JSON.parse(response.data);
    if (typeof decoded === "string") {
      value = decoded;
    }
  } catch {
    // Some compatible LCD proxies return the unescaped numeric string directly.
    // It is still checked strictly below; arbitrary text never becomes zero.
  }
  return parseRawUnsigned(value, "vault AUSD0 balance");
}

function parseBankSupply(response: InitiaSupplyResponse, expectedDenom: string): bigint {
  const amount = readRecord(response.amount, "bank supply amount");
  if (amount.denom !== expectedDenom) {
    throw new Error(
      `${ADAPTER}: iUSD denom mismatch (expected ${expectedDenom}, got ${String(amount.denom)})`,
    );
  }
  return parseRawUnsigned(amount.amount, "iUSD bank supply");
}

function readSlice(params: InitiaWrapperVaultParams): ReserveSlice {
  if (params.slice.coinId !== "ausd-agora" || params.slice.depType !== "wrapper") {
    throw new Error(`${ADAPTER}: slice must target ausd-agora with depType wrapper`);
  }
  return {
    sourceKey: "initia-wrapper-vault:ausd",
    name: params.slice.name,
    pct: 100,
    risk: params.slice.risk,
    coinId: "ausd-agora",
    depType: "wrapper",
  };
}

function readAUsd0Metadata(
  response: InitiaResourceEnvelope,
  params: InitiaWrapperVaultParams,
): Ausd0Metadata {
  const metadata = assertResourceIdentity(
    response,
    params.ausd0MetadataAddress,
    MOVE_METADATA_TYPE,
    "AUSD0 metadata",
  );
  const name = metadata.data.name;
  const symbol = metadata.data.symbol;
  const decimals = metadata.data.decimals;
  const projectUri = metadata.data.project_uri;
  if (
    typeof name !== "string" ||
    typeof symbol !== "string" ||
    name !== EXPECTED_AUSD0_SYMBOL ||
    symbol !== EXPECTED_AUSD0_SYMBOL
  ) {
    throw new Error(`${ADAPTER}: AUSD0 metadata symbol/name mismatch`);
  }
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals !== params.decimals || params.decimals !== 6) {
    throw new Error(
      `${ADAPTER}: AUSD0 metadata decimals mismatch (expected ${params.decimals}, got ${String(decimals)})`,
    );
  }
  if (typeof projectUri !== "string" || projectUri !== EXPECTED_AUSD0_PROJECT_URI) {
    throw new Error(
      `${ADAPTER}: AUSD0 metadata project_uri mismatch (expected ${EXPECTED_AUSD0_PROJECT_URI}, got ${String(projectUri)})`,
    );
  }
  return { name, symbol, decimals, projectUri };
}

function canonicalLcdEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${ADAPTER}: reviewed LCD endpoints must use https`);
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new Error(
      `${ADAPTER}: reviewed LCD endpoints must not carry credentials, a query or a fragment`,
    );
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

function readLcdEndpointParam(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${ADAPTER}: ${label} must be a non-empty absolute https URL`);
  }
  try {
    return canonicalLcdEndpoint(value);
  } catch {
    throw new Error(
      `${ADAPTER}: ${label} must be an absolute https URL without credentials, a query or a fragment`,
    );
  }
}

/**
 * The reviewed transport list is additive to the shared params schema: the
 * declaration keeps `lcdUrl` as the reviewed primary, and `lcdUrls` may repeat
 * it up to three times. Those transport fields are validated here and removed
 * before the identity params reach the shared strict parser, so the adapter
 * supports the reviewed list whether or not the declaration has caught up.
 */
function readReviewedTransport(
  rawParams: Record<string, unknown>,
  parsedLcdUrl: string,
  primaryInputUrl: string,
): ReviewedLcdEndpoints {
  const chainIdParam = rawParams.chainId;
  if (chainIdParam !== undefined && chainIdParam !== REVIEWED_CHAIN_ID) {
    throw new Error(`${ADAPTER}: params.chainId must be the reviewed ${REVIEWED_CHAIN_ID}`);
  }
  const primary = readLcdEndpointParam(primaryInputUrl, "inputs.primary.url");
  const reviewedPrimary = readLcdEndpointParam(parsedLcdUrl, "params.lcdUrl");
  const lcdUrlsParam = rawParams.lcdUrls;
  if (lcdUrlsParam === undefined) {
    if (primary !== reviewedPrimary) {
      throw new Error(`${ADAPTER}: inputs.primary.url must match params.lcdUrl`);
    }
    return { endpoints: [reviewedPrimary], chainId: REVIEWED_CHAIN_ID };
  }
  if (chainIdParam === undefined) {
    throw new Error(`${ADAPTER}: params.chainId is required when params.lcdUrls is present`);
  }
  if (!Array.isArray(lcdUrlsParam) || lcdUrlsParam.length < 1 || lcdUrlsParam.length > MAX_REVIEWED_LCD_ENDPOINTS) {
    throw new Error(
      `${ADAPTER}: params.lcdUrls must be an array of 1-${MAX_REVIEWED_LCD_ENDPOINTS} reviewed LCD endpoints`,
    );
  }
  const endpoints = lcdUrlsParam.map((value, index) => readLcdEndpointParam(value, `params.lcdUrls[${index}]`));
  if (new Set(endpoints).size !== endpoints.length) {
    throw new Error(`${ADAPTER}: params.lcdUrls contains a duplicate endpoint`);
  }
  if (endpoints[0] !== primary || endpoints[0] !== reviewedPrimary) {
    throw new Error(`${ADAPTER}: params.lcdUrls[0] must equal inputs.primary.url and params.lcdUrl`);
  }
  return { endpoints, chainId: REVIEWED_CHAIN_ID };
}

function identityParamsOnly(params: Record<string, unknown>): Record<string, unknown> {
  const identity = { ...params };
  delete identity.lcdUrls;
  delete identity.chainId;
  return identity;
}

function parseNodeInfoChainId(value: unknown): string {
  const nodeInfo = readRecord(
    readRecord(value, "node info").default_node_info,
    "node info default_node_info",
  );
  const network = nodeInfo.network;
  if (typeof network !== "string" || network.length === 0) {
    throw new Error(`${ADAPTER}: node info network is missing`);
  }
  return network;
}

function parseLatestBlockHeader(value: unknown, expectedChainId: string): BlockHeaderObservation {
  const block = readRecord(readRecord(value, "latest block").block, "latest block body");
  const header = readRecord(block.header, "latest block header");
  if (header.chain_id !== expectedChainId) {
    throw new Error(
      `${ADAPTER}: latest block chain id does not match the reviewed ${expectedChainId} (got ${String(header.chain_id)})`,
    );
  }
  const rawHeight = header.height;
  if (typeof rawHeight !== "string" || !/^(0|[1-9][0-9]*)$/.test(rawHeight)) {
    throw new Error(`${ADAPTER}: latest block height is missing or malformed`);
  }
  const height = Number(rawHeight);
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new Error(`${ADAPTER}: latest block height is outside the supported range`);
  }
  const rawTime = header.time;
  if (typeof rawTime !== "string") {
    throw new Error(`${ADAPTER}: latest block time is missing or malformed`);
  }
  const timeMs = Date.parse(rawTime);
  if (!Number.isFinite(timeMs)) {
    throw new Error(`${ADAPTER}: latest block time is not a parseable timestamp`);
  }
  return { height, timeSec: Math.floor(timeMs / 1_000), timeIso: rawTime };
}

/** Freshness verdict: a halted chain is not a current latest-state observation. */
function assertLatestStateClock(header: BlockHeaderObservation, nowSec: number): void {
  if (header.timeSec > nowSec + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) {
    throw new Error(
      `${ADAPTER}: latest block clock is ${header.timeSec - nowSec}s ahead of the run clock`,
    );
  }
  const ageSec = nowSec - header.timeSec;
  if (ageSec > LIVE_RESERVE_FRESHNESS_SEC) {
    throw new Error(
      `${ADAPTER}: latest block clock is ${ageSec}s old, outside the ${LIVE_RESERVE_FRESHNESS_SEC}s latest-state budget`,
    );
  }
}

/**
 * Transport and 5xx/timeout failures are the only failures the reviewed
 * allowlist may route around. Identity, schema, denom, owner and metadata
 * mismatches mean the chain object itself changed, so they fail the snapshot.
 */
function describeTransportFailure(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (error.name === "AbortError" || error.name === "TimeoutError") return "timeout";
  const statusMatch = /^HTTP (\d{3}) for /.exec(error.message);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return status === 408 || status >= 500 ? `http-${status}` : null;
  }
  return /^(?:POST )?fetch failed for /i.test(error.message) ? "fetch-failed" : null;
}

function describeTransportFailures(failures: readonly TransportFailure[]): string {
  return failures
    .map((failure) => `${failure.provider}: ${failure.reason === "fetch-failed" ? "fetch failed" : failure.reason}`)
    .join(", ");
}

async function readEndpointBatch(
  provider: string,
  params: InitiaWrapperVaultParams,
  chainId: string,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  refresh: boolean,
): Promise<EndpointBatchObservation> {
  const refreshOptions = refresh ? REPEAT_READ_OPTIONS : undefined;

  throwIfAborted(signal);
  const before = parseLatestBlockHeader(
    await fetchJsonWithRetry<unknown>(
      `${provider}${LATEST_BLOCK_URL}`,
      signal,
      REQUEST_TIMEOUT_MS,
      ctx,
      REPEAT_READ_OPTIONS,
    ),
    chainId,
  );

  // Keep these four reads sequential. The trigger-wide budget limits concurrent
  // header waits; identity correctness is worth four single-connection reads.
  throwIfAborted(signal);
  const viewResponse = await fetchJsonPostWithRetry<InitiaViewResponse>(
    `${provider}${MOVE_VIEW_URL}`,
    {
      address: "0x1",
      module_name: "primary_fungible_store",
      function_name: "balance",
      type_args: [MOVE_METADATA_TYPE],
      // Initia's ViewJSON args are JSON-stringified Move values. These two
      // authored object identities are therefore part of every balance read.
      args: [JSON.stringify(params.vaultOwnerAddress), JSON.stringify(params.ausd0MetadataAddress)],
    },
    signal,
    REQUEST_TIMEOUT_MS,
    ctx,
    refreshOptions,
  );
  const vaultBalanceRaw = parseViewBalance(viewResponse);

  throwIfAborted(signal);
  const supplyResponse = await fetchJsonWithRetry<InitiaSupplyResponse>(
    `${provider}${BANK_SUPPLY_URL}?denom=${encodeURIComponent(params.iusdDenom)}`,
    signal,
    REQUEST_TIMEOUT_MS,
    ctx,
    refreshOptions,
  );
  const iusdSupplyRaw = parseBankSupply(supplyResponse, params.iusdDenom);

  throwIfAborted(signal);
  const iusdIdentity = await fetchJsonWithRetry<InitiaResourceEnvelope>(
    `${provider}${RESOURCES_BY_STRUCT_TAG_URL}/${params.iusdMetadataAddress}/resources/by_struct_tag?struct_tag=${encodeURIComponent(MOVE_OBJECT_CORE_TYPE)}`,
    signal,
    REQUEST_TIMEOUT_MS,
    ctx,
    refreshOptions,
  );
  const iusdObjectCore = assertResourceIdentity(
    iusdIdentity,
    params.iusdMetadataAddress,
    MOVE_OBJECT_CORE_TYPE,
    "iUSD ObjectCore",
  );
  if (iusdObjectCore.data.owner !== params.vaultOwnerAddress) {
    throw new Error(
      `${ADAPTER}: iUSD metadata owner mismatch (expected ${params.vaultOwnerAddress}, got ${String(iusdObjectCore.data.owner)})`,
    );
  }

  throwIfAborted(signal);
  // The metadata object is mutable: the params and view arg pin which object
  // was requested, while this live read proves it still identifies Agora AUSD0
  // with the authored six-decimal representation.
  const ausd0MetadataResponse = await fetchJsonWithRetry<InitiaResourceEnvelope>(
    `${provider}${RESOURCES_BY_STRUCT_TAG_URL}/${params.ausd0MetadataAddress}/resources/by_struct_tag?struct_tag=${encodeURIComponent(MOVE_METADATA_TYPE)}`,
    signal,
    REQUEST_TIMEOUT_MS,
    ctx,
    refreshOptions,
  );
  const ausd0Metadata = readAUsd0Metadata(ausd0MetadataResponse, params);

  throwIfAborted(signal);
  const after = parseLatestBlockHeader(
    await fetchJsonWithRetry<unknown>(
      `${provider}${LATEST_BLOCK_URL}`,
      signal,
      REQUEST_TIMEOUT_MS,
      ctx,
      REPEAT_READ_OPTIONS,
    ),
    chainId,
  );

  return {
    before,
    after,
    vaultBalanceRaw,
    iusdSupplyRaw,
    ausd0Metadata,
    heightDriftBlocks: Math.abs(after.height - before.height),
  };
}

async function readEndpointObservation(
  provider: string,
  params: InitiaWrapperVaultParams,
  chainId: string,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  nowSec: number,
): Promise<EndpointObservation> {
  const network = parseNodeInfoChainId(
    await fetchJsonWithRetry<unknown>(`${provider}${NODE_INFO_URL}`, signal, REQUEST_TIMEOUT_MS, ctx),
  );
  if (network !== chainId) {
    throw new Error(
      `${ADAPTER}: node info chain id does not match the reviewed ${chainId} (got ${network})`,
    );
  }

  let batch = await readEndpointBatch(provider, params, chainId, signal, ctx, false);
  assertLatestStateClock(batch.after, nowSec);
  if (batch.heightDriftBlocks <= MAX_BATCH_BLOCK_HEIGHT_DRIFT) {
    return { provider, ...batch, heightDriftRetried: false };
  }
  batch = await readEndpointBatch(provider, params, chainId, signal, ctx, true);
  assertLatestStateClock(batch.after, nowSec);
  return { provider, ...batch, heightDriftRetried: true };
}

/**
 * Corroborate only the liability the ratio divides by. One published balance
 * and an exactly agreeing supply is a coherent observation; a second balance
 * read at a different block would only add height-skew noise the dust
 * tolerance already covers.
 */
async function readCorroboratingSupply(
  provider: string,
  params: InitiaWrapperVaultParams,
  chainId: string,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<SupplyObservation> {
  const network = parseNodeInfoChainId(
    await fetchJsonWithRetry<unknown>(`${provider}${NODE_INFO_URL}`, signal, REQUEST_TIMEOUT_MS, ctx),
  );
  if (network !== chainId) {
    throw new Error(
      `${ADAPTER}: node info chain id does not match the reviewed ${chainId} (got ${network})`,
    );
  }
  const supplyResponse = await fetchJsonWithRetry<InitiaSupplyResponse>(
    `${provider}${BANK_SUPPLY_URL}?denom=${encodeURIComponent(params.iusdDenom)}`,
    signal,
    REQUEST_TIMEOUT_MS,
    ctx,
  );
  return { provider, supplyRaw: parseBankSupply(supplyResponse, params.iusdDenom) };
}

export async function fetchInitiaWrapperVaultReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, ADAPTER);
  const rawParams = config.params ?? {};
  const params = parseLiveReserveAdapterParams(ADAPTER, identityParamsOnly(rawParams));
  const denomMetadataAddress = params.iusdDenom.startsWith("move/")
    ? `0x${params.iusdDenom.slice("move/".length)}`
    : "";
  if (denomMetadataAddress !== params.iusdMetadataAddress) {
    throw new Error(
      `${ADAPTER}: iUSD denom and metadata address do not identify the same asset`,
    );
  }
  const transport = readReviewedTransport(rawParams, params.lcdUrl, input.url);
  const slice = readSlice(params);
  const nowSec = ctx?.nowSec ?? Math.floor(Date.now() / 1_000);

  const transportFailures: TransportFailure[] = [];
  let observation: EndpointObservation | null = null;
  let publisherIndex = -1;
  for (const [index, provider] of transport.endpoints.entries()) {
    throwIfAborted(signal);
    try {
      observation = await readEndpointObservation(provider, params, transport.chainId, signal, ctx, nowSec);
      publisherIndex = index;
      break;
    } catch (error) {
      if (signal.aborted) throw error;
      const reason = describeTransportFailure(error);
      if (reason === null) throw error;
      transportFailures.push({ provider, reason });
    }
  }
  if (!observation) {
    throw new Error(
      `${ADAPTER}: no reviewed Initia LCD endpoint answered (${describeTransportFailures(transportFailures)})`,
    );
  }

  const corroborating: SupplyObservation[] = [];
  for (const provider of transport.endpoints.slice(publisherIndex + 1)) {
    throwIfAborted(signal);
    try {
      const supply = await readCorroboratingSupply(provider, params, transport.chainId, signal, ctx);
      // Exact raw-unit agreement: a rounding-equivalent token amount is still a
      // different liability, and a disagreement is a failed snapshot, not a
      // reason to prefer another provider.
      if (supply.supplyRaw !== observation.iusdSupplyRaw) {
        throw new Error(
          `${ADAPTER}: reviewed LCD endpoints disagree on iusdSupply (${observation.provider} ${observation.iusdSupplyRaw} vs ${provider} ${supply.supplyRaw})`,
        );
      }
      corroborating.push(supply);
    } catch (error) {
      if (signal.aborted) throw error;
      const reason = describeTransportFailure(error);
      if (reason === null) throw error;
      transportFailures.push({ provider, reason });
    }
  }

  const supplyTokens = decimalNumberFromBigInt(observation.iusdSupplyRaw, params.decimals);
  const vaultBalanceTokens = decimalNumberFromBigInt(observation.vaultBalanceRaw, params.decimals);
  const collateralizationRatio = observation.iusdSupplyRaw > 0n
    ? Number(observation.vaultBalanceRaw) / Number(observation.iusdSupplyRaw)
    : undefined;
  if (!Number.isFinite(supplyTokens) || !Number.isFinite(vaultBalanceTokens) ||
      (collateralizationRatio !== undefined && !Number.isFinite(collateralizationRatio))) {
    throw new Error(`${ADAPTER}: reserve values are outside the supported numeric range`);
  }

  const surplusRaw = observation.vaultBalanceRaw - observation.iusdSupplyRaw;

  const warnings: LiveReserveWarning[] = [];
  if (observation.heightDriftBlocks > MAX_BATCH_BLOCK_HEIGHT_DRIFT) {
    warnings.push(reserveDegradedWarning(
      "latest-state-height-drift",
      `${coin.id} Initia reads straddled ${observation.heightDriftBlocks} blocks across a retry (budget ${MAX_BATCH_BLOCK_HEIGHT_DRIFT})`,
    ));
  }
  if (corroborating.length === 0) {
    warnings.push(reserveInfoWarning(
      "single-node-observation",
      `${coin.id} iUSD supply was observed on one reviewed Initia LCD (${new URL(observation.provider).host}); no second provider corroborated it`,
    ));
  }
  if (surplusRaw > 0n) {
    warnings.push(reserveInfoWarning(
      "reserve-overcollateralized-dust",
      `${coin.id} vault exceeds iUSD supply by ${decimalNumberFromBigInt(surplusRaw, params.decimals)} AUSD0 (${surplusRaw <= DUST_TOLERANCE_RAW ? "within" : "above"} the ${DUST_TOLERANCE_TOKENS} AUSD0 dust threshold)`,
    ));
  }
  if (surplusRaw < 0n || observation.iusdSupplyRaw === 0n) {
    warnings.push(reserveDegradedWarning(
      "reserve-undercollateralized",
      `${coin.id} observed vault balance ${observation.vaultBalanceRaw} and iUSD supply ${observation.iusdSupplyRaw} raw units`,
    ));
  }

  return {
    slices: [slice],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({ proofKind: "initia-move-view" }),
      supplyTokens,
      totalReserveQuantity: vaultBalanceTokens,
      ...(collateralizationRatio !== undefined ? { collateralizationRatio } : {}),
      details: {
        proofKind: "initia-wrapper-vault-balance-vs-bank-supply",
        chainId: transport.chainId,
        lcdProvider: observation.provider,
        lcdProviders: transport.endpoints,
        corroboratingLcdProviders: corroborating.map((entry) => entry.provider),
        providerTransportFailures: transportFailures,
        batchStartHeight: observation.before.height,
        latestStateHeight: observation.after.height,
        latestStateBlockTime: observation.after.timeIso,
        latestStateBlockTimeSec: observation.after.timeSec,
        heightDriftBlocks: observation.heightDriftBlocks,
        heightDriftToleranceBlocks: MAX_BATCH_BLOCK_HEIGHT_DRIFT,
        ...(observation.heightDriftRetried ? { heightDriftRetried: true } : {}),
        iusdSupplyAgreement: {
          observedEndpoints: corroborating.length + 1,
          // A single observation never becomes an agreement claim.
          agreement: corroborating.length > 0 ? "exact" : "unavailable",
        },
        providerObservations: [
          {
            provider: observation.provider,
            supplyRaw: observation.iusdSupplyRaw.toString(),
            blockHeight: observation.after.height,
            blockTimeSec: observation.after.timeSec,
          },
          ...corroborating.map((entry) => ({
            provider: entry.provider,
            supplyRaw: entry.supplyRaw.toString(),
          })),
        ],
        vaultBalanceRaw: observation.vaultBalanceRaw.toString(),
        iusdSupplyRaw: observation.iusdSupplyRaw.toString(),
        surplusRaw: surplusRaw.toString(),
        dustToleranceRaw: DUST_TOLERANCE_RAW.toString(),
        vaultOwnerAddress: params.vaultOwnerAddress,
        iusdMetadataAddress: params.iusdMetadataAddress,
        iusdDenom: params.iusdDenom,
        ausd0MetadataAddress: params.ausd0MetadataAddress,
        ausd0Metadata: observation.ausd0Metadata,
      },
    },
  };
}
