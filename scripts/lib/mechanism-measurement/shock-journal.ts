import { keccak256, type Hex } from "viem";

import { encodeWord, normalizeAddress } from "./core";
import type { MeasurementCall } from "./schema";

export type ShockAbiWord = bigint | { type: "uint256"; value: bigint } | { type: "address"; value: string };

export interface ShockEthCallSpec {
  name: string;
  to: string;
  role?: string;
  signature: string;
  selector: string;
  args?: readonly ShockAbiWord[];
}

export interface ShockCodeSpec {
  name: string;
  address: string;
  role: string;
}

export interface ShockContractCodePin {
  name: string;
  address: string;
  role: string;
  bytecode: string;
  codeHash: string;
}

export interface ShockCallJournal {
  readonly calls: MeasurementCall[];
  readonly codePins: ShockContractCodePin[];
  call(spec: ShockEthCallSpec): Promise<string>;
  batch(specs: readonly ShockEthCallSpec[]): Promise<readonly string[]>;
  recordDecoded(decoded: string): void;
  recordBatchDecoded(decoded: readonly string[]): void;
  captureCode(spec: ShockCodeSpec): Promise<ShockContractCodePin>;
  captureCodes(specs: readonly ShockCodeSpec[]): Promise<readonly ShockContractCodePin[]>;
}

export interface ShockBlockHashSelector {
  blockHash: string;
  requireCanonical: true;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: readonly unknown[];
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

interface NormalizedCallSpec {
  name: string;
  to: string;
  role?: string;
  signature: string;
  selector: string;
  callData: string;
}

interface NormalizedCodeSpec {
  name: string;
  address: string;
  role: string;
}

function requireNonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
  return value;
}

function normalizeHexBytes(value: unknown, label: string, allowEmpty = true): string {
  if (typeof value !== "string") throw new Error(`${label}: expected hex byte string`);
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(normalized) || normalized.length % 2 !== 0 || (!allowEmpty && normalized === "0x")) {
    throw new Error(`${label}: malformed hex byte string`);
  }
  return normalized;
}

/** Encode one static ABI word using the same unsigned/address rules as the core journal. */
export function encodeShockAbiWord(word: ShockAbiWord): string {
  if (typeof word === "bigint") return encodeWord(word);
  if (word.type === "uint256") return encodeWord(word.value);
  return encodeWord(BigInt(normalizeAddress(word.value, "ABI address argument")));
}

export function shockUintWord(value: bigint): ShockAbiWord {
  return { type: "uint256", value };
}

export function shockAddressWord(value: string): ShockAbiWord {
  return { type: "address", value };
}

function normalizeCallSpec(spec: ShockEthCallSpec): NormalizedCallSpec {
  const name = requireNonEmpty(spec.name, "call name");
  const to = normalizeAddress(spec.to, `${name} target`);
  const signature = requireNonEmpty(spec.signature, `${name} signature`);
  const selector = spec.selector.toLowerCase();
  if (!/^0x[0-9a-f]{8}$/.test(selector)) throw new Error(`${name}: malformed selector ${spec.selector}`);
  const role = spec.role === undefined ? undefined : requireNonEmpty(spec.role, `${name} role`);
  return {
    name,
    to,
    ...(role === undefined ? {} : { role }),
    signature,
    selector,
    callData: `${selector}${(spec.args ?? []).map(encodeShockAbiWord).join("")}`,
  };
}

function normalizeCodeSpec(spec: ShockCodeSpec): NormalizedCodeSpec {
  const name = requireNonEmpty(spec.name, "code pin name");
  return {
    name,
    address: normalizeAddress(spec.address, `${name} address`),
    role: requireNonEmpty(spec.role, `${name} role`),
  };
}

async function requestBatch(
  fetcher: typeof fetch,
  rpcUrl: string,
  requests: readonly JsonRpcRequest[],
): Promise<readonly JsonRpcResponse[]> {
  if (requests.length === 0) return [];
  const maxBatchSize = getShockRpcMaxBatchSize(rpcUrl);
  const results: JsonRpcResponse[] = [];
  for (let offset = 0; offset < requests.length; offset += maxBatchSize) {
    const chunk = requests.slice(offset, offset + maxBatchSize);
    let chunkResults: readonly JsonRpcResponse[] | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        // Public archive endpoints enforce burst limits independently of HTTP
        // batch size. Throttling is transport-only and never enters evidence.
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 200 : 400 * 2 ** attempt));
        const response = await fetcher(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chunk),
        });
        if (!response.ok) throw new Error(`JSON-RPC batch returned HTTP ${response.status}`);
        const payload: unknown = await response.json();
        if (!Array.isArray(payload)) throw new Error("JSON-RPC endpoint did not return a batch response");

        const byId = new Map<number, JsonRpcResponse>();
        for (const entry of payload) {
          if (!entry || typeof entry !== "object") throw new Error("JSON-RPC batch contained a malformed response");
          const rpcResponse = entry as JsonRpcResponse;
          if (!Number.isInteger(rpcResponse.id)) throw new Error("JSON-RPC batch response has a non-integer id");
          const id = rpcResponse.id as number;
          if (byId.has(id)) throw new Error(`JSON-RPC batch returned duplicate id ${id}`);
          byId.set(id, rpcResponse);
        }
        if (byId.size !== chunk.length) {
          throw new Error(`JSON-RPC batch returned ${byId.size}/${chunk.length} responses`);
        }

        chunkResults = chunk.map((request) => {
          const rpcResponse = byId.get(request.id);
          if (!rpcResponse) throw new Error(`JSON-RPC batch omitted id ${request.id}`);
          if (rpcResponse.error) {
            const message =
              typeof rpcResponse.error.message === "string"
                ? rpcResponse.error.message
                : JSON.stringify(rpcResponse.error);
            throw new Error(`${request.method} batch item ${request.id} failed: ${message}`);
          }
          if (rpcResponse.result === undefined) {
            throw new Error(`${request.method} batch item ${request.id} returned no result`);
          }
          return rpcResponse;
        });
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!/(429|rate|capacity|compute units|temporar|timeout|HTTP 5\d\d)/i.test(message)) throw error;
      }
    }
    if (!chunkResults) {
      throw new Error(
        `JSON-RPC batch failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    }
    results.push(...chunkResults);
  }
  return results;
}

function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function getShockRpcMaxBatchSize(rpcUrl: string): number {
  const { hostname } = new URL(rpcUrl);
  if (hostnameMatchesDomain(hostname, "drpc.org")) return 3;
  if (hostnameMatchesDomain(hostname, "blockscout.com")) return 5;
  return 50;
}

abstract class DecodedCallJournal {
  readonly calls: MeasurementCall[] = [];
  protected decodedIndex = 0;

  recordDecoded(decoded: string): void {
    const value = requireNonEmpty(decoded, "decoded call value");
    const call = this.calls[this.decodedIndex];
    if (!call) throw new Error("recordDecoded called with no undecoded journal entry");
    this.verifyDecoded(this.decodedIndex, value);
    call.decoded = value;
    this.decodedIndex += 1;
  }

  recordBatchDecoded(decoded: readonly string[]): void {
    if (decoded.length === 0) throw new Error("recordBatchDecoded needs at least one decoded value");
    const remaining = this.calls.length - this.decodedIndex;
    if (decoded.length > remaining) {
      throw new Error(`recordBatchDecoded received ${decoded.length} values for ${remaining} undecoded calls`);
    }
    for (const value of decoded) this.recordDecoded(value);
  }

  protected abstract verifyDecoded(index: number, decoded: string): void;
}

/** Live, pinned-block JSON-RPC batch transport for shock-coverage evidence. */
export class JournaledShockCaller extends DecodedCallJournal implements ShockCallJournal {
  readonly codePins: ShockContractCodePin[] = [];

  constructor(
    private readonly rpcUrl: string,
    private readonly blockSelector: string | ShockBlockHashSelector,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    super();
  }

  async call(spec: ShockEthCallSpec): Promise<string> {
    const [returnData] = await this.batch([spec]);
    if (returnData === undefined) throw new Error("Single-call batch returned no result");
    return returnData;
  }

  async batch(specs: readonly ShockEthCallSpec[]): Promise<readonly string[]> {
    if (specs.length === 0) return [];
    const normalized = specs.map(normalizeCallSpec);
    const requests = normalized.map((spec, index): JsonRpcRequest => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: "eth_call",
      params: [{ to: spec.to, data: spec.callData }, this.blockSelector],
    }));
    const responses = await requestBatch(this.fetcher, this.rpcUrl, requests);
    const returnData = responses.map((response, index) =>
      normalizeHexBytes(response.result, normalized[index]?.name ?? `eth_call ${index}`),
    );

    for (let index = 0; index < normalized.length; index += 1) {
      const spec = normalized[index]!;
      this.calls.push({
        name: spec.name,
        to: spec.to,
        signature: spec.signature,
        selector: spec.selector,
        callData: spec.callData,
        returnData: returnData[index]!,
        decoded: "",
      });
    }
    return returnData;
  }

  async captureCode(spec: ShockCodeSpec): Promise<ShockContractCodePin> {
    const [pin] = await this.captureCodes([spec]);
    if (!pin) throw new Error("Single-code batch returned no result");
    return pin;
  }

  async captureCodes(specs: readonly ShockCodeSpec[]): Promise<readonly ShockContractCodePin[]> {
    if (specs.length === 0) return [];
    const normalized = specs.map(normalizeCodeSpec);
    const requests = normalized.map((spec, index): JsonRpcRequest => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: "eth_getCode",
      params: [spec.address, this.blockSelector],
    }));
    const responses = await requestBatch(this.fetcher, this.rpcUrl, requests);
    const pins = responses.map((response, index): ShockContractCodePin => {
      const spec = normalized[index]!;
      const bytecode = normalizeHexBytes(response.result, `${spec.name} bytecode`, false);
      return {
        ...spec,
        bytecode,
        codeHash: keccak256(bytecode as Hex),
      };
    });
    this.codePins.push(...pins);
    return pins;
  }

  protected verifyDecoded(): void {
    // Live decoding is authoritative; replay verifies it against the recording.
  }
}

/** Strict offline replay of calls and code captures in their recorded order. */
export class ReplayShockCaller extends DecodedCallJournal implements ShockCallJournal {
  readonly codePins: ShockContractCodePin[] = [];
  private callIndex = 0;
  private codeIndex = 0;

  constructor(
    private readonly recordedCalls: readonly MeasurementCall[],
    private readonly recordedCodePins: readonly ShockContractCodePin[],
  ) {
    super();
  }

  async call(spec: ShockEthCallSpec): Promise<string> {
    const [returnData] = await this.batch([spec]);
    if (returnData === undefined) throw new Error("Single replay call returned no result");
    return returnData;
  }

  async batch(specs: readonly ShockEthCallSpec[]): Promise<readonly string[]> {
    if (specs.length === 0) return [];
    const normalized = specs.map(normalizeCallSpec);
    const expectedCalls = normalized.map((spec, offset) => {
      const index = this.callIndex + offset;
      const expected = this.recordedCalls[index];
      if (!expected) throw new Error(`Replay journal ended before ${spec.name}`);
      if (
        expected.name !== spec.name ||
        expected.to !== spec.to ||
        expected.signature !== spec.signature ||
        expected.selector !== spec.selector ||
        expected.callData !== spec.callData
      ) {
        throw new Error(
          `Replay call ${index} mismatch: expected ${expected.name} ${expected.to}:${expected.callData}, got ${spec.name} ${spec.to}:${spec.callData}`,
        );
      }
      if (spec.role !== undefined && !this.recordedCodePins.some((pin) => pin.address === spec.to)) {
        throw new Error(`Replay call ${index} has unpinned target ${spec.to} for role ${spec.role}`);
      }
      normalizeHexBytes(expected.returnData, `${expected.name} recorded return data`);
      return expected;
    });

    this.calls.push(...expectedCalls.map((call) => ({ ...call, decoded: "" })));
    this.callIndex += expectedCalls.length;
    return expectedCalls.map((call) => call.returnData);
  }

  async captureCode(spec: ShockCodeSpec): Promise<ShockContractCodePin> {
    const [pin] = await this.captureCodes([spec]);
    if (!pin) throw new Error("Single replay code capture returned no result");
    return pin;
  }

  async captureCodes(specs: readonly ShockCodeSpec[]): Promise<readonly ShockContractCodePin[]> {
    if (specs.length === 0) return [];
    const normalized = specs.map(normalizeCodeSpec);
    const expectedPins = normalized.map((spec, offset) => {
      const index = this.codeIndex + offset;
      const expected = this.recordedCodePins[index];
      if (!expected) throw new Error(`Replay code journal ended before ${spec.name}`);
      if (expected.name !== spec.name || expected.address !== spec.address || expected.role !== spec.role) {
        throw new Error(
          `Replay code pin ${index} mismatch: expected ${expected.name} ${expected.address} (${expected.role}), got ${spec.name} ${spec.address} (${spec.role})`,
        );
      }
      const bytecode = normalizeHexBytes(expected.bytecode, `${expected.name} recorded bytecode`, false);
      const codeHash = keccak256(bytecode as Hex);
      if (expected.codeHash !== codeHash) {
        throw new Error(`Replay code pin ${index} hash mismatch: recorded ${expected.codeHash}, computed ${codeHash}`);
      }
      return { ...expected };
    });

    this.codePins.push(...expectedPins);
    this.codeIndex += expectedPins.length;
    return expectedPins;
  }

  assertExhausted(): void {
    if (this.callIndex !== this.recordedCalls.length) {
      throw new Error(`Replay consumed ${this.callIndex}/${this.recordedCalls.length} journaled calls`);
    }
    if (this.decodedIndex !== this.recordedCalls.length) {
      throw new Error(`Replay decoded ${this.decodedIndex}/${this.recordedCalls.length} journaled calls`);
    }
    if (this.codeIndex !== this.recordedCodePins.length) {
      throw new Error(`Replay consumed ${this.codeIndex}/${this.recordedCodePins.length} code pins`);
    }
  }

  protected verifyDecoded(index: number, decoded: string): void {
    const expected = this.recordedCalls[index];
    if (!expected) throw new Error(`Replay decode ${index} has no recorded call`);
    if (expected.decoded !== decoded) {
      throw new Error(
        `Replay decode ${index} mismatch for ${expected.name}: expected ${expected.decoded}, got ${decoded}`,
      );
    }
  }
}
