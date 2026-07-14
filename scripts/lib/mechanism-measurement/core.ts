import type { MeasurementCall } from "./schema";

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

export interface EthCallSpec {
  name: string;
  to: string;
  signature: string;
  selector: string;
  args?: readonly bigint[];
}

/** Journaling eth_call transport contract; tests substitute a recorded-returndata stub. */
export interface EthCallJournal {
  readonly calls: MeasurementCall[];
  call(spec: EthCallSpec): Promise<string>;
  recordDecoded(decoded: string): void;
}

/**
 * eth_call transport that journals every call (input and output bytes plus a
 * human-readable decode) so the evidence file is byte-replayable. All calls
 * run against one pinned block on one RPC endpoint; any failure throws and
 * the whole measurement aborts — never a partial or mixed-source file.
 */
export class JournaledEthCaller implements EthCallJournal {
  readonly calls: MeasurementCall[] = [];

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
