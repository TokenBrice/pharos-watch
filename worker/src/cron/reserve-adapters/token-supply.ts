import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import type { AdapterContext } from "./types";
import { throwIfAborted } from "../../lib/abort";
import { redactProviderUrls } from "../../lib/safe-error-message";
import { toErrorMessage } from "@shared/lib/error-utils";
import { APTOS_PUBLIC_REST_URL, PUBLIC_RPC_URLS } from "@shared/lib/chain-rpc-registry";
import { DWELLIR_NATIVE_ENDPOINTS, type DwellirNativeEndpoint } from "@shared/lib/dwellir-native-endpoints";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { getRpcAuthHeaders, registryRpcUrls } from "../../lib/chain-registry";
import { fetchErc20TotalSupply } from "./onchain";
import { fetchJsonPostWithRetry, fetchJsonWithRetry } from "./request";
import { requireOnchainInput } from "./input-guards";
import { resolveCoinContractAddress } from "./evm";

type EvmInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;
type SolanaInput = Extract<LiveReserveInput, { kind: "onchain-solana" }>;

interface SolanaTokenSupplyResponse {
  result?: {
    value?: {
      amount?: string;
    };
  };
}

const SOLANA_RPC_URLS = [
  "https://api.mainnet-beta.solana.com",
  "https://api.mainnet.solana.com",
  "https://solana-rpc.publicnode.com",
] as const;

const MOVE_CONCURRENT_SUPPLY_TYPE = "0x1::fungible_asset::ConcurrentSupply";
const MOVE_METADATA_TYPE = "0x1::fungible_asset::Metadata";
export { APTOS_PUBLIC_REST_URL };

interface MoveLedgerResponse {
  chain_id?: number;
  ledger_version?: string;
  ledger_timestamp?: string;
  oldest_ledger_version?: string;
}

interface MoveBlockResponse {
  first_version?: string;
  last_version?: string;
  block_timestamp?: string;
}

const MOVE_INTEGER_RE = /^(0|[1-9][0-9]*)$/;

function moveTimestampSec(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) return undefined;
  const seconds = Number(BigInt(value) / 1_000_000n);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

interface MoveResourceResponse {
  type?: string;
  data?: Record<string, unknown>;
}

export interface MoveFungibleAssetSupplyObservation {
  rawSupply: bigint;
  decimals: number;
  ledgerVersion: string;
  /** Ledger timestamp in unix seconds when the node reports one. */
  ledgerTimestampSec?: number;
  /** Present for identity-bound economic reads; legacy supply probes are unchanged. */
  metadataAddress?: string;
  responseSha256?: string;
}

export interface MoveFungibleAssetSupplyReadOptions {
  clockSec: number;
  expectedChainId?: number;
  /** Exact deployed OFT package identity, resolved through its pinned mint/burn refs. */
  identityKind?: "metadata-address" | "oft-package";
  expectedMetadataAddress?: string;
  expectedDecimals?: number;
}

type DwellirMoveEndpoint = Extract<DwellirNativeEndpoint, { protocol: "aptos-rest" }>;

interface MoveReadPin {
  network?: "aptos" | "movement";
  ledgerVersion?: string;
  ledgerTimestampSec?: number;
}

/**
 * Reads an Aptos-framework fungible asset's supply and decimals at one pinned
 * ledger version. Serves every Move chain on the Aptos framework REST API
 * (Aptos mainnet, Movement).
 */
export async function fetchMoveFungibleAssetSupply(
  metadataAddress: string,
  signal: AbortSignal,
  rpcUrl: string,
  ctx?: AdapterContext,
  options?: MoveFungibleAssetSupplyReadOptions,
  network?: "aptos" | "movement",
): Promise<MoveFungibleAssetSupplyObservation | null> {
  if (!ctx?.dwellirNative) {
    return fetchMoveSupplyAtEndpoint(metadataAddress, signal, rpcUrl, ctx, options);
  }
  const knownEndpoint = DWELLIR_NATIVE_ENDPOINTS.find((entry): entry is DwellirMoveEndpoint =>
    entry.protocol === "aptos-rest" && (options?.expectedChainId !== undefined
      ? entry.expectedChainId === options.expectedChainId
      : PUBLIC_RPC_URLS[entry.network] === rpcUrl.replace(/\/$/, "")),
  );
  const pin: MoveReadPin = { network: network ?? knownEndpoint?.network };
  let lastError: unknown;
  const tryIncumbent = async (url: string) => {
    try {
      return await fetchMoveSupplyAtEndpoint(metadataAddress, signal, url, ctx, options, pin);
    } catch (error) {
      throwIfAborted(signal);
      lastError = error;
      return null;
    }
  };
  const primary = await tryIncumbent(rpcUrl);
  if (primary) return primary;
  if (!pin.network) {
    if (lastError) throw lastError;
    return null;
  }
  const defaultUrl = PUBLIC_RPC_URLS[pin.network];
  if (rpcUrl.replace(/\/$/, "") !== defaultUrl) {
    const fallback = await tryIncumbent(defaultUrl);
    if (fallback) return fallback;
  }
  const endpoint = DWELLIR_NATIVE_ENDPOINTS.find((entry): entry is DwellirMoveEndpoint =>
    entry.protocol === "aptos-rest" && entry.network === pin.network,
  )!;
  return fetchMoveSupplyAtEndpoint(metadataAddress, signal, endpoint.baseUrl, ctx, options, pin, endpoint);
}

async function fetchMoveSupplyAtEndpoint(
  metadataAddress: string,
  signal: AbortSignal,
  rpcUrl: string,
  ctx?: AdapterContext,
  options?: MoveFungibleAssetSupplyReadOptions,
  pin?: MoveReadPin,
  nativeEndpoint?: DwellirMoveEndpoint,
): Promise<MoveFungibleAssetSupplyObservation | null> {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(metadataAddress)) return null;
  const baseUrl = rpcUrl.replace(/\/$/, "");
  const bounded = options?.expectedMetadataAddress !== undefined
    ? { maxResponseBytes: 128 * 1024, maxRetries: 0, headers: getRpcAuthHeaders(baseUrl) }
    : undefined;
  const read = <T>(url: string) => nativeEndpoint
    ? ctx!.dwellirNative!.readJson<T>(nativeEndpoint.network, url.slice(baseUrl.length), signal, ctx)
    : fetchJsonWithRetry<T>(url, signal, 10_000, ctx, bounded);
  const ledger = await read<MoveLedgerResponse>(baseUrl);
  if (!ledger.ledger_version || !MOVE_INTEGER_RE.test(ledger.ledger_version)) return null;
  if (options?.expectedChainId !== undefined && ledger.chain_id !== options.expectedChainId) return null;
  if (pin && !pin.network) {
    pin.network = DWELLIR_NATIVE_ENDPOINTS.find((entry): entry is DwellirMoveEndpoint =>
      entry.protocol === "aptos-rest" && entry.expectedChainId === ledger.chain_id,
    )?.network;
  }
  if (nativeEndpoint && ledger.chain_id !== nativeEndpoint.expectedChainId) return null;
  const oldest = nativeEndpoint?.requiresRetainedLedgerFloor ? ledger.oldest_ledger_version : "0";
  if (oldest === undefined || !MOVE_INTEGER_RE.test(oldest)) return null;
  let ledgerVersion = pin?.ledgerVersion ?? ledger.ledger_version;
  let ledgerTimestampSec = pin?.ledgerVersion ? pin.ledgerTimestampSec : moveTimestampSec(ledger.ledger_timestamp);
  if (BigInt(ledgerVersion) < BigInt(oldest) || BigInt(ledgerVersion) > BigInt(ledger.ledger_version)) return null;
  if (options && !pin?.ledgerVersion) {
    if (!Number.isSafeInteger(options.clockSec) || options.clockSec <= 0 || ledgerTimestampSec === undefined) return null;
    if (ledgerTimestampSec > options.clockSec) {
      // Locate the newest complete block at/before the scoring clock. Never
      // attach an old clock to the latest supply, or read partial block state.
      let low = BigInt(oldest);
      let high = BigInt(ledgerVersion);
      let historicalVersion: string | null = null;
      let historicalTimestamp: number | undefined;
      let bracketed = false;
      let offset = 0n;
      for (let probe = 0; low <= high && probe < 64; probe += 1) {
        throwIfAborted(signal);
        // Near-clock captures need near-head state, not a pruned half-chain
        // probe. Walk back exponentially before bisecting the retained bracket.
        const middle = bracketed ? (low + high) / 2n
          : BigInt(ledgerVersion) > offset ? BigInt(ledgerVersion) - offset : 0n;
        if (middle < BigInt(oldest)) return null;
        const block = await read<MoveBlockResponse>(
          `${baseUrl}/blocks/by_version/${middle}?with_transactions=false`,
        );
        const timestamp = moveTimestampSec(block.block_timestamp);
        if (!block.first_version || !block.last_version || !MOVE_INTEGER_RE.test(block.first_version) ||
            !MOVE_INTEGER_RE.test(block.last_version) || timestamp === undefined) return null;
        const first = BigInt(block.first_version);
        const last = BigInt(block.last_version);
        if (first > middle || last < middle || last > BigInt(ledger.ledger_version)) return null;
        if (timestamp <= options.clockSec) {
          historicalVersion = block.last_version;
          historicalTimestamp = timestamp;
          low = last + 1n;
          bracketed = true;
        } else {
          high = first - 1n;
          const nextOffset = offset === 0n ? 1n : offset * 2n;
          offset = nextOffset > BigInt(ledgerVersion) - high ? nextOffset : BigInt(ledgerVersion) - high;
        }
      }
      if (low <= high || historicalVersion === null || historicalTimestamp === undefined) return null;
      ledgerVersion = historicalVersion;
      ledgerTimestampSec = historicalTimestamp;
    }
  }
  if (pin && !pin.ledgerVersion) {
    pin.ledgerVersion = ledgerVersion;
    pin.ledgerTimestampSec = ledgerTimestampSec;
  }
  if (options?.identityKind === "oft-package") {
    const packageType = `${metadataAddress}::oft_fa::OftImpl`;
    const oft = await read<MoveResourceResponse>(
      `${baseUrl}/accounts/${metadataAddress}/resource/${packageType}?ledger_version=${ledgerVersion}`,
    );
    if (oft.type !== packageType) return null;
    const inner = (value: unknown): unknown =>
      value !== null && typeof value === "object" && "inner" in value ? value.inner : null;
    const metadata = inner(oft.data?.metadata);
    if (typeof metadata !== "string" || !/^0x[0-9a-f]{64}$/.test(metadata)) return null;
    for (const name of ["mint_ref", "burn_ref", "transfer_ref"]) {
      const ref = oft.data?.[name];
      if (ref === null || typeof ref !== "object" || !("metadata" in ref) ||
          inner(ref.metadata) !== metadata) return null;
    }
    metadataAddress = metadata;
  }
  if (options?.expectedMetadataAddress !== undefined &&
      metadataAddress !== options.expectedMetadataAddress) return null;

  const resourceUrl = (type: string) =>
    `${baseUrl}/accounts/${metadataAddress}/resource/${type}?ledger_version=${ledgerVersion}`;
  const supply = await read<MoveResourceResponse>(resourceUrl(MOVE_CONCURRENT_SUPPLY_TYPE));
  const metadata = await read<MoveResourceResponse>(resourceUrl(MOVE_METADATA_TYPE));
  if (supply.type !== MOVE_CONCURRENT_SUPPLY_TYPE || metadata.type !== MOVE_METADATA_TYPE) return null;

  const current = supply.data?.current;
  const raw = current && typeof current === "object" ? (current as Record<string, unknown>).value : null;
  const decimals = metadata.data?.decimals;
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 30) return null;
  if (options?.expectedDecimals !== undefined && decimals !== options.expectedDecimals) return null;
  let identity: MoveResourceResponse | undefined;
  if (options?.expectedMetadataAddress !== undefined) {
    identity = await read<MoveResourceResponse>(resourceUrl("0x1::object::ObjectCore"));
    const events = identity.data?.transfer_events as { guid?: { id?: { addr?: unknown } } } | undefined;
    if (identity.type !== "0x1::object::ObjectCore" || events?.guid?.id?.addr !== metadataAddress) return null;
  }

  return {
    rawSupply: BigInt(raw),
    decimals: decimals as number,
    ledgerVersion,
    ...(ledgerTimestampSec !== undefined ? { ledgerTimestampSec } : {}),
    ...(identity ? { metadataAddress, responseSha256: sha256Hex(stableJsonStringifyV1({
      ledgerVersion, ledgerTimestampSec, metadataAddress, supply, metadata, identity,
    })) } : {}),
  };
}

interface TonBlockId {
  workchain: number;
  shard: string;
  seqno: number;
  root_hash: string;
  file_hash: string;
}
interface TonEnvelope<T> { ok?: boolean; result?: T }
interface TonHeader { id?: TonBlockId; gen_utime?: number; global_id?: number }
interface TonGetter { exit_code?: number; stack?: unknown[]; block_id?: TonBlockId }
interface TonTokenData {
  address?: string;
  contract_type?: string;
  total_supply?: string;
  jetton_content?: { type?: string; data?: { decimals?: unknown } };
}

export interface TonJettonSupplyObservation {
  rawSupply: bigint;
  decimals: number;
  masterchainSeqno: number;
  blockHash: string;
  blockTimestampSec: number;
  responseSha256: string;
}

function isTonMasterchainBlock(value: TonBlockId | undefined): value is TonBlockId {
  return value !== undefined && value.workchain === -1 && value.shard === "-9223372036854775808" &&
    Number.isSafeInteger(value.seqno) && value.seqno > 0 &&
    /^[A-Za-z0-9+/]{43}=$/.test(value.root_hash) && /^[A-Za-z0-9+/]{43}=$/.test(value.file_hash);
}
function sameTonBlock(a: TonBlockId | undefined, b: TonBlockId): boolean {
  return isTonMasterchainBlock(a) && a.seqno === b.seqno &&
    a.root_hash === b.root_hash && a.file_hash === b.file_hash;
}

/**
 * TON Center v2 executes get_jetton_data at an explicit masterchain seqno.
 * Its echoed full block id and independently fetched block header certify the
 * supply clock. On-chain metadata decimals are read at that same seqno; no
 * default 9 decimals or unpinned/latest fallback is admitted.
 */
export async function fetchTonJettonSupply(
  masterAddress: string,
  signal: AbortSignal,
  rpcUrl: string,
  options: { clockSec: number; expectedDecimals: number },
  ctx?: AdapterContext,
): Promise<TonJettonSupplyObservation | null> {
  if (!/^(?:-?[0-9]+:[0-9a-f]{64}|[EU]Q[A-Za-z0-9_-]{46})$/.test(masterAddress) ||
      !Number.isSafeInteger(options.clockSec) || options.clockSec <= 0 ||
      !Number.isInteger(options.expectedDecimals) || options.expectedDecimals < 0 || options.expectedDecimals > 36) return null;
  const base = rpcUrl.replace(/\/$/, "");
  const bounded = { maxResponseBytes: 128 * 1024, headers: getRpcAuthHeaders(base) };
  const head = await fetchJsonWithRetry<TonEnvelope<{ last?: TonBlockId }>>(
    `${base}/getMasterchainInfo`, signal, 10_000, ctx, bounded,
  );
  if (head.ok !== true || !isTonMasterchainBlock(head.result?.last)) return null;
  let pin = head.result.last;
  const headerAt = async (block: TonBlockId) => fetchJsonWithRetry<TonEnvelope<TonHeader>>(
    `${base}/getBlockHeader?${new URLSearchParams({
      workchain: "-1", shard: block.shard, seqno: String(block.seqno),
      root_hash: block.root_hash, file_hash: block.file_hash,
    })}`, signal, 10_000, ctx, bounded,
  );
  let header = await headerAt(pin);
  if (header.ok === true && sameTonBlock(header.result?.id, pin) &&
      Number.isSafeInteger(header.result?.gen_utime) && header.result!.gen_utime! > options.clockSec) {
    const lookup = await fetchJsonWithRetry<TonEnvelope<TonBlockId>>(
      `${base}/lookupBlock?workchain=-1&shard=-9223372036854775808&unixtime=${options.clockSec}`,
      signal, 10_000, ctx, bounded,
    );
    if (lookup.ok !== true || !isTonMasterchainBlock(lookup.result) || lookup.result.seqno > pin.seqno) return null;
    pin = lookup.result;
    header = await headerAt(pin);
  }
  // lookupBlock by time may return the first block after the requested second.
  // One predecessor is enough to bracket it; otherwise reject, never redating.
  if (header.ok === true && sameTonBlock(header.result?.id, pin) &&
      Number.isSafeInteger(header.result?.gen_utime) && header.result!.gen_utime! > options.clockSec) {
    const previous = await fetchJsonWithRetry<TonEnvelope<TonBlockId>>(
      `${base}/lookupBlock?workchain=-1&shard=${pin.shard}&seqno=${pin.seqno - 1}`,
      signal, 10_000, ctx, bounded,
    );
    if (previous.ok !== true || !isTonMasterchainBlock(previous.result) || previous.result.seqno !== pin.seqno - 1) return null;
    pin = previous.result;
    header = await headerAt(pin);
  }
  const timestamp = header.result?.gen_utime;
  if (header.ok !== true || !sameTonBlock(header.result?.id, pin) || header.result?.global_id !== -239 ||
      !Number.isSafeInteger(timestamp) || timestamp! <= 0 || timestamp! > options.clockSec) return null;
  const getter = await fetchJsonPostWithRetry<TonEnvelope<TonGetter>>(
    `${base}/runGetMethod`, { address: masterAddress, method: "get_jetton_data", stack: [], seqno: pin.seqno },
    signal, 10_000, ctx, bounded,
  );
  const entry = getter.result?.stack?.[0];
  if (getter.ok !== true || getter.result?.exit_code !== 0 || !sameTonBlock(getter.result?.block_id, pin) ||
      !Array.isArray(entry) || entry.length !== 2 || entry[0] !== "num" ||
      typeof entry[1] !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(entry[1])) return null;
  const rawSupply = BigInt(entry[1]);
  const token = await fetchJsonPostWithRetry<TonEnvelope<TonTokenData>>(
    `${base}/getTokenData`, { address: masterAddress, seqno: pin.seqno },
    signal, 10_000, ctx, bounded,
  );
  const decimals = token.result?.jetton_content?.data?.decimals;
  if (token.ok !== true || token.result?.address !== masterAddress || token.result.contract_type !== "jetton_master" ||
      typeof token.result.total_supply !== "string" || !MOVE_INTEGER_RE.test(token.result.total_supply) ||
      BigInt(token.result.total_supply) !== rawSupply || token.result.jetton_content?.type !== "onchain" ||
      typeof decimals !== "string" || !MOVE_INTEGER_RE.test(decimals) ||
      Number(decimals) !== options.expectedDecimals) return null;
  const rechecked = await headerAt(pin);
  if (rechecked.ok !== true || rechecked.result === undefined || !sameTonBlock(rechecked.result.id, pin) ||
      rechecked.result.gen_utime !== timestamp || rechecked.result.global_id !== -239) return null;
  return { rawSupply, decimals: options.expectedDecimals, masterchainSeqno: pin.seqno,
    blockHash: pin.root_hash, blockTimestampSec: timestamp!,
    responseSha256: sha256Hex(stableJsonStringifyV1({ pin, header, getter, token, rechecked })) };
}

const SPL_TOKEN_PROGRAM_IDS: Readonly<Record<string, true>> = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: true,
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: true,
};

interface SolanaMintAccountResponse {
  result?: {
    context?: { slot?: number };
    value?: {
      owner?: string;
      data?: { parsed?: { type?: string; info?: { supply?: unknown; decimals?: unknown } } };
    } | null;
  };
}

export interface SolanaMintSupplyObservation {
  rawSupply: bigint;
  decimals: number;
  slot: number;
}

/**
 * SPL mint supply and decimals from one `getAccountInfo` (jsonParsed) read of
 * the mint account. Unlike `getTokenSupply`, keyless public endpoints serve
 * this method, and the parsed account proves the address is an SPL mint owned
 * by a token program. Returns null when no endpoint yields a well-formed mint.
 */
export async function fetchSolanaMintSupply(
  mintAddress: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<SolanaMintSupplyObservation | null> {
  let lastError: unknown = null;
  const rpcUrls = [...new Set([
    ...registryRpcUrls(ctx?.chainRpcs?.get("solana")),
    ...SOLANA_RPC_URLS,
  ])];

  for (const rpcUrl of rpcUrls) {
    throwIfAborted(signal);
    try {
      const body = await fetchJsonPostWithRetry<SolanaMintAccountResponse>(
        rpcUrl,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [mintAddress, { encoding: "jsonParsed", commitment: "finalized" }],
        },
        signal,
        10_000,
        ctx,
        { headers: getRpcAuthHeaders(rpcUrl) },
      );
      const value = body.result?.value;
      const slot = body.result?.context?.slot;
      const parsed = value?.data?.parsed;
      const supply = parsed?.info?.supply;
      const decimals = parsed?.info?.decimals;
      if (
        !value?.owner || SPL_TOKEN_PROGRAM_IDS[value.owner] !== true || parsed?.type !== "mint"
        || typeof supply !== "string" || !/^(0|[1-9][0-9]*)$/.test(supply)
        || !Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 30
        || !Number.isSafeInteger(slot) || (slot as number) <= 0
      ) {
        continue;
      }
      return { rawSupply: BigInt(supply), decimals: decimals as number, slot: slot as number };
    } catch (error) {
      lastError = new Error(redactProviderUrls(toErrorMessage(error)));
    }
  }

  if (lastError) throw lastError;
  return null;
}

function isOnchainEvmInput(input: LiveReserveInput): input is EvmInput {
  return input.kind === "onchain-evm";
}

function isOnchainSolanaInput(input: LiveReserveInput): input is SolanaInput {
  return input.kind === "onchain-solana";
}

/**
 * Raw SPL mint supply in base units, or null when no endpoint answers.
 *
 * `probeTrackedTokenSupply()` treats a zero read as an adapter failure, which is
 * right for reserve adapters but wrong for curated aggregate legs that opt into
 * `allowZeroSupply`. Those callers read the mint through this reader directly,
 * mirroring how the EVM branch bypasses the probe with `fetchErc20TotalSupply`.
 */
export async function fetchSolanaTokenSupply(
  mintAddress: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<bigint | null> {
  let lastError: unknown = null;
  const configuredRpc = ctx?.chainRpcs?.get("solana");
  const rpcUrls = [...new Set([
    ...registryRpcUrls(configuredRpc),
    rpcUrl,
    fallbackRpcUrl,
    ...SOLANA_RPC_URLS,
  ].filter((url): url is string => typeof url === "string" && url.length > 0))];

  for (const rpcUrl of rpcUrls) {
    throwIfAborted(signal);
    try {
      const body = await fetchJsonPostWithRetry<SolanaTokenSupplyResponse>(
        rpcUrl,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenSupply",
          params: [mintAddress],
        },
        signal,
        10_000,
        ctx,
        { headers: getRpcAuthHeaders(rpcUrl) },
      );

      const amount = body.result?.value?.amount;
      if (typeof amount !== "string" || amount.length === 0) {
        continue;
      }

      try {
        return BigInt(amount);
      } catch {
        continue;
      }
    } catch (error) {
      lastError = new Error(redactProviderUrls(toErrorMessage(error)));
      continue;
    }
  }

  if (lastError) throw lastError;
  return null;
}

/**
 * Resolves contract address for a coin on a given chain, fetches ERC-20 totalSupply,
 * and validates it is non-zero. Throws with descriptive error on any failure.
 */
export async function probeOnchainTotalSupply(
  coin: ReserveAdapterCoin,
  input: LiveReserveInput,
  signal: AbortSignal,
  adapterName: string,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<bigint> {
  const onchain = requireOnchainInput(input, adapterName);
  const contract = resolveCoinContractAddress(coin, onchain.chain);
  if (!contract) {
    throw new Error(`${adapterName} could not find a ${onchain.chain} contract for ${coin.id}`);
  }
  const supply = await fetchErc20TotalSupply(onchain, contract, signal, ctx, rpcUrl, fallbackRpcUrl);
  if (supply == null || supply <= 0n) {
    throw new Error(`${adapterName} totalSupply probe failed for ${coin.id}`);
  }
  return supply;
}

/**
 * Resolves contract/mint metadata for a coin on a supported onchain input and
 * validates that the published token supply is non-zero.
 */
export async function probeTrackedTokenSupply(
  coin: ReserveAdapterCoin,
  input: LiveReserveInput,
  signal: AbortSignal,
  adapterName: string,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<bigint> {
  if (isOnchainEvmInput(input)) {
    return probeOnchainTotalSupply(
      coin,
      input,
      signal,
      adapterName,
      ctx,
      rpcUrl,
      fallbackRpcUrl,
    );
  }

  if (!isOnchainSolanaInput(input)) {
    throw new Error(`${adapterName} adapter requires a supported onchain primary input`);
  }

  const mintAddress = coin.contracts?.find((contract) => contract.chain === "solana")?.address;
  if (!mintAddress) {
    throw new Error(`${adapterName} could not find a solana contract for ${coin.id}`);
  }

  const supply = await fetchSolanaTokenSupply(mintAddress, signal, ctx, rpcUrl, fallbackRpcUrl);
  if (supply == null || supply <= 0n) {
    throw new Error(`${adapterName} totalSupply probe failed for ${coin.id}`);
  }
  return supply;
}
