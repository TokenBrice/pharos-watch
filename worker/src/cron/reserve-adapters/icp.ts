import { throwIfAborted } from "../../lib/abort";
import type { AdapterContext } from "./types";
import { fetchJsonWithRetry } from "./request";
import { fetchBinaryWithRetry } from "../../lib/fetch-retry";
import { runAdapterIo } from "./concurrency";

/**
 * DFINITY's ICRC ledger REST index. Verified 2026-07-29 to agree to the unit
 * with a direct `ic0.app` replica query (CBOR envelope, Candid `nat`), which is
 * the reason this reader can stay a dependency-free JSON GET instead of
 * hand-rolling CBOR inside the Worker.
 */
const ICRC_LEDGER_API_BASE_URLS = ["https://icrc-api.internetcomputer.org/api/v1/ledgers"] as const;

/** Text-form principals are base32-with-CRC groups; nothing else may reach the URL. */
// eslint-disable-next-line security/detect-unsafe-regex -- separator-delimited groups cannot overlap; no ambiguous backtracking path.
const ICP_CANISTER_ID_RE = /^[a-z2-7]{5}(-[a-z2-7]{5}){3}-[a-z2-7]{3}$/;

interface IcrcLedgerResponse {
  icrc1_metadata?: {
    icrc1_total_supply?: unknown;
  };
}

/**
 * Read an ICRC-1 ledger's `icrc1_total_supply` in base units. Bases are tried in
 * order and the last error is rethrown when every one fails, so a curated
 * aggregate leg fails closed with a diagnosable reason.
 */
export async function fetchIcrcLedgerTotalSupply(options: {
  canisterId: string;
  signal: AbortSignal;
  ctx?: AdapterContext;
  apiBaseUrl?: string;
  fallbackApiBaseUrl?: string;
  timeoutMs?: number;
}): Promise<bigint | null> {
  if (!ICP_CANISTER_ID_RE.test(options.canisterId)) {
    throw new Error(`icrc1_total_supply probe requires a text-form canister id (${options.canisterId})`);
  }

  const baseUrls = [options.apiBaseUrl, options.fallbackApiBaseUrl, ...ICRC_LEDGER_API_BASE_URLS].filter(
    (url): url is string => typeof url === "string" && url.length > 0,
  );
  let lastError: unknown = null;

  for (const baseUrl of baseUrls) {
    throwIfAborted(options.signal);
    try {
      const body = await fetchJsonWithRetry<IcrcLedgerResponse>(
        `${baseUrl.replace(/\/+$/, "")}/${options.canisterId}`,
        options.signal,
        options.timeoutMs ?? 10_000,
        options.ctx,
      );

      const totalSupply = body.icrc1_metadata?.icrc1_total_supply;
      if (typeof totalSupply !== "string" || !/^\d+$/.test(totalSupply)) {
        lastError = new Error(`icrc1_total_supply missing for ${options.canisterId} on ${baseUrl}`);
        continue;
      }
      return BigInt(totalSupply);
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  if (lastError) throw lastError;
  return null;
}

// ---------------------------------------------------------------------------
// Direct canister query transport (candid/CBOR over the boundary node).
//
// DFINITY's ICRC ledger REST index covers ICRC-1 ledgers only; arbitrary
// canister queries (the GLDT swap ledger's `get_swap_configs`, the ORIGYN NFT
// canisters' `icrc7_balance_of`) must go through the boundary-node HTTP
// interface. The request envelope is CBOR with string keys; the argument and
// reply are Candid-encoded. Both codecs are hand-rolled and dependency-free,
// matching the icp-js-core reference implementation byte-for-byte.
// ---------------------------------------------------------------------------

const IC_BOUNDARY_BASE_URLS = ["https://icp0.io", "https://ic0.app"] as const;
const ICP_CANISTER_PRINCIPAL_TAG = 1;
const ICP_ANONYMOUS_PRINCIPAL = 0x04;

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

// Text-form principals are base32 (canister bytes) + base32 (CRC32), with the
// checksum first after decoding. The boundary `canister_id` field carries the
// raw principal bytes without a tag byte.
function base32Decode(input: string): Uint8Array {
  const lookup = new Map<string, number>();
  for (let i = 0; i < BASE32_ALPHABET.length; i++) lookup.set(BASE32_ALPHABET[i], i);
  lookup.set("0", lookup.get("o")!);
  lookup.set("1", lookup.get("i")!);
  let skip = 0;
  let byte = 0;
  const output = new Uint8Array(Math.floor((input.length * 4) / 3));
  let o = 0;
  for (const char of input) {
    const value = lookup.get(char.toLowerCase());
    if (value === undefined) throw new Error(`icp: invalid base32 character "${char}"`);
    const val = value << 3;
    byte |= val >>> skip;
    skip += 5;
    if (skip >= 8) {
      output[o++] = byte;
      skip -= 8;
      byte = skip > 0 ? (val << (5 - skip)) & 255 : 0;
    }
  }
  return output.slice(0, o);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function base32Encode(bytes: Uint8Array): string {
  let skip = 0;
  let bits = 0;
  let output = "";
  for (let i = 0; i < bytes.length; ) {
    const byte = bytes[i];
    if (skip < 0) {
      bits |= byte >> -skip;
    } else {
      bits = (byte << skip) & 248;
    }
    if (skip > 3) {
      skip -= 8;
      i += 1;
      continue;
    }
    if (skip < 4) {
      output += BASE32_ALPHABET[bits >> 3];
      skip += 5;
    }
    i += 1;
  }
  return output + (skip < 0 ? BASE32_ALPHABET[bits >> 3] : "");
}

/** Raw canister-id bytes for a text principal (no tag byte). */
export function icpPrincipalBytes(text: string): Uint8Array {
  return base32Decode(text.toLowerCase().replace(/-/g, "")).slice(4);
}

/** Render a raw principal (with 0x01 tag) back to its text form. */
export function icpPrincipalText(bytes: Uint8Array): string {
  const data = bytes[0] === ICP_CANISTER_PRINCIPAL_TAG ? bytes.slice(1) : bytes;
  const checksum = new Uint8Array(4);
  new DataView(checksum.buffer).setUint32(0, crc32(data), false);
  const encoded = base32Encode(Uint8Array.from([...checksum, ...data]));
  return (encoded.match(/.{1,5}/g) ?? []).join("-");
}

// --- Candid integer codecs -------------------------------------------------

export function icpLebEncode(value: bigint): Uint8Array {
  const out: number[] = [];
  let v = value;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
  } while (v !== 0n);
  return Uint8Array.from(out);
}

function lebDecode(buf: Uint8Array, offset: { i: number }): bigint {
  let result = 0n;
  let shift = 0n;
  while (true) {
    const byte = buf[offset.i++];
    if (byte === undefined) throw new Error("icp: truncated leb128");
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return result;
}

function slebDecode(buf: Uint8Array, offset: { i: number }): bigint {
  let result = 0n;
  let shift = 0n;
  let byte = 0;
  do {
    byte = buf[offset.i++];
    if (byte === undefined) throw new Error("icp: truncated sleb128");
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while (byte & 0x80);
  if (shift < 64n && byte & 0x40) result |= -(1n << shift);
  return result;
}

/** Candid field-label hash (the Garrigue polynomial hash used by OCaml). */
export function icpLabelId(label: string): number {
  const bytes = new TextEncoder().encode(label);
  let h = 0;
  for (const byte of bytes) h = (h * 223 + byte) >>> 0;
  return h;
}

// --- CBOR ------------------------------------------------------------------

// Type aliases cannot pass themselves as type arguments (Record<string, CborValue>
// resolves eagerly, TS2456), so the map recursion goes through a lazily resolved
// interface.
interface CborMap {
  [key: string]: CborValue;
}

type CborValue =
  | number
  | bigint
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | CborValue[]
  | CborMap;

function cborEncode(value: CborValue): Uint8Array {
  const chunks: number[] = [];
  function head(major: number, val: number): void {
    if (val < 24) chunks.push((major << 5) | val);
    else if (val <= 0xff) chunks.push((major << 5) | 24, val);
    else if (val <= 0xffff) chunks.push((major << 5) | 25, val >>> 8, val & 0xff);
    else chunks.push((major << 5) | 26, (val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff);
  }
  function enc(x: CborValue): void {
    if (x === null) { chunks.push(0xf6); return; }
    if (x === false) { chunks.push(0xf4); return; }
    if (x === true) { chunks.push(0xf5); return; }
    if (typeof x === "number") {
      if (Number.isInteger(x) && x >= 0) { head(0, x); return; }
      if (Number.isInteger(x) && x < 0) { head(1, -1 - x); return; }
      throw new Error("icp: unsupported float");
    }
    if (typeof x === "bigint") { head(0, Number(x)); return; }
    if (typeof x === "string") {
      const bytes = new TextEncoder().encode(x);
      head(3, bytes.length);
      chunks.push(...bytes);
      return;
    }
    if (x instanceof Uint8Array) { head(2, x.length); chunks.push(...x); return; }
    if (Array.isArray(x)) { head(4, x.length); for (const e of x) enc(e); return; }
    if (typeof x === "object") {
      const entries = Object.entries(x);
      head(5, entries.length);
      for (const [k, v] of entries) { enc(k); enc(v); }
      return;
    }
    throw new Error("icp: unsupported cbor value");
  }
  enc(value);
  return Uint8Array.from(chunks);
}

function cborDecode(buf: Uint8Array, offset: { i: number } = { i: 0 }): CborValue {
  const b = buf[offset.i++];
  if (b === undefined) throw new Error("icp: truncated cbor");
  const major = b >>> 5;
  const info = b & 0x1f;
  function readLen(): number | bigint {
    if (info < 24) return info;
    if (info === 24) return buf[offset.i++];
    if (info === 25) { const v = (buf[offset.i++] << 8) | buf[offset.i++]; return v; }
    if (info === 26) {
      const v = ((buf[offset.i++] << 24) | (buf[offset.i++] << 16) | (buf[offset.i++] << 8) | buf[offset.i++]) >>> 0;
      return v;
    }
    if (info === 27) {
      let v = 0n;
      for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(buf[offset.i++]);
      return v;
    }
    throw new Error("icp: unsupported cbor length");
  }
  function readLenDefinite(): number {
    const info2 = buf[offset.i++] & 0x1f;
    if (info2 < 24) return info2;
    if (info2 === 24) return buf[offset.i++];
    if (info2 === 25) { const v = (buf[offset.i++] << 8) | buf[offset.i++]; return v; }
    if (info2 === 26) {
      return ((buf[offset.i++] << 24) | (buf[offset.i++] << 16) | (buf[offset.i++] << 8) | buf[offset.i++]) >>> 0;
    }
    if (info2 === 27) { let v = 0n; for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(buf[offset.i++]); return Number(v); }
    throw new Error("icp: unsupported cbor length");
  }
  switch (major) {
    case 0: return readLen();
    case 1: { const n = readLen(); return typeof n === "bigint" ? -1n - n : -1 - n; }
    case 2: {
      if (info === 31) {
        const parts: number[] = [];
        while (buf[offset.i] !== 0xff) {
          const n = readLenDefinite();
          parts.push(...buf.slice(offset.i, offset.i + n));
          offset.i += n;
        }
        offset.i++;
        return Uint8Array.from(parts);
      }
      const n = Number(readLen());
      const out = buf.slice(offset.i, offset.i + n);
      offset.i += n;
      return out;
    }
    case 3: { const n = Number(readLen()); const out = new TextDecoder().decode(buf.slice(offset.i, offset.i + n)); offset.i += n; return out; }
    case 4: {
      if (info === 31) {
        const out: CborValue[] = [];
        while (buf[offset.i] !== 0xff) out.push(cborDecode(buf, offset));
        offset.i++;
        return out;
      }
      const n = Number(readLen());
      const out: CborValue[] = [];
      for (let k = 0; k < n; k++) out.push(cborDecode(buf, offset));
      return out;
    }
    case 5: {
      if (info === 31) {
        const out: Record<string, CborValue> = {};
        while (buf[offset.i] !== 0xff) {
          const key = cborDecode(buf, offset);
          const val = cborDecode(buf, offset);
          if (typeof key === "string") out[key] = val;
        }
        offset.i++;
        return out;
      }
      const n = Number(readLen());
      const out: Record<string, CborValue> = {};
      for (let k = 0; k < n; k++) {
        const key = cborDecode(buf, offset);
        const val = cborDecode(buf, offset);
        if (typeof key === "string") out[key] = val;
      }
      return out;
    }
    case 6: { readLen(); return cborDecode(buf, offset); }
    case 7:
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      throw new Error("icp: unsupported cbor simple value");
    default: throw new Error("icp: unsupported cbor major type");
  }
}

// --- Candid value decoding -------------------------------------------------

type CandidType =
  | { kind: "primitive"; opcode: number }
  | { kind: "opt" | "vec"; inner: number }
  | { kind: "record" | "variant"; fields: Array<{ hash: number; type: number }> };

const CANDID_PRIMITIVES: Record<number, string> = {
  [-1]: "null", [-2]: "bool", [-3]: "nat", [-4]: "int",
  [-5]: "nat8", [-6]: "nat16", [-7]: "nat32", [-8]: "nat64",
  [-9]: "int8", [-10]: "int16", [-11]: "int32", [-12]: "int64",
  [-13]: "float32", [-14]: "float64", [-15]: "text", [-16]: "reserved",
  [-17]: "empty", [-24]: "principal",
};

function parseCandidTypeTable(buf: Uint8Array, offset: { i: number }): CandidType[] {
  const count = Number(lebDecode(buf, offset));
  const types: CandidType[] = [];
  for (let i = 0; i < count; i++) {
    const opcode = Number(slebDecode(buf, offset));
    const primitive = CANDID_PRIMITIVES[opcode];
    if (primitive !== undefined) {
      types.push({ kind: "primitive", opcode });
    } else if (opcode === -18 || opcode === -19) {
      types.push({ kind: opcode === -18 ? "opt" : "vec", inner: Number(slebDecode(buf, offset)) });
    } else if (opcode === -20 || opcode === -21) {
      const fieldCount = Number(lebDecode(buf, offset));
      const fields: Array<{ hash: number; type: number }> = [];
      for (let f = 0; f < fieldCount; f++) {
        fields.push({ hash: Number(lebDecode(buf, offset)), type: Number(slebDecode(buf, offset)) });
      }
      types.push({ kind: opcode === -20 ? "record" : "variant", fields });
    } else {
      throw new Error(`icp: unsupported candid opcode ${opcode}`);
    }
  }
  return types;
}

function decodeCandidValue(buf: Uint8Array, offset: { i: number }, types: CandidType[], typeRef: number): unknown {
  if (typeRef >= 0) {
    const t = types[typeRef];
    if (!t) throw new Error("icp: invalid candid type reference");
    if (t.kind === "opt") {
      const tag = buf[offset.i++];
      if (tag === 0) return null;
      return decodeCandidValue(buf, offset, types, t.inner);
    }
    if (t.kind === "vec") {
      const n = Number(lebDecode(buf, offset));
      const out: unknown[] = [];
      for (let k = 0; k < n; k++) out.push(decodeCandidValue(buf, offset, types, t.inner));
      return out;
    }
    if (t.kind === "record") {
      return t.fields.map((field) => decodeCandidValue(buf, offset, types, field.type));
    }
    if (t.kind === "variant") {
      const index = Number(lebDecode(buf, offset));
      const field = t.fields[index];
      if (!field) throw new Error("icp: invalid candid variant index");
      return { variantIndex: index, value: decodeCandidValue(buf, offset, types, field.type) };
    }
    throw new Error("icp: unsupported candid composite");
  }
  switch (typeRef) {
    case -1: return null;
    case -2: return buf[offset.i++] === 1;
    case -3: return lebDecode(buf, offset);
    case -4: return slebDecode(buf, offset);
    case -5: case -6: case -7: case -8: {
      const size = { [-5]: 1, [-6]: 2, [-7]: 4, [-8]: 8 }[typeRef]!;
      let v = 0n;
      for (let k = 0; k < size; k++) v |= BigInt(buf[offset.i++]) << BigInt(8 * k);
      return v;
    }
    case -9: case -10: case -11: case -12: {
      const size = { [-9]: 1, [-10]: 2, [-11]: 4, [-12]: 8 }[typeRef]!;
      let v = 0n;
      for (let k = 0; k < size; k++) v |= BigInt(buf[offset.i++]) << BigInt(8 * k);
      return v;
    }
    case -15: { const n = Number(lebDecode(buf, offset)); const out = new TextDecoder().decode(buf.slice(offset.i, offset.i + n)); offset.i += n; return out; }
    case -16: return undefined;
    case -17: return undefined;
    case -24: {
      offset.i += 1; // reference marker (always 1)
      const n = Number(lebDecode(buf, offset));
      const out = buf.slice(offset.i, offset.i + n);
      offset.i += n;
      return out;
    }
    default: throw new Error(`icp: unsupported candid primitive ${typeRef}`);
  }
}

/** Decode a Candid reply (magic + type table + arg types + values) into JS values. */
export function decodeCandidReply(bytes: Uint8Array): unknown[] {
  if (bytes.byteLength < 4 || new TextDecoder().decode(bytes.slice(0, 4)) !== "DIDL") {
    throw new Error("icp: invalid candid reply magic");
  }
  const offset = { i: 4 };
  const types = parseCandidTypeTable(bytes, offset);
  const argCount = Number(lebDecode(bytes, offset));
  const values: unknown[] = [];
  for (let k = 0; k < argCount; k++) {
    values.push(decodeCandidValue(bytes, offset, types, Number(slebDecode(bytes, offset))));
  }
  return values;
}

// --- Query transport -------------------------------------------------------

export interface IcpQueryResult {
  /** Decoded reply argument (the Candid-encoded return value) or null on rejection. */
  reply: Uint8Array | null;
  /** Certified state time in nanoseconds since the epoch, when the node attests it. */
  certifiedTimeNanos: bigint | null;
  rejectMessage: string | null;
}

/**
 * Query an Internet Computer canister through the boundary-node HTTP interface.
 * The argument is a pre-encoded Candid blob; the reply is returned raw for the
 * caller to decode. Every boundary is tried in order and the last error is
 * rethrown when all fail, so a single unhealthy boundary cannot truncate a read.
 */
export async function queryIcpCanister(options: {
  canisterId: string;
  methodName: string;
  arg: Uint8Array;
  signal: AbortSignal;
  ctx?: AdapterContext;
  timeoutMs?: number;
}): Promise<IcpQueryResult> {
  if (!ICP_CANISTER_ID_RE.test(options.canisterId)) {
    throw new Error(`icp query requires a text-form canister id (${options.canisterId})`);
  }
  const canisterBytes = icpPrincipalBytes(options.canisterId);
  const sender = Uint8Array.from([ICP_ANONYMOUS_PRINCIPAL]);
  const ingressExpiry = BigInt(Date.now() + 300_000) * 1_000_000n;

  let lastError: unknown = null;
  for (const baseUrl of IC_BOUNDARY_BASE_URLS) {
    throwIfAborted(options.signal);
    try {
      const body = cborEncode({
        content: {
          request_type: "query",
          canister_id: canisterBytes,
          method_name: options.methodName,
          arg: options.arg,
          sender,
          ingress_expiry: ingressExpiry,
        },
      });
      const queryUrl = new URL(`/api/v2/canister/${options.canisterId}/query`, baseUrl).toString();
      const response = await runAdapterIo(options.ctx, `icp:${options.methodName}`, () =>
        fetchBinaryWithRetry(
          queryUrl,
          {
            method: "POST",
            headers: { "content-type": "application/cbor" },
            body,
            signal: options.signal,
          },
          1,
          { timeoutMs: options.timeoutMs ?? 12_000, logUrl: queryUrl },
        ),
      );
      if (!response) throw new Error(`icp: no response from ${baseUrl}`);

      const decoded = cborDecode(response.body);
      if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
        throw new Error(`icp: malformed query response from ${baseUrl}`);
      }
      const responseMap = decoded as CborMap;
      const status = responseMap["status"];
      const signatures = responseMap["signatures"];
      const certifiedTimeNanos = extractCertifiedTimeNanos(signatures);

      if (status === "replied") {
        const reply = responseMap["reply"];
        const arg = typeof reply === "object" && reply !== null && !Array.isArray(reply)
          ? (reply as Record<string, CborValue>)["arg"]
          : undefined;
        if (!(arg instanceof Uint8Array)) throw new Error(`icp: missing reply arg from ${baseUrl}`);
        return { reply: arg, certifiedTimeNanos, rejectMessage: null };
      }
      if (status === "rejected") {
        return { reply: null, certifiedTimeNanos, rejectMessage: String(responseMap["reject_message"] ?? "rejected") };
      }
      throw new Error(`icp: unknown query status from ${baseUrl}`);
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function extractCertifiedTimeNanos(signatures: CborValue): bigint | null {
  if (!Array.isArray(signatures) || signatures.length === 0) return null;
  const first = signatures[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) return null;
  const timestamp = (first as Record<string, CborValue>)["timestamp"];
  return typeof timestamp === "bigint" ? timestamp : null;
}
