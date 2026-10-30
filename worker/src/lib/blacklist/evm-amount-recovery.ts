import { DRPC_NETWORK } from "@shared/lib/drpc";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import { fetchAlchemyLogs, type AlchemyLogEntry } from "../alchemy-logs";
import { decimalNumberFromBigInt } from "../bigint";
import type { ContractEventConfig } from "../blacklist-contracts";
import { getChainRpc, logScanRpcEndpoints, registryRpcEndpoints, type ChainRpcConfig } from "../chain-registry";
import { fetchEvmLogsForTopicWithCompleteness, type EtherscanLogEntry, type RateLimitedFetch } from "../evm-logs";
import { fetchEvmRpcBatch, isHexBytes, parseUint256Hex } from "../evm-rpc";
import { encodeBalanceOfCallData } from "../evm-selectors";
import { fetchEvmTokenBalanceRaw } from "./balance-providers";
import { blacklistRuntimeBudgetReached, blacklistSubrequestBudgetReached, type BlacklistRunBudget } from "./run-budget";
import type { BlacklistRecoveryErrorClass, BlacklistRecoveryProvider } from "./amount-recovery";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
type TransferLog = Pick<EtherscanLogEntry, "address" | "topics" | "data" | "blockNumber" | "transactionHash" | "logIndex">
  & Partial<Pick<AlchemyLogEntry, "removed" | "blockHash">>;

/** Leave a sixth of the run's subrequests for later repair, ledger and summary stages. */
export function evmBracketProofAdmitted(runBudget: BlacklistRunBudget): boolean {
  const { count, limit } = runBudget.subrequestBudget;
  return limit - count >= Math.ceil(limit / 6);
}

export interface EvmBracketRow {
  id: string;
  address: string;
  block_number: number;
  tx_hash: string;
}

function eventLogIndex(row: EvmBracketRow, chainId: string): number | null {
  if (!/^0x[0-9a-f]{64}$/i.test(row.tx_hash)) return null;
  // Matches buildEvmBlacklistRow's canonical identity, including array element suffixes.
  const prefix = `${chainId}-${row.tx_hash.toLowerCase()}-`;
  if (!row.id.startsWith(prefix)) return null;
  const parts = row.id.slice(prefix.length).split("-");
  if (parts.length > 2) return null;
  const [index, suffix = "0"] = parts;
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(index) || !/^(?:0|[1-9][0-9]*)$/.test(suffix)) return null;
  return Number.isSafeInteger(Number(index)) && Number.isSafeInteger(Number(suffix)) ? Number(index) : null;
}

function validTransferLog(value: unknown, row: EvmBracketRow, config: ContractEventConfig): value is TransferLog {
  if (!value || typeof value !== "object") return false;
  const log = value as Record<string, unknown>;
  return typeof log.address === "string" && log.address.toLowerCase() === config.contractAddress.toLowerCase()
    && typeof log.blockNumber === "string" && /^0x[0-9a-f]+$/i.test(log.blockNumber)
    && Number(log.blockNumber) === row.block_number
    && (log.removed === undefined || log.removed === false)
    && typeof log.transactionHash === "string" && /^0x[0-9a-f]{64}$/i.test(log.transactionHash)
    && typeof log.logIndex === "string" && /^0x[0-9a-f]+$/i.test(log.logIndex)
    && Number.isSafeInteger(Number(log.logIndex))
    && Array.isArray(log.topics) && log.topics.length === 3
    && typeof log.topics[0] === "string" && log.topics[0].toLowerCase() === TRANSFER_TOPIC
    && log.topics.slice(1).every((topic: unknown) => typeof topic === "string" && /^0x0{24}[0-9a-f]{40}$/i.test(topic))
    && typeof log.data === "string" && /^0x[0-9a-f]{64}$/i.test(log.data)
    && (log.blockHash == null || (typeof log.blockHash === "string" && /^0x[0-9a-f]{64}$/i.test(log.blockHash)));
}

function validRpcTransferLog(value: unknown, row: EvmBracketRow, config: ContractEventConfig): value is AlchemyLogEntry {
  return validTransferLog(value, row, config) && value.removed === false
    && typeof value.blockHash === "string" && /^0x[0-9a-f]{64}$/i.test(value.blockHash)
    && "transactionIndex" in value && typeof value.transactionIndex === "string"
    && /^0x[0-9a-f]+$/i.test(value.transactionIndex) && Number.isSafeInteger(Number(value.transactionIndex));
}

/** Reconcile the complete block in raw units before attributing its prefix. */
export function reconcileEvmEventBalance(
  row: EvmBracketRow,
  config: ContractEventConfig,
  before: bigint,
  after: bigint,
  logs: readonly TransferLog[],
): bigint | null {
  const targetIndex = eventLogIndex(row, config.chain.chainId);
  if (targetIndex == null || before < 0n || after < 0n) return null;
  const address = row.address.toLowerCase();
  const unique = new Map<string, { index: number; delta: bigint; fingerprint: string }>();
  const positions = new Map<number, string>();
  let blockHash: string | undefined;
  for (const log of logs) {
    if (!validTransferLog(log, row, config)) return null;
    if (log.blockHash != null) {
      const hash = log.blockHash.toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(hash) || (blockHash != null && blockHash !== hash)) return null;
      blockHash = hash;
    }
    const from = `0x${log.topics[1].slice(-40).toLowerCase()}`;
    const to = `0x${log.topics[2].slice(-40).toLowerCase()}`;
    if (from !== address && to !== address) return null;
    const index = Number(log.logIndex);
    if (index === targetIndex) return null;
    const key = `${log.transactionHash.toLowerCase()}:${index}`;
    if (positions.has(index) && positions.get(index) !== key) return null;
    positions.set(index, key);
    const raw = BigInt(log.data);
    const fingerprint = `${from}:${to}:${raw}`;
    const previous = unique.get(key);
    if (previous && previous.fingerprint !== fingerprint) return null;
    unique.set(key, { index, delta: (to === address ? raw : 0n) - (from === address ? raw : 0n), fingerprint });
  }
  let balance = before;
  let atEvent = before;
  for (const log of [...unique.values()].sort((a, b) => a.index - b.index)) {
    balance += log.delta;
    if (balance < 0n) return null;
    if (log.index < targetIndex) atEvent = balance;
  }
  return balance === after ? atEvent : null;
}

export async function recoverEvmBracketAmount(options: {
  row: EvmBracketRow;
  config: ContractEventConfig;
  etherscanApiKey: string | null;
  drpcApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
  etherscanLimiter: RateLimitedFetch;
  runBudget: BlacklistRunBudget;
  signal?: AbortSignal;
  onProviderAttempt?: (provider: BlacklistRecoveryProvider) => void;
}): Promise<{ amount: number | null; lastErrorClass: BlacklistRecoveryErrorClass | null; lastProvider: BlacklistRecoveryProvider }> {
  const { row, config, runBudget, signal } = options;
  let lastProvider: BlacklistRecoveryProvider = "none";
  const failed = (lastErrorClass: BlacklistRecoveryErrorClass) => ({ amount: null, lastErrorClass, lastProvider });
  const budgetError = (): BlacklistRecoveryErrorClass | null => blacklistRuntimeBudgetReached(runBudget)
    ? "runtime_budget" : blacklistSubrequestBudgetReached(runBudget) ? "budget_exhausted" : null;
  const attempted = (provider: BlacklistRecoveryProvider) => {
    lastProvider = provider;
    options.onProviderAttempt?.(provider);
  };
  if (eventLogIndex(row, config.chain.chainId) == null || !Number.isSafeInteger(row.block_number)
    || row.block_number < 1 || !/^0x[0-9a-f]{40}$/i.test(row.address)) return failed("event_time_unreconciled");
  try {
    const rpc = options.chainRpcs && getChainRpc(options.chainRpcs, config.chain.chainId);
    const endpoints = logScanRpcEndpoints(rpc);
    const network = DRPC_NETWORK[config.chain.chainId];
    const drpcUrl = options.drpcApiKey && network
      ? `https://lb.drpc.org/ogrpc?network=${network}&dkey=${options.drpcApiKey}` : null;
    const targets = [
      ...(drpcUrl ? [{ url: drpcUrl, provider: "drpc" as const, endpoint: undefined }] : []),
      ...endpoints.filter((endpoint) => endpoint.url !== drpcUrl).map((endpoint) => ({
        url: endpoint.url, provider: "chain_rpc" as const, endpoint,
      })),
    ];
    const addressTopic = `0x${row.address.slice(2).toLowerCase().padStart(64, "0")}`;
    const balanceUrls = new Set(registryRpcEndpoints(rpc)
      .filter((endpoint) => endpoint.operator !== "dwellir").map((endpoint) => endpoint.url));
    for (const target of targets) {
      // Batch only the intersection of the incumbent balance/log routes; noBatch stays sequential.
      if (target.endpoint && (!balanceUrls.has(target.url) || target.endpoint.noBatch)) continue;
      throwIfAborted(signal);
      const stopped = budgetError();
      if (stopped) return failed(stopped);
      const data = encodeBalanceOfCallData(row.address);
      const blockTag = `0x${row.block_number.toString(16)}`;
      // The caller owns endpoint admission; give the shared transport exactly one target.
      const values = await fetchEvmRpcBatch(undefined, [
        { method: "eth_call", params: [{ to: config.contractAddress, data }, `0x${(row.block_number - 1).toString(16)}`] },
        { method: "eth_call", params: [{ to: config.contractAddress, data }, blockTag] },
        { method: "eth_getLogs", params: [{ address: config.contractAddress, fromBlock: blockTag, toBlock: blockTag,
          topics: [TRANSFER_TOPIC, addressTopic] }] },
        { method: "eth_getLogs", params: [{ address: config.contractAddress, fromBlock: blockTag, toBlock: blockTag,
          topics: [TRANSFER_TOPIC, null, addressTopic] }] },
      ], {
        extraRpcUrls: [target.url], signal, deadlineMs: runBudget.deadlineMs,
        timeoutMs: 10_000, maxRetries: 0, maxResponseBytes: 8 * 1024 * 1024,
        beforeRequest: () => {
          if (budgetError()) return false;
          runBudget.subrequestBudget.count++;
          attempted(target.provider);
          return true;
        },
      });
      throwIfAborted(signal);
      if (!values) continue;
      if (!isHexBytes(values[0]) || !isHexBytes(values[1])) continue;
      const before = parseUint256Hex(values[0]);
      const after = parseUint256Hex(values[1]);
      const outgoing = values[2];
      const incoming = values[3];
      if (before == null || after == null || !Array.isArray(outgoing) || !Array.isArray(incoming)
        || !outgoing.every((log): log is AlchemyLogEntry => validRpcTransferLog(log, row, config)
          && log.topics[1].toLowerCase() === addressTopic)
        || !incoming.every((log): log is AlchemyLogEntry => validRpcTransferLog(log, row, config)
          && log.topics[2].toLowerCase() === addressTopic)) continue;
      const amount = reconcileEvmEventBalance(row, config, before, after, [...outgoing, ...incoming]);
      return amount == null ? failed("event_time_unreconciled")
        : { amount: decimalNumberFromBigInt(amount, config.decimals), lastErrorClass: null, lastProvider };
    }
    const balances: bigint[] = [];
    for (const block of [row.block_number - 1, row.block_number]) {
      throwIfAborted(signal);
      const stopped = budgetError();
      if (stopped) return failed(stopped);
      const balance = await fetchEvmTokenBalanceRaw(config, row.address, block,
        options.etherscanApiKey, options.drpcApiKey ?? null, options.etherscanLimiter,
        runBudget.subrequestBudget, signal, options.chainRpcs,
        { deadlineMs: runBudget.deadlineMs, onProviderAttempt: attempted });
      throwIfAborted(signal);
      if (balance == null) return failed(budgetError() ?? "provider_null");
      balances.push(balance);
    }
    const logs: TransferLog[] = [];
    for (const index of [1, 2] as const) {
      // A provider that ignored the topic filter is a provider fault, not proof evidence.
      const filtered = (entries: readonly TransferLog[]) =>
        entries.every((log) => log.topics[index]?.toLowerCase() === addressTopic);
      let matched: TransferLog[] | null = null;
      for (const target of targets) {
        throwIfAborted(signal);
        const stopped = budgetError();
        if (stopped) return failed(stopped);
        attempted(target.provider);
        const result = await fetchAlchemyLogs(target.url, config.contractAddress,
          [{ index: 0, value: TRANSFER_TOPIC }, { index, value: addressTopic }],
          row.block_number, row.block_number, runBudget.subrequestBudget, signal,
          { deadlineMs: runBudget.deadlineMs, maxSplitCalls: 1, endpoint: target.endpoint });
        if (result?.complete && result.scannedToBlock === row.block_number && filtered(result.logs)) {
          matched = result.logs;
          break;
        }
      }
      if (matched == null && options.etherscanApiKey) {
        throwIfAborted(signal);
        const stopped = budgetError();
        if (stopped) return failed(stopped);
        attempted("etherscan");
        const result = await fetchEvmLogsForTopicWithCompleteness(config.chain.evmChainId!, config.contractAddress,
          TRANSFER_TOPIC, options.etherscanApiKey, row.block_number, row.block_number, 0,
          options.etherscanLimiter, runBudget.subrequestBudget, signal,
          Math.max(1, Math.min(10_000, runBudget.deadlineMs - Date.now())), { index, value: addressTopic },
          runBudget.deadlineMs);
        if (result.complete && result.scannedToBlock === row.block_number && filtered(result.logs)) matched = result.logs;
      }
      throwIfAborted(signal);
      if (matched == null) return failed(budgetError() ?? "provider_null");
      logs.push(...matched);
    }
    const amount = reconcileEvmEventBalance(row, config, balances[0], balances[1], logs);
    return amount == null ? failed("event_time_unreconciled")
      : { amount: decimalNumberFromBigInt(amount, config.decimals), lastErrorClass: null, lastProvider };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return failed(budgetError() ?? "provider_null");
  }
}
