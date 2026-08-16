import { logWorkerEventArgs } from "../structured-log";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { keccak256 } from "viem/utils";
import { z } from "zod";
import { CIRCUIT_SOURCE, USER_AGENT } from "../constants";
import { throwIfAborted } from "../abort";
import { encodeAddress, encodeUint256 } from "../evm-selectors";
import { fetchJsonWithRetry } from "../fetch-retry";
import {
  buildParentDerivedLiveOverride,
  decodeUint256WordBigInt,
  PROTOCOL_REDEEM_SOURCE,
  resolveTrustedOverrideParent,
  type CurrentPriceOverride,
  type LivePriceContext,
  type PriceSourceProvider,
  type TrustedOverrideParent,
} from "./helpers";

const CITREA_RPC_URL = "https://rpc.mainnet.citrea.xyz";
const CITREA_CHAIN_ID = 4114;
const CITREA_BLOCK_MAX_AGE_SEC = 2 * 60;
const CITREA_BLOCK_MAX_FUTURE_SKEW_SEC = 60;
const CITREA_REQUEST_TIMEOUT_MS = 3_500;
const CITREA_MAX_RESPONSE_BYTES = 256 * 1024;

const JUSD_ID = "jusd-juicedollar";
const JUSD_ADDRESS = "0x0987d3720d38847ac6dbb9d025b9de892a3ca35c";
const JUSD_RESERVE = "0x2a36f2b204b46fd82653cd06d00c7ff757c99ae4";
const JUSD_DECIMALS = 18;
const JUSD_RUNTIME_CODE_HASH = "0xf822bbd111d9275ce9d4e62bfff5f45932618ab55960e4c8fadfc9d7f0ca4265";

const ONE_JUSD_RAW = 10n ** 18n;
const MIN_REDEEMABLE_JUSD_RAW = 1_000n * ONE_JUSD_RAW;

const USD_SELECTOR = "0xd63a6ccd";
const JUSD_SELECTOR = "0xa012e78d";
const STOPPED_SELECTOR = "0x75f12b21";
const HORIZON_SELECTOR = "0x1ce832b5";
const LIMIT_SELECTOR = "0xa4d66daf";
const MINTED_SELECTOR = "0x4f02c420";
const DECIMALS_SELECTOR = "0x313ce567";
const RESERVE_SELECTOR = "0xcd3293de";
const BALANCE_OF_SELECTOR = "0x70a08231";
const ALLOWANCE_SELECTOR = "0xdd62ed3e";
const IS_MINTER_SELECTOR = "0xaa271e1a";
const BURN_SELECTOR = "0x42966c68";

interface JuiceDollarBridgeRoute {
  parentId: string;
  bridge: string;
  quoteToken: string;
  quoteDecimals: number;
  expectedBridgeCodeHash: `0x${string}`;
}

const JUSD_BRIDGE_ROUTES: readonly JuiceDollarBridgeRoute[] = [
  {
    parentId: "usdt-tether",
    bridge: "0x5cc0e668f8ba61e111b6168e19d17d3c65040614",
    quoteToken: "0x9f3096bac87e7f03dc09b0b416eb0df837304dc4",
    quoteDecimals: 6,
    expectedBridgeCodeHash: "0x3aaff2c68217cc43382a63e0e583b4049d374e4261f22f10b5c636fa2a468605",
  },
  {
    parentId: "usdc-circle",
    bridge: "0x920db0adf6fee2d69401e9f68d60319177dca20f",
    quoteToken: "0xe045e6c36cf77faa2cfb54466d71a3aef7bbe839",
    quoteDecimals: 6,
    expectedBridgeCodeHash: "0xde2941772b21272966012f10a752e62fd7f7a780525ba10a67fca973f6ecff54",
  },
  {
    parentId: "ctusd-citrea",
    bridge: "0x8d11020286af9ecf7e5d7bd79699c391b224a0bd",
    quoteToken: "0x8d82c4e3c936c7b5724a382a9c5a4e6eb7ab6d5d",
    quoteDecimals: 6,
    expectedBridgeCodeHash: "0x9fe4f6615e1bb6f747d50aa282a215521a4507fda4f20de60f7ef2f60c2627ec",
  },
];

interface JsonRpcCall {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: unknown[];
}

const JsonRpcBatchEntrySchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

const CitreaBlockSchema = z.object({
  number: z.string(),
  timestamp: z.string(),
});

interface CitreaHead {
  blockNumber: number;
  blockTimestamp: number;
}

interface ValidatedBridgeState {
  blockNumber: number;
  redeemableJusd: number;
}

function rpcCall(id: string, method: string, params: unknown[]): JsonRpcCall {
  return { jsonrpc: "2.0", id, method, params };
}

async function fetchCitreaRpcBatch(
  calls: readonly JsonRpcCall[],
  signal?: AbortSignal,
): Promise<Map<string, unknown> | null> {
  const result = await fetchJsonWithRetry<unknown>(
    CITREA_RPC_URL,
    {
      method: "POST",
      signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(calls),
    },
    0,
    {
      timeoutMs: CITREA_REQUEST_TIMEOUT_MS,
      maxResponseBytes: CITREA_MAX_RESPONSE_BYTES,
    },
  );
  if (!result?.response.ok) {
    logWorkerEventArgs("lib", "warn", `[jusd-stablecoin-bridge] Citrea RPC returned ${result?.response.status ?? "no response"}`);
    return null;
  }

  const parsed = z.array(JsonRpcBatchEntrySchema).safeParse(result.body);
  if (!parsed.success || parsed.data.length !== calls.length) {
    logWorkerEventArgs("lib", "warn", "[jusd-stablecoin-bridge] Citrea RPC batch response failed schema or cardinality validation");
    return null;
  }

  const expectedIds = new Set(calls.map((call) => call.id));
  const values = new Map<string, unknown>();
  for (const entry of parsed.data) {
    if (!expectedIds.has(entry.id) || values.has(entry.id) || entry.error !== undefined || entry.result === undefined) {
      logWorkerEventArgs("lib", "warn", "[jusd-stablecoin-bridge] Citrea RPC batch contained an error or unexpected result id");
      return null;
    }
    values.set(entry.id, entry.result);
  }
  return values.size === expectedIds.size ? values : null;
}

function parseHexBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !value.startsWith("0x") || value.length <= 2) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function parseHexSafeInteger(value: unknown): number | null {
  const parsed = parseHexBigInt(value);
  return parsed != null && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
}

function parseAbiUint256(value: unknown): bigint | null {
  return typeof value === "string" ? decodeUint256WordBigInt(value as `0x${string}`, 0) : null;
}

function parseAbiAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length !== 66 || !value.startsWith("0x")) return null;
  const address = `0x${value.slice(26)}`.toLowerCase();
  return address.length === 42 ? address : null;
}

function parseAbiBool(value: unknown): boolean | null {
  const parsed = parseAbiUint256(value);
  return parsed === 0n ? false : parsed === 1n ? true : null;
}

function asRuntimeCode(value: unknown): `0x${string}` | null {
  return typeof value === "string" && value.startsWith("0x") && value.length > 2 ? (value as `0x${string}`) : null;
}

function toBlockTag(blockNumber: number): `0x${string}` {
  return `0x${blockNumber.toString(16)}`;
}

function balanceOfCalldata(account: string): `0x${string}` {
  return `${BALANCE_OF_SELECTOR}${encodeAddress(account)}`;
}

function allowanceCalldata(owner: string, spender: string): `0x${string}` {
  return `${ALLOWANCE_SELECTOR}${encodeAddress(owner)}${encodeAddress(spender)}`;
}

function isMinterCalldata(minter: string): `0x${string}` {
  return `${IS_MINTER_SELECTOR}${encodeAddress(minter)}`;
}

function burnCalldata(amount: bigint): `0x${string}` {
  return `${BURN_SELECTOR}${encodeUint256(amount)}`;
}

function ethCall(id: string, to: string, data: string, blockTag: string): JsonRpcCall {
  return rpcCall(id, "eth_call", [{ to, data }, blockTag]);
}

async function fetchFreshCitreaHead(signal?: AbortSignal): Promise<CitreaHead | null> {
  const response = await fetchCitreaRpcBatch(
    [rpcCall("chain-id", "eth_chainId", []), rpcCall("latest-block", "eth_getBlockByNumber", ["latest", false])],
    signal,
  );
  if (!response) return null;

  const chainId = parseHexSafeInteger(response.get("chain-id"));
  const block = CitreaBlockSchema.safeParse(response.get("latest-block"));
  if (!block.success) return null;
  const blockNumber = parseHexSafeInteger(block.data.number);
  const blockTimestamp = parseHexSafeInteger(block.data.timestamp);
  const nowSec = Math.floor(Date.now() / 1_000);
  if (
    chainId !== CITREA_CHAIN_ID ||
    blockNumber == null ||
    blockNumber <= 0 ||
    blockTimestamp == null ||
    nowSec - blockTimestamp > CITREA_BLOCK_MAX_AGE_SEC ||
    blockTimestamp - nowSec > CITREA_BLOCK_MAX_FUTURE_SKEW_SEC
  ) {
    logWorkerEventArgs("lib", "warn", "[jusd-stablecoin-bridge] Citrea head identity or freshness validation failed");
    return null;
  }
  return { blockNumber, blockTimestamp };
}

async function fetchValidatedBridgeState(
  route: JuiceDollarBridgeRoute,
  head: CitreaHead,
  signal?: AbortSignal,
): Promise<ValidatedBridgeState | null> {
  const blockTag = toBlockTag(head.blockNumber);
  const response = await fetchCitreaRpcBatch(
    [
      rpcCall("jusd-code", "eth_getCode", [JUSD_ADDRESS, blockTag]),
      rpcCall("bridge-code", "eth_getCode", [route.bridge, blockTag]),
      ethCall("jusd-decimals", JUSD_ADDRESS, DECIMALS_SELECTOR, blockTag),
      ethCall("jusd-reserve", JUSD_ADDRESS, RESERVE_SELECTOR, blockTag),
      ethCall("reserve-balance", JUSD_ADDRESS, balanceOfCalldata(JUSD_RESERVE), blockTag),
      ethCall("reserve-allowance", JUSD_ADDRESS, allowanceCalldata(JUSD_RESERVE, route.bridge), blockTag),
      ethCall("bridge-usd", route.bridge, USD_SELECTOR, blockTag),
      ethCall("bridge-jusd", route.bridge, JUSD_SELECTOR, blockTag),
      ethCall("bridge-stopped", route.bridge, STOPPED_SELECTOR, blockTag),
      ethCall("bridge-horizon", route.bridge, HORIZON_SELECTOR, blockTag),
      ethCall("bridge-limit", route.bridge, LIMIT_SELECTOR, blockTag),
      ethCall("bridge-minted", route.bridge, MINTED_SELECTOR, blockTag),
      ethCall("bridge-minter", JUSD_ADDRESS, isMinterCalldata(route.bridge), blockTag),
      ethCall("quote-decimals", route.quoteToken, DECIMALS_SELECTOR, blockTag),
      ethCall("quote-balance", route.quoteToken, balanceOfCalldata(route.bridge), blockTag),
      // StablecoinBridge v4.0.2 gates minting, not `_burn`. The pinned runtime
      // makes this funded reserve simulation a permissionless burn-path witness.
      rpcCall("burn-simulation", "eth_estimateGas", [
        {
          from: JUSD_RESERVE,
          to: route.bridge,
          data: burnCalldata(ONE_JUSD_RAW),
        },
        blockTag,
      ]),
    ],
    signal,
  );
  if (!response) return null;

  const jusdCode = asRuntimeCode(response.get("jusd-code"));
  const bridgeCode = asRuntimeCode(response.get("bridge-code"));
  if (
    !jusdCode ||
    !bridgeCode ||
    keccak256(jusdCode).toLowerCase() !== JUSD_RUNTIME_CODE_HASH ||
    keccak256(bridgeCode).toLowerCase() !== route.expectedBridgeCodeHash
  ) {
    logWorkerEventArgs("lib", "warn", "[jusd-stablecoin-bridge] JUSD or bridge runtime bytecode does not match the reviewed deployment");
    return null;
  }

  const jusdDecimals = parseAbiUint256(response.get("jusd-decimals"));
  const jusdReserve = parseAbiAddress(response.get("jusd-reserve"));
  const reserveBalance = parseAbiUint256(response.get("reserve-balance"));
  const reserveAllowance = parseAbiUint256(response.get("reserve-allowance"));
  const bridgeUsd = parseAbiAddress(response.get("bridge-usd"));
  const bridgeJusd = parseAbiAddress(response.get("bridge-jusd"));
  const stopped = parseAbiBool(response.get("bridge-stopped"));
  const horizon = parseAbiUint256(response.get("bridge-horizon"));
  const limit = parseAbiUint256(response.get("bridge-limit"));
  const minted = parseAbiUint256(response.get("bridge-minted"));
  const isMinter = parseAbiBool(response.get("bridge-minter"));
  const quoteDecimals = parseAbiUint256(response.get("quote-decimals"));
  const quoteBalance = parseAbiUint256(response.get("quote-balance"));
  const simulatedGas = parseHexBigInt(response.get("burn-simulation"));

  if (
    jusdDecimals !== BigInt(JUSD_DECIMALS) ||
    jusdReserve !== JUSD_RESERVE ||
    reserveBalance == null ||
    reserveBalance < ONE_JUSD_RAW ||
    reserveAllowance == null ||
    reserveAllowance < ONE_JUSD_RAW ||
    bridgeUsd !== route.quoteToken ||
    bridgeJusd !== JUSD_ADDRESS ||
    stopped == null ||
    horizon == null ||
    limit == null ||
    minted == null ||
    minted <= 0n ||
    minted > limit ||
    isMinter !== true ||
    quoteDecimals !== BigInt(route.quoteDecimals) ||
    quoteBalance == null ||
    simulatedGas == null ||
    simulatedGas <= 0n
  ) {
    logWorkerEventArgs("lib", "warn", "[jusd-stablecoin-bridge] bridge identity, availability, or static burn validation failed");
    return null;
  }

  const quoteBalanceInJusdRaw = quoteBalance * 10n ** BigInt(JUSD_DECIMALS - route.quoteDecimals);
  if (quoteBalanceInJusdRaw < minted || minted < MIN_REDEEMABLE_JUSD_RAW) {
    logWorkerEventArgs("lib", "warn", "[jusd-stablecoin-bridge] bridge is underfunded or below the minimum redemption capacity");
    return null;
  }

  return {
    blockNumber: head.blockNumber,
    redeemableJusd: Number(minted / 10n ** 10n) / 10 ** 8,
  };
}

export const jusdStablecoinBridgeProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  liveCircuitSource: CIRCUIT_SOURCE.JUSD_CITREA_BRIDGE,
  livePriority: 1,
  liveTimeoutMs: 5_000,
  recordNullLiveResultAsCircuitFailure: true,
  matches(stablecoinId: string): boolean {
    return stablecoinId === JUSD_ID;
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    const trustedRoutes: Array<{ route: JuiceDollarBridgeRoute; parent: TrustedOverrideParent }> = [];
    for (const route of JUSD_BRIDGE_ROUTES) {
      const parent = resolveTrustedOverrideParent(
        context,
        route.parentId,
        () =>
          `[authoritative-price-sources] ${asset.id}: skipped ${route.parentId} bridge because quote-token provenance is not trusted`,
      );
      if (parent) trustedRoutes.push({ route, parent });
    }
    if (trustedRoutes.length === 0) return null;

    const head = await fetchFreshCitreaHead(signal);
    if (!head) return null;

    for (const { route, parent } of trustedRoutes) {
      throwIfAborted(signal);
      const bridgeState = await fetchValidatedBridgeState(route, head, signal);
      if (!bridgeState) continue;

      const override = buildParentDerivedLiveOverride(parent, 1);
      if (!override) return null;
      return {
        ...override,
        metadata: {
          ...override.metadata,
          juiceDollarBridge: {
            chain: "citrea",
            bridge: route.bridge,
            quoteToken: route.quoteToken,
            quoteParentId: route.parentId,
            blockNumber: bridgeState.blockNumber,
            redeemableJusd: bridgeState.redeemableJusd,
            simulatedJusd: 1,
          },
        },
      };
    }

    return null;
  },
};
