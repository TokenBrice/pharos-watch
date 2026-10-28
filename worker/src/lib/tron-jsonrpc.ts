import { canonicalTronAddress } from "@shared/lib/tron-address";
import {
  isTronJsonRpcRead, tronRpcQuantity, tronRpcResponseByteLimit, TRON_RPC_MAX_BLOCK_SPAN,
  TRON_SOLID_HEAD_MAX_AGE_MS, TRON_SOLID_HEAD_MAX_FUTURE_MS,
} from "@shared/lib/tron-jsonrpc";
import { fetchJsonPostWithRetry } from "../cron/reserve-adapters/request";
import type { DwellirNativeCapability } from "./dwellir-native";
import type { RateLimitedFetch, SubrequestBudget } from "./evm-logs";
import { isResponseBodyTooLargeError } from "./response-body";
import { throwIfAborted } from "./abort";

export interface TronRpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
}

export interface TronRpcBlock { number: number; hash: string; timestamp: number }

export class TronRpcError extends Error {
  constructor(readonly reason: string, readonly splittable = false) { super(reason); }
}

const hex = (number: number) => `0x${number.toString(16)}`;
const hash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value);

function solidHeadFreshnessReason(timestampMs: number): string | null {
  const ageMs = Date.now() - timestampMs;
  if (ageMs > TRON_SOLID_HEAD_MAX_AGE_MS) return "tron-rpc-stale-solid-head";
  if (ageMs < -TRON_SOLID_HEAD_MAX_FUTURE_MS) return "tron-rpc-future-solid-head";
  return null;
}

function isLogRangeOrSizeError(message: string): boolean {
  // JSON-RPC -32005 also covers rate limits; only explicit range/result limits can split.
  if (/rate[ -]?limit|too many requests|requests? (?:per |limit|quota)/i.test(message)) return false;
  return /(?:block )?range\b.*(?:too (?:large|wide)|exceed|limit|maximum)|(?:maximum|max|allowed) block range|too many (?:logs|results)|(?:log|result|response|payload)s? (?:size |count )?(?:is )?(?:too large|exceed|limit)|query returned more than \d+ (?:logs|results)/i.test(message);
}

/** One invocation-local reader; all physical attempts share the caller's deadline and budget. */
export class TronJsonRpcReader {
  private shared = {
    calls: { dwellir: 0, trongrid: 0 }, successfulCalls: { dwellir: 0, trongrid: 0 },
    failures: [] as string[], dwellirFailed: false, trongridHead: null as number | null,
  };
  get calls() { return this.shared.calls; }
  get successfulCalls() { return this.shared.successfulCalls; }
  get failures() { return this.shared.failures; }
  private id = 0;
  private blocks = new Map<number, TronRpcBlock>();
  private solidHead: TronRpcBlock | null = null;
  constructor(private readonly options: {
    dwellirNative?: DwellirNativeCapability;
    trongridApiKey?: string | null;
    trongridAllowed?: boolean;
    budget: SubrequestBudget;
    deadlineMs: number;
    rateLimit: RateLimitedFetch;
    signal: AbortSignal;
  }) {}

  setTronGridAllowed(allowed: boolean): void { this.options.trongridAllowed = allowed; }

  private async read<T>(path: string, body: unknown, decode: (value: unknown) => T): Promise<T> {
    const { options } = this;
    if (path === "/jsonrpc" && !isTronJsonRpcRead(body)) throw new TronRpcError("tron-rpc-invalid-request");
    const providers = [
      ...(options.dwellirNative && options.dwellirNative.isNetworkEnabled?.("tron") !== false
        && !this.shared.dwellirFailed ? ["dwellir" as const] : []),
      ...(options.trongridAllowed !== false ? ["trongrid" as const] : []),
    ];
    for (const provider of providers) {
      try {
        if (provider === "trongrid" && record(body) && body.method === "eth_getLogs"
          && Array.isArray(body.params) && record(body.params[0])) {
          // A fallback's empty response proves coverage only below its own observed head.
          const head = this.shared.trongridHead ?? await this.rpc("eth_blockNumber", [], (result) => {
            const number = tronRpcQuantity(result);
            if (number == null) throw new TronRpcError("tron-rpc-invalid-head");
            return number;
          });
          if (head < Number(body.params[0].toBlock)) throw new TronRpcError("tron-rpc-fallback-head-behind");
        }
        const decoded = await options.rateLimit(async () => {
          throwIfAborted(options.signal);
          if (options.budget.count >= options.budget.limit || Date.now() >= options.deadlineMs) {
            throw new TronRpcError("tron-rpc-budget-exhausted");
          }
          const timeoutMs = Math.min(10_000, options.deadlineMs - Date.now());
          options.budget.count++;
          this.calls[provider]++;
          const result = provider === "dwellir"
            ? await options.dwellirNative!.readJson<unknown>("tron", path, options.signal, undefined, body, timeoutMs)
            : await fetchJsonPostWithRetry<unknown>(`https://api.trongrid.io${path}`, body, options.signal, timeoutMs,
              undefined, {
                headers: options.trongridApiKey ? { "TRON-PRO-API-KEY": options.trongridApiKey } : {},
                redirect: "manual", maxRetries: 0,
                maxResponseBytes: tronRpcResponseByteLimit(path, body),
              });
          if (path !== "/jsonrpc") return decode(result);
          if (!record(result) || result.jsonrpc !== "2.0" || !record(body) || result.id !== body.id) {
            throw new TronRpcError("tron-rpc-invalid-envelope");
          }
          if ("error" in result) {
            const error = record(result.error) ? result.error : {};
            const message = typeof error.message === "string" ? error.message : "";
            throw new TronRpcError("tron-rpc-provider-error", body.method === "eth_getLogs" && isLogRangeOrSizeError(message));
          }
          if (!("result" in result) || result.result == null) throw new TronRpcError("tron-rpc-missing-result");
          const value = decode(result.result);
          if (provider === "trongrid" && body.method === "eth_blockNumber") {
            this.shared.trongridHead = tronRpcQuantity(result.result);
          }
          return value;
        });
        this.successfulCalls[provider]++;
        return decoded;
      } catch (error) {
        throwIfAborted(options.signal);
        const failure = isResponseBodyTooLargeError(error) ? new TronRpcError("tron-rpc-body-too-large", true) : error;
        if (failure instanceof TronRpcError && failure.splittable) {
          const filter = record(body) && body.method === "eth_getLogs" && Array.isArray(body.params)
            && record(body.params[0]) ? body.params[0] : null;
          if (filter && Number(filter.fromBlock) < Number(filter.toBlock)) throw failure;
          this.failures.push(`${provider}:${failure.reason}`);
          if (provider === providers[providers.length - 1]) throw failure;
          if (provider === "dwellir") this.shared.dwellirFailed = true;
          continue;
        }
        if (failure instanceof TronRpcError && failure.reason === "tron-rpc-budget-exhausted") throw failure;
        this.failures.push(`${provider}:${failure instanceof TronRpcError ? failure.reason : "tron-rpc-transport-error"}`);
        if (provider === "dwellir") this.shared.dwellirFailed = true;
      }
    }
    throw new TronRpcError("tron-rpc-providers-unavailable");
  }

  private rpc<T>(method: string, params: unknown[], decode: (value: unknown) => T): Promise<T> {
    return this.read("/jsonrpc", { jsonrpc: "2.0", id: ++this.id, method, params }, decode);
  }

  async getBlock(number: number): Promise<TronRpcBlock> {
    if (!Number.isSafeInteger(number) || number < 0) throw new TronRpcError("tron-rpc-invalid-block");
    const cached = this.blocks.get(number);
    if (cached) return cached;
    const block = await this.rpc("eth_getBlockByNumber", [hex(number), false], (result) => {
      if (!record(result) || tronRpcQuantity(result.number) !== number || !hash(result.hash)) {
        throw new TronRpcError("tron-rpc-invalid-block");
      }
      const timestamp = tronRpcQuantity(result.timestamp);
      if (timestamp == null) throw new TronRpcError("tron-rpc-invalid-timestamp");
      return { number, hash: result.hash.toLowerCase(), timestamp };
    });
    this.blocks.set(number, block);
    return block;
  }

  async getSolidHead(): Promise<TronRpcBlock> {
    const failureStart = this.failures.length;
    if (this.solidHead) {
      const reason = solidHeadFreshnessReason(this.solidHead.timestamp * 1000);
      if (!reason) return this.solidHead;
      this.failures.push(`cached:${reason}`);
      this.solidHead = null;
    }
    try {
      const solid = await this.read("/walletsolidity/getnowblock", {}, (result) => {
        const raw = record(result) && record(result.block_header) && record(result.block_header.raw_data)
          ? result.block_header.raw_data : null;
        if (!raw || !Number.isSafeInteger(raw.number) || Number(raw.number) < 0
          || !Number.isSafeInteger(raw.timestamp) || Number(raw.timestamp) < 0
          || !record(result) || typeof result.blockID !== "string" || !hash(`0x${result.blockID}`)) {
          throw new TronRpcError("tron-rpc-invalid-solid-head");
        }
        const reason = solidHeadFreshnessReason(Number(raw.timestamp));
        if (reason) throw new TronRpcError(reason);
        return { number: Number(raw.number), hash: `0x${result.blockID.toLowerCase()}`,
          timestamp: Math.floor(Number(raw.timestamp) / 1000) };
      });
      await this.rpc("eth_blockNumber", [], (result) => {
        const number = tronRpcQuantity(result);
        if (number == null || number < solid.number) throw new TronRpcError("tron-rpc-head-mismatch");
        return number;
      });
      const block = await this.getBlock(solid.number);
      if (block.hash !== solid.hash || block.timestamp !== solid.timestamp) {
        throw new TronRpcError("tron-rpc-solid-head-mismatch");
      }
      const reason = solidHeadFreshnessReason(block.timestamp * 1000);
      if (reason) {
        this.failures.push(`validated:${reason}`);
        throw new TronRpcError(reason);
      }
      this.solidHead = block;
      return block;
    } catch (error) {
      throwIfAborted(this.options.signal);
      const freshnessFailure = this.failures.slice(failureStart).find((failure) =>
        failure.endsWith(":tron-rpc-stale-solid-head") || failure.endsWith(":tron-rpc-future-solid-head"));
      if (freshnessFailure) throw new TronRpcError(freshnessFailure.slice(freshnessFailure.indexOf(":") + 1));
      throw error;
    }
  }

  /** The nominal 3-second interval seeds a bracket; observed headers prove the exact result. */
  async findBlockAtTimestamp(timestampMs: number): Promise<number> {
    if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) throw new TronRpcError("tron-rpc-invalid-timestamp");
    const head = await this.getSolidHead();
    if (timestampMs > head.timestamp * 1000) return head.number + 1;
    const estimate = Math.max(0, head.number - Math.ceil((head.timestamp * 1000 - timestampMs) / 3000));
    let low: number;
    let high: number;
    let step = 1;
    if ((await this.getBlock(estimate)).timestamp * 1000 >= timestampMs) {
      high = estimate;
      low = Math.max(0, estimate - step);
      while (low > 0 && (await this.getBlock(low)).timestamp * 1000 >= timestampMs) {
        high = low;
        step *= 2;
        low = Math.max(0, estimate - step);
      }
      if ((await this.getBlock(low)).timestamp * 1000 < timestampMs) low++;
    } else {
      low = estimate + 1;
      high = Math.min(head.number, estimate + step);
      while ((await this.getBlock(high)).timestamp * 1000 < timestampMs) {
        low = high + 1;
        step *= 2;
        high = Math.min(head.number, estimate + step);
      }
    }
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if ((await this.getBlock(mid)).timestamp * 1000 < timestampMs) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private async logs(from: number, to: number, address?: string, topics?: string[]): Promise<TronRpcLog[]> {
    return this.rpc("eth_getLogs", [{ fromBlock: hex(from), toBlock: hex(to),
      ...(address ? { address, topics: [topics] } : {}) }], (result) => {
      if (!Array.isArray(result)) throw new TronRpcError("tron-rpc-invalid-logs");
      const logs: TronRpcLog[] = [];
      const seen = new Set<string>();
      for (const value of result) {
        if (!record(value)) throw new TronRpcError("tron-rpc-invalid-log");
        const blockNumber = tronRpcQuantity(value.blockNumber);
        const transactionIndex = tronRpcQuantity(value.transactionIndex);
        const logIndex = tronRpcQuantity(value.logIndex);
        if (blockNumber == null || blockNumber < from || blockNumber > to || transactionIndex == null || logIndex == null
          || !hash(value.blockHash) || !hash(value.transactionHash) || value.removed !== false
          || typeof value.address !== "string" || !/^0x[0-9a-f]{40}$/i.test(value.address)
          || (address && value.address.toLowerCase() !== address)
          || !Array.isArray(value.topics) || !value.topics.every(hash)
          || (topics && !topics.includes(String(value.topics[0]).toLowerCase()))
          || typeof value.data !== "string" || !/^0x[0-9a-f]*$/i.test(value.data) || value.data.length % 2 !== 0
          || seen.has(`${blockNumber}:${logIndex}`)) throw new TronRpcError("tron-rpc-invalid-log");
        seen.add(`${blockNumber}:${logIndex}`);
        logs.push({ address: value.address.toLowerCase(), topics: value.topics.map((topic: string) => topic.toLowerCase()),
          data: value.data.toLowerCase(), blockNumber, blockHash: value.blockHash.toLowerCase(),
          transactionHash: value.transactionHash.toLowerCase(), transactionIndex, logIndex });
      }
      return logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    });
  }

  async getLogs(addressInput: string, topicsInput: string[], from: number, to: number): Promise<{
    logs: TronRpcLog[]; scannedToBlock: number; complete: boolean; reason: string | null; maxSplitDepth: number;
  }> {
    const address = canonicalTronAddress(addressInput);
    const topics = topicsInput.map((topic) => topic.toLowerCase());
    if (!address || !topics.length || topics.length > 16 || !topics.every(hash)
      || !Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(to) || to < from) {
      throw new TronRpcError("tron-rpc-invalid-filter");
    }
    const head = await this.getSolidHead();
    const end = Math.min(to, head.number);
    const logs: TronRpcLog[] = [];
    let scannedToBlock = Math.min(from - 1, head.number);
    let maxSplitDepth = 0;
    let reason: string | null = from > end ? "tron-rpc-above-solid-head" : null;
    const visit = async (start: number, finish: number, depth: number): Promise<boolean> => {
      maxSplitDepth = Math.max(maxSplitDepth, depth);
      try {
        logs.push(...await this.logs(start, finish, address, topics));
        scannedToBlock = finish;
        return true;
      } catch (error) {
        throwIfAborted(this.options.signal);
        if (error instanceof TronRpcError && error.splittable && start < finish) {
          const mid = Math.floor((start + finish) / 2);
          return await visit(start, mid, depth + 1) && await visit(mid + 1, finish, depth + 1);
        }
        reason = error instanceof TronRpcError ? error.reason : "tron-rpc-read-failed";
        return false;
      }
    };
    for (let start = from; start <= end; start += TRON_RPC_MAX_BLOCK_SPAN) {
      if (!await visit(start, Math.min(end, start + TRON_RPC_MAX_BLOCK_SPAN - 1), 0)) break;
    }
    return { logs, scannedToBlock, complete: scannedToBlock >= end && from <= end, reason, maxSplitDepth };
  }

  /** Full block context proves the transaction-local index used by existing freeze IDs. */
  async getTransactionLogIndices(blockNumber: number, selected: TronRpcLog[] = []): Promise<Map<number, number>> {
    if (blockNumber > (await this.getSolidHead()).number) throw new TronRpcError("tron-rpc-above-solid-head");
    const block = await this.getBlock(blockNumber);
    const logs = await this.logs(blockNumber, blockNumber);
    for (const target of selected) {
      const context = logs[target.logIndex];
      if (!context || JSON.stringify(context) !== JSON.stringify(target)) {
        throw new TronRpcError("tron-rpc-block-context-mismatch");
      }
    }
    const positions = new Map<number, number>();
    const seenTransactions = new Set<string>();
    let previousTx = -1;
    let previousHash = "";
    let localIndex = 0;
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      if (log.logIndex !== i || log.blockHash !== block.hash || log.transactionIndex < previousTx
        || (log.transactionIndex === previousTx && log.transactionHash !== previousHash)
        || (log.transactionIndex !== previousTx && seenTransactions.has(log.transactionHash))) {
        throw new TronRpcError("tron-rpc-incomplete-block-context");
      }
      localIndex = log.transactionIndex === previousTx ? localIndex + 1 : 0;
      positions.set(log.logIndex, localIndex);
      seenTransactions.add(log.transactionHash);
      previousTx = log.transactionIndex;
      previousHash = log.transactionHash;
    }
    return positions;
  }
}
