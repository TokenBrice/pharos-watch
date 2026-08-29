import { canonicalEvmAddress } from "@shared/lib/evm-address";
import type { MeasurementCall, MeasurementLog, MeasurementLogQuery } from "./schema";

export interface PinnedBlock {
  number: number;
  hash: string;
  timestampUnix: number;
  timestampIso: string;
  selection: "finalized" | "latest-minus-10" | "operator-pinned";
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

async function rpcRequest(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const json = (await response.json()) as JsonRpcResponse;
  if (json.error) throw new Error(`${method} failed: ${json.error.message ?? JSON.stringify(json.error)}`);
  if (json.result === undefined) throw new Error(`${method} returned no result`);
  return json.result;
}

export function encodeWord(value: bigint): string {
  if (value < 0n) throw new Error("Cannot encode a negative word");
  return value.toString(16).padStart(64, "0");
}

/** Decode one 32-byte return word as an unsigned bigint; fail closed on any other shape. */
export function decodeUintWord(returnData: string, wordIndex = 0, callName = "call"): bigint {
  const body = returnData.replace(/^0x/, "");
  if (body.length < (wordIndex + 1) * 64) {
    throw new Error(`${callName}: return data too short for word ${wordIndex} (${returnData.length} chars)`);
  }
  return BigInt(`0x${body.slice(wordIndex * 64, (wordIndex + 1) * 64)}`);
}

/** Decode a right-padded 32-byte word holding an address. */
export function decodeAddressWord(returnData: string, callName = "call"): string {
  const word = decodeUintWord(returnData, 0, callName);
  return `0x${word.toString(16).padStart(40, "0")}`;
}

export function decodeBoolWord(returnData: string, wordIndex = 0, callName = "call"): boolean {
  const word = decodeUintWord(returnData, wordIndex, callName);
  if (word !== 0n && word !== 1n) throw new Error(`${callName}: expected boolean word, received ${word}`);
  return word === 1n;
}

export function normalizeAddress(address: string, callName = "address"): string {
  const normalized = canonicalEvmAddress(address, { allowZero: false });
  if (!normalized) {
    throw new Error(`${callName}: invalid or zero address ${address}`);
  }
  return normalized;
}

export interface EthCallSpec {
  name: string;
  to: string;
  signature: string;
  selector: string;
  args?: readonly bigint[];
}

export interface LogQuerySpec {
  name: string;
  address: string;
  fromBlock: number;
  toBlock: number;
  topics: readonly string[];
}

const WAD = 10n ** 18n;

/** Format a WAD-scaled bigint as a decimal number rounded to three places (overlay convention). */
export function wadToRounded(value: bigint): number {
  return Number((value * 1000n) / WAD) / 1000;
}

/** Convert a non-negative rational to a bounded decimal only at display time. */
export function ratioToRounded(numerator: bigint, denominator: bigint, decimals = 6): number {
  if (numerator < 0n || denominator <= 0n) throw new Error("Cannot format an invalid ratio");
  const scale = 10n ** BigInt(decimals);
  return Number((numerator * scale) / denominator) / Number(scale);
}

export function relativeDeltaPct(measured: bigint, reference: bigint): number {
  if (reference === 0n) return Number.POSITIVE_INFINITY;
  return Number(((measured - reference) * 1_000_000n) / reference) / 10_000;
}

export interface MeasurementCheck {
  id: string;
  status: "pass";
  detail: string;
}

/** Record a passing check, or abort the whole measurement — a failed check never writes evidence. */
export function requireCheck(checks: MeasurementCheck[], id: string, condition: boolean, detail: string): void {
  if (!condition) throw new Error(`Check failed: ${id} — ${detail}`);
  checks.push({ id, status: "pass", detail });
}

/** Journaling eth_call transport contract; tests substitute a recorded-returndata stub. */
export interface EthCallJournal {
  readonly calls: MeasurementCall[];
  readonly logQueries: MeasurementLogQuery[];
  call(spec: EthCallSpec): Promise<string>;
  recordDecoded(decoded: string): void;
  queryLogs(spec: LogQuerySpec): Promise<readonly MeasurementLog[]>;
  recordLogsDecoded(decoded: string): void;
}

/**
 * eth_call transport that journals every call (input and output bytes plus a
 * human-readable decode) so the evidence file is byte-replayable. All calls
 * run against one pinned block on one RPC endpoint; any failure throws and
 * the whole measurement aborts — never a partial or mixed-source file.
 */
export class JournaledEthCaller implements EthCallJournal {
  readonly calls: MeasurementCall[] = [];
  readonly logQueries: MeasurementLogQuery[] = [];

  constructor(
    private readonly rpcUrl: string,
    private readonly blockTag: string,
  ) {}

  async call(spec: EthCallSpec): Promise<string> {
    const callData = `${spec.selector}${(spec.args ?? []).map(encodeWord).join("")}`;
    const returnData = (await rpcRequest(this.rpcUrl, "eth_call", [
      { to: spec.to, data: callData },
      this.blockTag,
    ])) as string;
    if (typeof returnData !== "string" || !returnData.startsWith("0x") || returnData.length < 4) {
      throw new Error(`${spec.name}: malformed return data`);
    }
    this.calls.push({
      name: spec.name,
      to: spec.to.toLowerCase(),
      signature: spec.signature,
      selector: spec.selector,
      callData,
      returnData: returnData.toLowerCase(),
      decoded: "", // set by recordDecoded after the caller interprets the bytes
    });
    return returnData.toLowerCase();
  }

  /** Attach the human-readable decode to the most recent journaled call. */
  recordDecoded(decoded: string): void {
    const last = this.calls[this.calls.length - 1];
    if (!last) throw new Error("recordDecoded called before any call");
    last.decoded = decoded;
  }

  async queryLogs(spec: LogQuerySpec): Promise<readonly MeasurementLog[]> {
    if (spec.fromBlock < 0 || spec.toBlock < spec.fromBlock) throw new Error(`${spec.name}: invalid log range`);
    const address = normalizeAddress(spec.address, `${spec.name} address`);
    const topics = spec.topics.map((topic) => topic.toLowerCase());
    if (topics.some((topic) => !/^0x[0-9a-f]{64}$/.test(topic))) {
      throw new Error(`${spec.name}: malformed log topic`);
    }
    const raw = await rpcRequest(this.rpcUrl, "eth_getLogs", [
      {
        address,
        fromBlock: `0x${spec.fromBlock.toString(16)}`,
        toBlock: `0x${spec.toBlock.toString(16)}`,
        topics,
      },
    ]);
    if (!Array.isArray(raw)) throw new Error(`${spec.name}: malformed eth_getLogs result`);
    const logs = raw.map((entry, index): MeasurementLog => {
      if (!entry || typeof entry !== "object") throw new Error(`${spec.name}: malformed log ${index}`);
      const log = entry as Record<string, unknown>;
      const normalized = {
        address: String(log.address).toLowerCase(),
        blockHash: String(log.blockHash).toLowerCase(),
        blockNumber: String(log.blockNumber).toLowerCase(),
        transactionHash: String(log.transactionHash).toLowerCase(),
        transactionIndex: String(log.transactionIndex).toLowerCase(),
        logIndex: String(log.logIndex).toLowerCase(),
        data: String(log.data).toLowerCase(),
        topics: Array.isArray(log.topics) ? log.topics.map((topic) => String(topic).toLowerCase()) : [],
        removed: log.removed === true,
      };
      if (
        normalized.address !== address ||
        !/^0x[0-9a-f]{64}$/.test(normalized.blockHash) ||
        !/^0x[0-9a-f]+$/.test(normalized.blockNumber) ||
        !/^0x[0-9a-f]{64}$/.test(normalized.transactionHash) ||
        !/^0x[0-9a-f]+$/.test(normalized.transactionIndex) ||
        !/^0x[0-9a-f]+$/.test(normalized.logIndex) ||
        !/^0x[0-9a-f]*$/.test(normalized.data) ||
        normalized.topics.length === 0 ||
        normalized.topics.some((topic) => !/^0x[0-9a-f]{64}$/.test(topic)) ||
        normalized.removed
      ) {
        throw new Error(`${spec.name}: invalid or removed log ${index}`);
      }
      return normalized;
    });
    this.logQueries.push({
      name: spec.name,
      address,
      fromBlock: spec.fromBlock,
      toBlock: spec.toBlock,
      topics,
      logs,
      decoded: "",
    });
    return logs;
  }

  recordLogsDecoded(decoded: string): void {
    const last = this.logQueries[this.logQueries.length - 1];
    if (!last) throw new Error("recordLogsDecoded called before any log query");
    last.decoded = decoded;
  }
}

/** Offline caller that verifies and replays a captured eth_call journal in order. */
export class ReplayEthCaller implements EthCallJournal {
  readonly calls: MeasurementCall[] = [];
  readonly logQueries: MeasurementLogQuery[] = [];
  private index = 0;
  private logIndex = 0;

  constructor(
    private readonly recorded: readonly MeasurementCall[],
    private readonly recordedLogQueries: readonly MeasurementLogQuery[] = [],
  ) {}

  async call(spec: EthCallSpec): Promise<string> {
    const callData = `${spec.selector}${(spec.args ?? []).map(encodeWord).join("")}`.toLowerCase();
    const expected = this.recorded[this.index];
    if (!expected) throw new Error(`Replay journal ended before ${spec.name}`);
    if (
      expected.name !== spec.name ||
      expected.to !== spec.to.toLowerCase() ||
      expected.signature !== spec.signature ||
      expected.selector !== spec.selector ||
      expected.callData !== callData
    ) {
      throw new Error(
        `Replay call ${this.index} mismatch: expected ${expected.name} ${expected.to}:${expected.callData}, got ${spec.name} ${spec.to.toLowerCase()}:${callData}`,
      );
    }
    this.calls.push({ ...expected, decoded: "" });
    this.index += 1;
    return expected.returnData;
  }

  recordDecoded(decoded: string): void {
    const current = this.calls[this.calls.length - 1];
    if (!current) throw new Error("recordDecoded called before any replayed call");
    current.decoded = decoded;
  }

  async queryLogs(spec: LogQuerySpec): Promise<readonly MeasurementLog[]> {
    const expected = this.recordedLogQueries[this.logIndex];
    if (!expected) throw new Error(`Replay log journal ended before ${spec.name}`);
    const address = spec.address.toLowerCase();
    const topics = spec.topics.map((topic) => topic.toLowerCase());
    if (
      expected.name !== spec.name ||
      expected.address !== address ||
      expected.fromBlock !== spec.fromBlock ||
      expected.toBlock !== spec.toBlock ||
      JSON.stringify(expected.topics) !== JSON.stringify(topics)
    ) {
      throw new Error(`Replay log query ${this.logIndex} mismatch: expected ${expected.name}, got ${spec.name}`);
    }
    this.logQueries.push({ ...expected, logs: expected.logs.map((log) => ({ ...log })), decoded: "" });
    this.logIndex += 1;
    return expected.logs;
  }

  recordLogsDecoded(decoded: string): void {
    const current = this.logQueries[this.logQueries.length - 1];
    if (!current) throw new Error("recordLogsDecoded called before any replayed log query");
    current.decoded = decoded;
  }

  assertExhausted(): void {
    if (this.index !== this.recorded.length) {
      throw new Error(`Replay consumed ${this.index}/${this.recorded.length} journaled calls`);
    }
    if (this.logIndex !== this.recordedLogQueries.length) {
      throw new Error(`Replay consumed ${this.logIndex}/${this.recordedLogQueries.length} journaled log queries`);
    }
  }
}

export async function pinBlock(rpcUrl: string): Promise<PinnedBlock> {
  let selection: PinnedBlock["selection"] = "finalized";
  let header = (await rpcRequest(rpcUrl, "eth_getBlockByNumber", ["finalized", false]).catch(() => null)) as {
    number?: string;
    hash?: string;
    timestamp?: string;
  } | null;
  if (!header?.number || !header.hash || !header.timestamp) {
    selection = "latest-minus-10";
    const latestHex = (await rpcRequest(rpcUrl, "eth_blockNumber", [])) as string;
    const target = BigInt(latestHex) - 10n;
    header = (await rpcRequest(rpcUrl, "eth_getBlockByNumber", [`0x${target.toString(16)}`, false])) as {
      number?: string;
      hash?: string;
      timestamp?: string;
    };
  }
  if (!header?.number || !header.hash || !header.timestamp) {
    throw new Error("Could not pin a block on this RPC endpoint");
  }
  const timestampUnix = Number(BigInt(header.timestamp));
  return {
    number: Number(BigInt(header.number)),
    hash: header.hash.toLowerCase(),
    timestampUnix,
    timestampIso: new Date(timestampUnix * 1000).toISOString(),
    selection,
  };
}

export async function fetchBlockByNumber(rpcUrl: string, blockNumber: number): Promise<PinnedBlock> {
  const header = (await rpcRequest(rpcUrl, "eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false])) as {
    number?: string;
    hash?: string;
    timestamp?: string;
  } | null;
  if (!header?.number || !header.hash || !header.timestamp) {
    throw new Error(`Block ${blockNumber} not available on this RPC endpoint`);
  }
  const timestampUnix = Number(BigInt(header.timestamp));
  return {
    number: blockNumber,
    hash: header.hash.toLowerCase(),
    timestampUnix,
    timestampIso: new Date(timestampUnix * 1000).toISOString(),
    selection: "operator-pinned",
  };
}
