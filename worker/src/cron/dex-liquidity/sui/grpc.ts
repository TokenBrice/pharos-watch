import { isRecord } from "@shared/lib/type-guards";
import type { DexRequestBudget } from "@shared/types/measured-execution";
import { bytesToBase64, base64ToBytes } from "@shared/lib/base64";
import { fetchBinaryWithRetry } from "../../../lib/fetch-retry";
import { SUI_CLMM_DEPLOYMENTS } from "./identity";
import type { SuiRpc } from "./state-reader";

// Only the unary fields used by this diagnostic, from MystenLabs/sui-apis proto/sui/rpc/v2.
type Field = bigint | number | Uint8Array;
type Message = Map<number, Field[]>;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function varint(value: bigint): number[] {
  if (value < 0n || value >= 1n << 64n) throw new Error("sui-grpc-invalid-uint64");
  const bytes: number[] = [];
  do { bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0)); value >>= 7n; } while (value);
  return bytes;
}
function field(tag: number, value: string | Uint8Array | bigint): number[] {
  if (typeof value === "bigint") return [...varint(BigInt(tag * 8)), ...varint(value)];
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return [...varint(BigInt(tag * 8 + 2)), ...varint(BigInt(bytes.length)), ...bytes];
}
function mask(...paths: string[]): Uint8Array { return Uint8Array.from(paths.flatMap((path) => field(1, path))); }

function message(bytes: Uint8Array): Message {
  let offset = 0;
  function uint(): bigint {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw new Error("sui-grpc-truncated-protobuf");
      const byte = bytes[offset++];
      if (i === 9 && byte > 1) throw new Error("sui-grpc-invalid-varint");
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (byte < 128) return value;
    }
    throw new Error("sui-grpc-invalid-varint");
  }
  const result: Message = new Map();
  while (offset < bytes.length) {
    const key = uint();
    const tag = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (tag < 1 || tag > 0x1fffffff) throw new Error("sui-grpc-invalid-field");
    let value: Field;
    if (wire === 0) value = uint();
    else {
      const size = wire === 2 ? Number(uint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (!Number.isSafeInteger(size) || size < 0 || size > bytes.length - offset) throw new Error("sui-grpc-truncated-protobuf");
      value = wire === 1 ? new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getFloat64(0, true) : bytes.subarray(offset, offset + size);
      offset += size;
    }
    const values = result.get(tag) ?? [];
    values.push(value); result.set(tag, values);
  }
  return result;
}
function one(msg: Message, tag: number): Field {
  const values = msg.get(tag);
  if (values?.length !== 1) throw new Error("sui-grpc-missing-or-duplicate-field");
  return values[0];
}
function bytes(msg: Message, tag: number): Uint8Array {
  const value = one(msg, tag);
  if (!(value instanceof Uint8Array)) throw new Error("sui-grpc-invalid-bytes");
  return value;
}
function text(msg: Message, tag: number): string { return decoder.decode(bytes(msg, tag)); }
function uint(msg: Message, tag: number): bigint {
  const value = one(msg, tag);
  if (typeof value !== "bigint") throw new Error("sui-grpc-invalid-integer");
  return value;
}
function child(msg: Message, tag: number): Message { return message(bytes(msg, tag)); }
function repeated(msg: Message, tag: number): Message[] {
  return (msg.get(tag) ?? []).map((value) => {
    if (!(value instanceof Uint8Array)) throw new Error("sui-grpc-invalid-message");
    return message(value);
  });
}

/** google.protobuf.Value; depth and intake caps bound provider-controlled trees. */
function jsonValue(msg: Message, depth = 0): unknown {
  const kinds = [...msg.keys()].filter((key) => key >= 1 && key <= 6);
  if (depth > 32 || kinds.length !== 1) throw new Error("sui-grpc-invalid-json-value");
  const kind = kinds[0];
  if (kind === 1) { if (uint(msg, 1) !== 0n) throw new Error("sui-grpc-invalid-json-null"); return null; }
  if (kind === 2) {
    const value = one(msg, 2);
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("sui-grpc-invalid-json-number");
    return value;
  }
  if (kind === 3) return text(msg, 3);
  if (kind === 4) { const value = uint(msg, 4); if (value > 1n) throw new Error("sui-grpc-invalid-json-bool"); return value === 1n; }
  if (kind === 6) return repeated(child(msg, 6), 1).map((value) => jsonValue(value, depth + 1));
  const entries = repeated(child(msg, 5), 1).map((entry) => [text(entry, 1), jsonValue(child(entry, 2), depth + 1)] as const);
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("sui-grpc-duplicate-json-key");
  return Object.fromEntries(entries);
}

/** Keep the existing strict Move decoder and historical JSON-RPC fixtures. */
function moveStruct(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(moveStruct);
  if (!isRecord(value)) return value;
  return { fields: Object.fromEntries(Object.entries(value).map(([key, nested]) =>
    [key, key === "id" && typeof nested === "string" ? { id: nested } : moveStruct(nested)])) };
}
function object(msg: Message): unknown {
  const type = text(msg, 6);
  const fields = moveStruct(jsonValue(child(msg, 100)));
  // gRPC JSON omits nested struct tags; recover the tick tag only from its typed enclosing field.
  const tickType = `${SUI_CLMM_DEPLOYMENTS.cetus.typePackage}::tick::Tick`;
  const match = /^0x0*2::dynamic_field::Field<u64,0x[a-f0-9]{64}::skip_list::Node<([^<>]+)>>$/.exec(type.replace(/\s/g, ""));
  if (match?.[1] === tickType && isRecord(fields) && isRecord(fields.fields)) {
    const node = fields.fields.value;
    if (isRecord(node) && isRecord(node.fields) && isRecord(node.fields.value)) node.fields.value.type = tickType;
  }
  const owner = child(msg, 5);
  const kind = uint(owner, 1);
  const decodedOwner = kind === 3n ? { Shared: { initial_shared_version: uint(owner, 3).toString() } }
    : kind === 2n ? { ObjectOwner: text(owner, 2) } : kind === 4n ? "Immutable" : null;
  if (decodedOwner == null || !isRecord(fields)) throw new Error("sui-grpc-object-shape-unsupported");
  return { data: { objectId: text(msg, 2), version: uint(msg, 3).toString(), digest: text(msg, 4),
    previousTransaction: text(msg, 10), owner: decodedOwner, content: { type, ...fields } } };
}

export function decodeSuiGrpcWebUnary(body: Uint8Array): Uint8Array {
  let offset = 0;
  let payload: Uint8Array | undefined;
  let status: string | undefined;
  while (offset < body.length) {
    if (body.length - offset < 5 || status !== undefined) throw new Error("sui-grpc-invalid-frame");
    const flag = body[offset];
    const length = new DataView(body.buffer, body.byteOffset + offset + 1, 4).getUint32(0);
    offset += 5;
    if (length > body.length - offset) throw new Error("sui-grpc-truncated-frame");
    const frame = body.subarray(offset, offset + length); offset += length;
    if (flag === 128) {
      const statuses = decoder.decode(frame).split("\r\n").filter((line) => /^grpc-status:/i.test(line));
      if (statuses.length !== 1 || !/^grpc-status: ?[0-9]+$/i.test(statuses[0])) throw new Error("sui-grpc-invalid-trailer");
      status = statuses[0].split(":")[1].trim();
    } else if (flag === 0 && payload === undefined) payload = frame;
    else throw new Error("sui-grpc-invalid-frame");
  }
  if (status === undefined) throw new Error("sui-grpc-missing-trailer");
  if (status !== "0") throw new Error(`sui-grpc-status-${status.slice(0, 3)}`);
  if (payload === undefined) throw new Error("sui-grpc-missing-message");
  return payload;
}

/** JSON-RPC-shaped read seam, backed solely by serialized binary gRPC-web unary calls. */
export function createSuiClmmGrpc(input: {
  url: string; headers: HeadersInit; signal: AbortSignal; budget: DexRequestBudget; onResponse: () => void;
}): SuiRpc {
  let busy = false;
  async function call(service: "LedgerService" | "StateService", method: string, request: number[]): Promise<Message> {
    if (busy) throw new Error("sui-rpc-concurrent-request");
    if (input.signal.aborted || Date.now() >= input.budget.deadlineMs || !input.budget.tryConsume()) throw new Error("sui-rpc-budget-exhausted");
    busy = true;
    try {
      const body = new Uint8Array(request.length + 5);
      new DataView(body.buffer).setUint32(1, request.length); body.set(request, 5);
      const headers = new Headers(input.headers);
      headers.set("content-type", "application/grpc-web+proto"); headers.set("x-grpc-web", "1");
      const response = await fetchBinaryWithRetry(`${input.url}/sui.rpc.v2.${service}/${method}`, {
        method: "POST", headers, body, signal: input.signal, redirect: "manual",
      }, 0, { timeoutMs: Math.max(1, Math.min(15_000, input.budget.deadlineMs - Date.now())),
        maxResponseBytes: 2 * 1024 * 1024, returnFinalResponse: true, onResponse: input.onResponse });
      if (!response) throw new Error("sui-grpc-transport-failed");
      if (!response.response.ok) throw new Error(`sui-grpc-http-${response.response.status}`);
      if (response.response.headers.get("content-type")?.split(";")[0] !== "application/grpc-web+proto") throw new Error("sui-grpc-content-type-mismatch");
      return message(decodeSuiGrpcWebUnary(response.body));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("sui-")) throw error;
      throw new Error("sui-grpc-transport-failed");
    } finally { busy = false; }
  }
  const objectMask = mask("object_id", "version", "digest", "owner", "object_type", "previous_transaction", "json");
  let latestCheckpoint: { sequenceNumber: string; digest: string; timestampMs: string } | undefined;
  async function checkpoint(sequence?: string) {
    const response = child(await call("LedgerService", "GetCheckpoint", [
      ...(sequence == null ? [] : field(1, BigInt(sequence))), ...field(3, mask("sequence_number", "digest", "summary.timestamp")),
    ]), 1);
    const timestamp = child(child(response, 3), 9);
    const nanos = timestamp.has(2) ? uint(timestamp, 2) : 0n;
    if (nanos >= 1_000_000_000n) throw new Error("sui-grpc-invalid-timestamp");
    return { sequenceNumber: uint(response, 1).toString(), digest: text(response, 2), timestampMs: (uint(timestamp, 1) * 1000n + nanos / 1_000_000n).toString() };
  }
  return async (method, params) => {
    if (method === "sui_getObject") return object(child(await call("LedgerService", "GetObject", [...field(1, String(params[0])), ...field(3, objectMask)]), 1));
    if (method === "sui_multiGetObjects") {
      if (!Array.isArray(params[0]) || params[0].length < 1 || params[0].length > 50) throw new Error("sui-grpc-invalid-object-batch");
      const response = await call("LedgerService", "BatchGetObjects", [...params[0].flatMap((id) => field(1, Uint8Array.from(field(1, String(id))))), ...field(2, objectMask)]);
      return repeated(response, 1).map((result) => {
        if (result.has(2)) throw new Error("sui-grpc-object-unavailable");
        return object(child(result, 1));
      });
    }
    if (method === "suix_getDynamicFields") {
      const response = await call("StateService", "ListDynamicFields", [...field(1, String(params[0])), ...field(2, 50n),
        ...(params[1] == null ? [] : field(3, base64ToBytes(String(params[1])))), ...field(4, mask("kind", "parent", "field_id"))]);
      return { data: repeated(response, 1).map((entry) => {
        if (uint(entry, 1) !== 1n || text(entry, 2) !== params[0]) throw new Error("sui-invalid-dynamic-field-identity");
        return { type: "DynamicField", objectId: text(entry, 3) };
      }), hasNextPage: response.has(2), nextCursor: response.has(2) ? bytesToBase64(bytes(response, 2)) : null };
    }
    if (method === "sui_getLatestCheckpointSequenceNumber") {
      // Pin the actual returned checkpoint: a tip from another backend can be ahead of its ledger.
      latestCheckpoint = await checkpoint();
      return latestCheckpoint.sequenceNumber;
    }
    if (method === "sui_getCheckpoint") {
      return latestCheckpoint?.sequenceNumber === params[0] ? latestCheckpoint : checkpoint(String(params[0]));
    }
    if (method === "sui_multiGetTransactionBlocks") {
      const digests = params[0];
      if (!Array.isArray(digests) || digests.length < 1 || digests.length > 50) throw new Error("sui-grpc-invalid-transaction-batch");
      const response = await call("LedgerService", "BatchGetTransactions", [...digests.flatMap((digest) => field(1, String(digest))), ...field(2, mask("digest", "checkpoint"))]);
      return repeated(response, 1).map((result, index) => {
        if (result.has(2)) {
          if (uint(child(result, 2), 1) !== 5n) throw new Error("sui-grpc-transaction-read-failed");
          return { digest: digests[index] }; // Explicit NOT_FOUND alone may use archival ancestry.
        }
        const transaction = child(result, 1);
        return { digest: text(transaction, 1), ...(transaction.has(6) ? { checkpoint: uint(transaction, 6).toString() } : {}) };
      });
    }
    // shortcut: inspection needs a full TransactionData simulation adapter; retain local diagnostics until frozen execution is admitted.
    if (method === "sui_devInspectTransactionBlock") throw new Error("sui-grpc-inspection-unsupported");
    throw new Error("sui-grpc-method-unsupported");
  };
}
