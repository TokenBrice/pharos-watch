/**
 * The single reserve-adapter test harness.
 *
 * Adapters reach the network through exactly one boundary — `globalThis.fetch`,
 * below `request.ts`, `onchain.ts`, `evm-observation-plan.ts` and `lib/evm-rpc`
 * — and resolve chain endpoints from `ctx.chainRpcs`. `installAdapterNetwork`
 * therefore installs a routing table at that boundary instead of stubbing any
 * intermediate module, so a migrated test exercises the real URL building,
 * headers, retry policy, body limits, JSON/HTML parsing, Multicall3 encoding
 * and ABI decoding an adapter runs in production.
 *
 * `runAdapter` resolves the adapter's registered fetcher plus the coin's real
 * catalog config, so a mis-wired URL or a renamed param fails the test instead
 * of being papered over by a hand-written config literal.
 */
import { expect, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, parseAbi, toFunctionSelector } from "viem/utils";
import { mockFetch, type MockFetchSpy } from "@shared/test-utils/mock-fetch";
import { TRACKED_SOURCE_COINS } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types/core";
import type {
  LiveReserveAdapterKey,
  LiveReservesConfig,
  LiveReserveWarning,
} from "@shared/types/live-reserves";
import { buildChainRpcs, type ChainRpcConfig } from "../../../lib/chain-registry";
import { MULTICALL3_ADDRESS } from "../../../lib/evm-rpc";
import { getReserveAdapter } from "../index";
import type { AdapterContext, AdapterResult } from "../types";
import {
  validateAdapterOutput,
  type ValidationInput,
  type ValidationOptions,
  type ValidationResult,
} from "../validate";

export function mockedReserveHelper<T extends (...args: never[]) => unknown>(helper: T) {
  return vi.mocked(helper);
}

export function expectValidAdapterOutput(
  adapterKey: LiveReserveAdapterKey,
  result: ValidationInput,
  options: Omit<ValidationOptions, "adapter"> = {},
): ValidationResult {
  const report = validateAdapterOutput(result, {
    ...options,
    adapter: getReserveAdapter(adapterKey) ?? undefined,
  });
  expect(report.valid).toBe(true);
  return report;
}

/**
 * Assert the adapter's own warning vocabulary by code. Never assert message
 * wording: copy edits must not fail a suite, and a code plus its effect is the
 * contract consumers (status page, scoring admission) actually read.
 */
export function expectWarnings(
  result: { warnings?: readonly LiveReserveWarning[] },
  codes: readonly string[],
): void {
  const observed = Array.from(new Set((result.warnings ?? []).map((warning) => warning.code))).sort();
  expect(observed).toEqual([...codes].sort());
}

/** Assert one code is present with the given effect, ignoring any others. */
export function expectWarningEffect(
  result: { warnings?: readonly LiveReserveWarning[] },
  code: string,
  effect: LiveReserveWarning["effect"],
): void {
  const warning = (result.warnings ?? []).find((candidate) => candidate.code === code);
  expect(warning?.code).toBe(code);
  expect(warning?.effect).toBe(effect);
}

// ---------------------------------------------------------------------------
// Network table
// ---------------------------------------------------------------------------

export interface AdapterHttpResponse {
  status?: number;
  body?: string;
  json?: unknown;
  headers?: Record<string, string>;
}

type Responder<T> = T | ((request: Request) => T | Promise<T>);

export interface AdapterRpcCall {
  /** Chain id when the RPC URL belongs to the chain registry. */
  chain?: string;
  url: string;
  method: string;
  contract: string;
  /** First four calldata bytes. */
  selector: string;
  data: string;
  block: string;
  viaMulticall: boolean;
}

type AdapterRpcWord = bigint | number | boolean | string | null;

export type AdapterRpcValue =
  | AdapterRpcWord
  | ((call: AdapterRpcCall) => AdapterRpcWord | Promise<AdapterRpcWord>);

export interface AdapterNetworkSpec {
  /** URL → JSON payload (or a full response envelope / responder). */
  json?: Record<string, Responder<unknown>>;
  /** URL → HTML or plain-text body (or a full response envelope / responder). */
  html?: Record<string, Responder<string | AdapterHttpResponse>>;
  /**
   * `eth_call` answers keyed by selector (`0x18160ddd`), function signature
   * (`totalSupply()`), full calldata, or any of those prefixed with a contract
   * address and/or a chain id in any order, colon-separated — e.g.
   * `"ethereum:0xabc…:balanceOf(address)"`. More specific keys win.
   */
  rpc?: Record<string, AdapterRpcValue>;
  /** `eth_getCode` answers keyed by (optionally chain-prefixed) address. */
  code?: Record<string, string>;
  /** Answers Multicall3 `aggregate3` batches from the `rpc` table (default on). */
  multicall?: boolean;
  /** Anchor returned by eth_blockNumber / eth_getBlockByNumber. */
  block?: { number?: number; timestamp?: number; hash?: string };
  /** Extra or overriding chain endpoints, chain id → RPC URL. */
  chains?: Record<string, string>;
}

export interface AdapterNetworkRequest {
  url: string;
  method: string;
}

export interface AdapterNetwork {
  fetchSpy: MockFetchSpy;
  chainRpcs: Map<string, ChainRpcConfig>;
  /** Every request that reached the boundary, in order. */
  requests: readonly AdapterNetworkRequest[];
  /** Every decoded `eth_call`, including Multicall3 members. */
  rpcCalls: readonly AdapterRpcCall[];
  /** Requests the table did not answer; `runAdapter` fails on a non-empty list. */
  unmatched: readonly string[];
}

const AGGREGATE3_ABI = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])",
]);
const AGGREGATE3_SELECTOR = "0x82ad56cb";
const DEFAULT_BLOCK_NUMBER = 23_000_000;
const DEFAULT_BLOCK_TIMESTAMP = 1_757_000_000;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown[];
}

/**
 * Only EVM JSON-RPC is answered from the `rpc` table. Non-EVM JSON-RPC
 * envelopes (Hive `condenser_api.*`, Solana, Sui) stay ordinary POSTs so the
 * `json` table's responder can inspect the body and answer them.
 */
function isEvmJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as JsonRpcRequest;
  return candidate.jsonrpc === "2.0" && typeof candidate.method === "string" && candidate.method.startsWith("eth_");
}

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "");
}

function uint256Word(value: bigint): string {
  const unsigned = value < 0n ? (1n << 256n) + value : value;
  return `0x${unsigned.toString(16).padStart(64, "0")}`;
}

function encodeRpcWord(value: Exclude<AdapterRpcWord, null>): string {
  if (typeof value === "bigint") return uint256Word(value);
  if (typeof value === "number") return uint256Word(BigInt(value));
  if (typeof value === "boolean") return uint256Word(value ? 1n : 0n);
  if (!value.startsWith("0x")) {
    throw new Error(`installAdapterNetwork: rpc value must be a 0x-prefixed hex string, got "${value}"`);
  }
  const body = value.slice(2);
  // Short hex is an address or a small integer: right-align it in one word.
  // 32-byte and longer values are caller-encoded ABI payloads, used verbatim.
  return body.length < 64 ? `0x${body.toLowerCase().padStart(64, "0")}` : value;
}

/**
 * Parse a routing key into its parts. Segments are self-describing, so callers
 * may write them in any order: `0x…40 hex` is a contract, `0x…8 hex` a
 * selector, longer hex full calldata, `name(args)` a function signature, and
 * anything else a chain id.
 */
interface RpcKeyParts {
  chain?: string;
  contract?: string;
  selector?: string;
  data?: string;
}

function parseRpcKey(key: string): RpcKeyParts {
  const parts: RpcKeyParts = {};
  for (const rawSegment of key.split(":")) {
    const segment = rawSegment.trim();
    if (segment.length === 0) continue;
    if (segment.startsWith("0x")) {
      const body = segment.slice(2);
      if (body.length === 40) parts.contract = segment.toLowerCase();
      else if (body.length === 8) parts.selector = segment.toLowerCase();
      else parts.data = segment.toLowerCase();
      continue;
    }
    if (segment.includes("(")) {
      parts.selector = toFunctionSelector(segment).toLowerCase();
      continue;
    }
    parts.chain = segment;
  }
  return parts;
}

interface CompiledRpcEntry {
  parts: RpcKeyParts;
  specificity: number;
  value: AdapterRpcValue;
  key: string;
}

function compileRpcTable(table: Record<string, AdapterRpcValue>): CompiledRpcEntry[] {
  return Object.entries(table)
    .map(([key, value]) => {
      const parts = parseRpcKey(key);
      const specificity =
        (parts.chain ? 1 : 0) + (parts.contract ? 2 : 0) + (parts.data ? 4 : parts.selector ? 1 : 0);
      return { parts, specificity, value, key };
    })
    .sort((left, right) => right.specificity - left.specificity);
}

function matchesRpcEntry(entry: CompiledRpcEntry, call: AdapterRpcCall): boolean {
  const { parts } = entry;
  if (parts.chain && parts.chain !== call.chain) return false;
  if (parts.contract && parts.contract !== call.contract) return false;
  if (parts.data && parts.data !== call.data) return false;
  if (parts.selector && parts.selector !== call.selector) return false;
  return Boolean(parts.selector ?? parts.data ?? parts.contract);
}

function toHttpResponse(value: unknown, defaultContentType: string): Response {
  if (value instanceof Response) return value;
  const envelope = value as AdapterHttpResponse | undefined;
  const isEnvelope =
    typeof envelope === "object" &&
    envelope !== null &&
    !Array.isArray(envelope) &&
    ("status" in envelope || "body" in envelope || "json" in envelope || "headers" in envelope);
  if (isEnvelope) {
    const body = envelope.body ?? (envelope.json === undefined ? "" : JSON.stringify(envelope.json));
    return new Response(body, {
      status: envelope.status ?? 200,
      headers: { "content-type": defaultContentType, ...(envelope.headers ?? {}) },
    });
  }
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return new Response(body, { status: 200, headers: { "content-type": defaultContentType } });
}

/**
 * Install the adapter network boundary for one test.
 *
 * Unanswered requests resolve to HTTP 404 and are recorded: adapters see the
 * upstream failure they would see in production while `runAdapter` reports the
 * exact URL or calldata the table is missing.
 */
export function installAdapterNetwork(spec: AdapterNetworkSpec = {}): AdapterNetwork {
  const chainRpcs = buildChainRpcs();
  for (const [chainId, rpcUrl] of Object.entries(spec.chains ?? {})) {
    const existing = chainRpcs.get(chainId);
    chainRpcs.set(chainId, {
      chainId,
      chainName: existing?.chainName ?? chainId,
      type: existing?.type ?? "evm",
      explorerUrl: existing?.explorerUrl ?? "https://explorer.example",
      ...existing,
      rpcUrl,
    });
  }
  const chainByRpcUrl: Record<string, string> = {};
  for (const config of chainRpcs.values()) {
    chainByRpcUrl[normalizeUrl(config.rpcUrl)] = config.chainId;
    if (config.fallbackRpcUrl) chainByRpcUrl[normalizeUrl(config.fallbackRpcUrl)] = config.chainId;
  }

  const httpTable: Record<string, { responder: Responder<unknown>; contentType: string }> = {};
  for (const [url, responder] of Object.entries(spec.json ?? {})) {
    httpTable[normalizeUrl(url)] = { responder, contentType: "application/json" };
  }
  for (const [url, responder] of Object.entries(spec.html ?? {})) {
    httpTable[normalizeUrl(url)] = { responder, contentType: "text/html; charset=utf-8" };
  }
  const rpcEntries = compileRpcTable(spec.rpc ?? {});
  const codeTable: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.code ?? {})) {
    const parts = parseRpcKey(key);
    codeTable[`${parts.chain ?? ""}|${parts.contract ?? key.toLowerCase()}`] = value;
  }
  const multicallEnabled = spec.multicall !== false;
  const blockNumber = spec.block?.number ?? DEFAULT_BLOCK_NUMBER;
  const blockTimestamp = spec.block?.timestamp ?? DEFAULT_BLOCK_TIMESTAMP;
  const blockHash = spec.block?.hash ?? `0x${blockNumber.toString(16).padStart(64, "0")}`;

  const requests: AdapterNetworkRequest[] = [];
  const rpcCalls: AdapterRpcCall[] = [];
  const unmatched: string[] = [];

  async function resolveCall(call: AdapterRpcCall): Promise<string | null> {
    rpcCalls.push(call);
    const entry = rpcEntries.find((candidate) => matchesRpcEntry(candidate, call));
    if (!entry) {
      unmatched.push(`eth_call ${call.chain ?? call.url} ${call.contract} ${call.data}`);
      return null;
    }
    const raw = typeof entry.value === "function" ? await entry.value(call) : entry.value;
    return raw == null ? null : encodeRpcWord(raw);
  }

  async function handleEthCall(url: string, chain: string | undefined, params: unknown[]): Promise<unknown> {
    const target = params[0] as { to?: string; data?: string } | undefined;
    const block = typeof params[1] === "string" ? params[1] : "latest";
    const contract = (target?.to ?? "").toLowerCase();
    const data = (target?.data ?? "").toLowerCase();
    if (multicallEnabled && contract === MULTICALL3_ADDRESS.toLowerCase() && data.startsWith(AGGREGATE3_SELECTOR)) {
      const decoded = decodeFunctionData({ abi: AGGREGATE3_ABI, data: data as `0x${string}` });
      const calls = decoded.args[0] as readonly { target: string; allowFailure: boolean; callData: string }[];
      const results: [boolean, `0x${string}`][] = [];
      for (const member of calls) {
        const memberData = member.callData.toLowerCase();
        const value = await resolveCall({
          chain,
          url,
          method: "eth_call",
          contract: member.target.toLowerCase(),
          selector: memberData.slice(0, 10),
          data: memberData,
          block,
          viaMulticall: true,
        });
        results.push(value == null ? [false, "0x"] : [true, value as `0x${string}`]);
      }
      return encodeAbiParameters(
        [{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }],
        [results],
      );
    }
    return resolveCall({
      chain,
      url,
      method: "eth_call",
      contract,
      selector: data.slice(0, 10),
      data,
      block,
      viaMulticall: false,
    });
  }

  async function handleJsonRpc(url: string, payload: JsonRpcRequest): Promise<unknown> {
    const chain = chainByRpcUrl[normalizeUrl(url)];
    const params = payload.params ?? [];
    switch (payload.method) {
      case "eth_call":
        return handleEthCall(url, chain, params);
      case "eth_blockNumber":
        return `0x${blockNumber.toString(16)}`;
      case "eth_getBlockByNumber":
      case "eth_getBlockByHash":
        return {
          number: `0x${blockNumber.toString(16)}`,
          timestamp: `0x${blockTimestamp.toString(16)}`,
          hash: blockHash,
          parentHash: `0x${(blockNumber - 1).toString(16).padStart(64, "0")}`,
        };
      case "eth_getCode": {
        const address = String(params[0] ?? "").toLowerCase();
        const code = codeTable[`${chain ?? ""}|${address}`] ?? codeTable[`|${address}`];
        if (code === undefined) {
          unmatched.push(`eth_getCode ${chain ?? url} ${address}`);
          return null;
        }
        return code;
      }
      default:
        unmatched.push(`${payload.method ?? "unknown-rpc"} ${url}`);
        return null;
    }
  }

  const fetchSpy = mockFetch([
    {
      match: () => true,
      respond: async (request: Request): Promise<Response> => {
        const url = normalizeUrl(request.url);
        requests.push({ url: request.url, method: request.method });
        if (request.method === "POST") {
          const raw = await request.clone().text();
          const parsed: unknown = raw.length > 0 ? JSON.parse(raw) : null;
          if (isEvmJsonRpcRequest(parsed)) {
            const result = await handleJsonRpc(request.url, parsed);
            return Response.json(
              result == null
                ? { jsonrpc: "2.0", id: parsed.id ?? 1, error: { code: -32000, message: "no harness answer" } }
                : { jsonrpc: "2.0", id: parsed.id ?? 1, result },
            );
          }
          if (Array.isArray(parsed) && parsed.every(isEvmJsonRpcRequest)) {
            const results = [];
            for (const member of parsed) {
              const result = await handleJsonRpc(request.url, member);
              results.push(
                result == null
                  ? { jsonrpc: "2.0", id: member.id ?? 1, error: { code: -32000, message: "no harness answer" } }
                  : { jsonrpc: "2.0", id: member.id ?? 1, result },
              );
            }
            return Response.json(results);
          }
        }
        const entry = httpTable[url];
        if (!entry) {
          unmatched.push(`${request.method} ${request.url}`);
          return new Response(JSON.stringify({ error: "no harness route" }), { status: 404 });
        }
        const value = typeof entry.responder === "function"
          ? await (entry.responder as (input: Request) => unknown)(request)
          : entry.responder;
        return toHttpResponse(value, entry.contentType);
      },
    },
  ]);

  return { fetchSpy, chainRpcs, requests, rpcCalls, unmatched };
}

// ---------------------------------------------------------------------------
// Adapter runner
// ---------------------------------------------------------------------------

export interface RunAdapterOptions {
  /** Installed for this run when the test has not installed one itself. */
  network?: AdapterNetworkSpec | AdapterNetwork;
  /** Shallow overrides on the coin resolved from the catalog. */
  coin?: Partial<StablecoinMeta>;
  /** Shallow overrides on the coin's real adapter config. */
  config?: Partial<LiveReservesConfig>;
  /** Shallow overrides on the real config's `params`. */
  params?: Record<string, unknown>;
  ctx?: Partial<AdapterContext>;
  nowSec?: number;
  signal?: AbortSignal;
  maxSourceAgeSec?: number;
  /** Skip the automatic output validation (drift tests asserting a throw). */
  validate?: false;
  /** Permit requests the network table does not answer. */
  allowUnmatched?: boolean;
}

export interface AdapterRun {
  result: AdapterResult;
  report: ValidationResult;
  coin: StablecoinMeta;
  config: LiveReservesConfig;
  network: AdapterNetwork;
}

function isInstalledNetwork(value: AdapterNetworkSpec | AdapterNetwork): value is AdapterNetwork {
  return "fetchSpy" in value;
}

/** Every catalog coin bound to the adapter, in catalog order. */
export function adapterCoins(adapterKey: LiveReserveAdapterKey): StablecoinMeta[] {
  return TRACKED_SOURCE_COINS.filter((coin) => coin.liveReservesConfig?.adapter === adapterKey);
}

export function resolveAdapterCoin(
  adapterKey: LiveReserveAdapterKey,
  coinId?: string,
): { coin: StablecoinMeta; config: LiveReservesConfig } {
  const bound = adapterCoins(adapterKey);
  const coin = coinId ? bound.find((candidate) => candidate.id === coinId) : bound[0];
  if (!coin?.liveReservesConfig) {
    throw new Error(
      `runAdapter: ${adapterKey} has no catalog coin ${coinId ? `"${coinId}"` : ""}; bound coins: ${
        bound.map((candidate) => candidate.id).join(", ") || "(none)"
      }`,
    );
  }
  return { coin, config: coin.liveReservesConfig };
}

/**
 * Run a registered adapter end to end against the harness network, using the
 * coin's real catalog config, and validate its output against the adapter's own
 * descriptor policy. A `fatal` validation warning fails the test.
 */
export async function runAdapter(
  adapterKey: LiveReserveAdapterKey,
  coinRef?: string | StablecoinMeta,
  options: RunAdapterOptions = {},
): Promise<AdapterRun> {
  const adapter = getReserveAdapter(adapterKey);
  if (!adapter) throw new Error(`runAdapter: unknown adapter ${adapterKey}`);

  const resolved = typeof coinRef === "object" && coinRef !== null
    ? { coin: coinRef, config: coinRef.liveReservesConfig }
    : resolveAdapterCoin(adapterKey, coinRef);
  if (!resolved.config) throw new Error(`runAdapter: coin ${resolved.coin.id} has no liveReservesConfig`);

  const coin = options.coin ? { ...resolved.coin, ...options.coin } : resolved.coin;
  const config: LiveReservesConfig = {
    ...resolved.config,
    ...options.config,
    ...(options.params
      ? { params: { ...(resolved.config.params ?? {}), ...options.params } as LiveReservesConfig["params"] }
      : {}),
  };

  const network = options.network
    ? (isInstalledNetwork(options.network) ? options.network : installAdapterNetwork(options.network))
    : installAdapterNetwork();

  const signal = options.signal ?? new AbortController().signal;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const ctx: AdapterContext = {
    chainRpcs: network.chainRpcs,
    requestCache: new Map<string, Promise<unknown>>(),
    nowSec,
    abortSignal: signal,
    ...options.ctx,
  };

  let result: AdapterResult;
  try {
    result = await adapter.fetch(coin, config, signal, ctx);
  } catch (error) {
    if (!options.allowUnmatched && network.unmatched.length > 0) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${adapterKey} failed with unanswered requests:\n  ${network.unmatched.join("\n  ")}\nadapter error: ${message}`,
      );
    }
    throw error;
  }
  if (!options.allowUnmatched && network.unmatched.length > 0) {
    throw new Error(
      `${adapterKey} left requests unanswered by the network table:\n  ${network.unmatched.join("\n  ")}`,
    );
  }

  const report = validateAdapterOutput(result, {
    adapter,
    now: nowSec,
    subjectId: coin.id,
    ...(options.maxSourceAgeSec == null ? {} : { maxSourceAgeSec: options.maxSourceAgeSec }),
  });
  if (options.validate !== false) {
    expect(
      report.valid,
      `validateAdapterOutput rejected ${adapterKey}: ${report.warnings
        .filter((warning) => warning.effect === "fatal")
        .map((warning) => `${warning.code} — ${warning.message}`)
        .join("; ")}`,
    ).toBe(true);
  }
  return { result, report, coin, config, network };
}
