/**
 * Self-contained portable state for `/export` and `/import`.
 *
 * Version 1 is the historical base64url JSON format and remains read-only
 * compatible. `pw2` and `pw3` are gzip payloads with a 96-bit SHA-256 digest;
 * pw3 extends direct-row intent with freeze bits. The digest detects copy/paste
 * corruption or tampering; it is not authentication.
 */

import { fnv1a32 } from "@shared/lib/fnv1a";
import { TELEGRAM_MINI_APP_CATALOG_VERSION } from "@shared/lib/telegram-mini-app-catalog";
import { TELEGRAM_PRESET_IDS } from "@shared/lib/telegram-presets";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  base64UrlToBytes,
  base64UrlToString,
  bytesToBase64Url,
} from "@shared/lib/base64url";
import { parseJson } from "../json-parse";

const V1_TOKEN_VERSION = 1;
const V2_TOKEN_VERSION = 2;
const V3_TOKEN_VERSION = 3;
const V2_PREFIX = "pw2";
const V3_PREFIX = "pw3";
const V2_DIGEST_BYTES = 12;
const MAX_DECOMPRESSED_TOKEN_BYTES = 64 * 1024;
const MAX_TOKEN_ROWS = 512;
const DIRECT_PACK_MAX = 0x3ffff;
const PRESET_PACK_MAX = 0x1f;

/**
 * Leaves headroom for both `/import <token>` (Telegram's 4096-char inbound
 * limit) and the export reply's `<pre>...</pre>` line (the 4000-char splitter).
 */
export const MAX_WATCHLIST_TOKEN_CHARS = 3900;
const LEGACY_V1_MAX_WATCHLIST_TOKEN_CHARS = 4000;

export const WATCHLIST_TOKEN_REGISTRY_VERSION = TELEGRAM_MINI_APP_CATALOG_VERSION;

export interface WatchlistTokenV1State {
  coinIds: string[];
  alertTypes: string[];
  presetIds: string[];
}

export interface WatchlistTokenDirectState {
  stablecoinId: string;
  alertDews: boolean;
  alertDepeg: boolean;
  alertSafety: boolean;
  alertLaunch: boolean;
  alertReserve: boolean;
  alertFreeze?: boolean;
  overrideDews: boolean;
  overrideDepeg: boolean;
  overrideSafety: boolean;
  overrideLaunch: boolean;
  overrideReserve: boolean;
  overrideFreeze?: boolean;
  dewsMinBand: "ALERT" | "WARNING" | "DANGER" | null;
  safetyMode: "all" | "downgrade-only" | "upgrade-only" | null;
  depegWorseningBpsStep: 100 | 250 | 500 | null;
}

export interface WatchlistTokenPresetState {
  presetId: string;
  alertDews: boolean;
  alertDepeg: boolean;
  alertSafety: boolean;
  depegWorseningBpsStep: 100 | 250 | 500 | null;
}

export interface WatchlistTokenV2State {
  registryVersion: string;
  direct: WatchlistTokenDirectState[];
  presets: WatchlistTokenPresetState[];
}

interface WatchlistTokenV2Body {
  v: 2;
  r: string;
  d: string;
  p: string;
}

interface WatchlistTokenV3Body {
  v: 3;
  r: string;
  d: string;
  p: string;
}

const DIRECT_BINARY_ROW_BYTES = 6;
const PRESET_BINARY_ROW_BYTES = 5;

function buildHashRegistry(ids: Iterable<string>): ReadonlyMap<number, string | null> {
  const registry = new Map<number, string | null>();
  for (const id of ids) {
    const hash = fnv1a32(id);
    if (!registry.has(hash)) registry.set(hash, id);
    else if (registry.get(hash) !== id) registry.set(hash, null);
  }
  return registry;
}

const DIRECT_ID_BY_HASH = buildHashRegistry(TRACKED_META_BY_ID.keys());
const PRESET_ID_BY_HASH = buildHashRegistry(TELEGRAM_PRESET_IDS);

export type WatchlistTokenDecodeError =
  | "empty"
  | "too-large"
  | "malformed"
  | "integrity"
  | "unsupported-version";

export type WatchlistTokenDecodeResult =
  | { ok: true; version: 1; state: WatchlistTokenV1State }
  | { ok: true; version: 2; state: WatchlistTokenV2State }
  | { ok: true; version: 3; state: WatchlistTokenV2State }
  | { ok: false; error: WatchlistTokenDecodeError };

function bit(value: boolean, position: number): number {
  return value ? (1 << position) : 0;
}

function encodeDewsBand(value: WatchlistTokenDirectState["dewsMinBand"]): number {
  return value === "ALERT" ? 1 : value === "WARNING" ? 2 : value === "DANGER" ? 3 : 0;
}

function decodeDewsBand(value: number): WatchlistTokenDirectState["dewsMinBand"] {
  return value === 1 ? "ALERT" : value === 2 ? "WARNING" : value === 3 ? "DANGER" : null;
}

function encodeSafetyMode(value: WatchlistTokenDirectState["safetyMode"]): number {
  return value === "all" ? 1 : value === "downgrade-only" ? 2 : value === "upgrade-only" ? 3 : 0;
}

function decodeSafetyMode(value: number): WatchlistTokenDirectState["safetyMode"] {
  return value === 1 ? "all" : value === 2 ? "downgrade-only" : value === 3 ? "upgrade-only" : null;
}

function encodeDepegStep(value: 100 | 250 | 500 | null): number {
  return value === 100 ? 1 : value === 250 ? 2 : value === 500 ? 3 : 0;
}

function decodeDepegStep(value: number): 100 | 250 | 500 | null {
  return value === 1 ? 100 : value === 2 ? 250 : value === 3 ? 500 : null;
}

export function packWatchlistDirectState(row: WatchlistTokenDirectState): string {
  const packed = bit(row.alertDews, 0)
    | bit(row.alertDepeg, 1)
    | bit(row.alertSafety, 2)
    | bit(row.alertLaunch, 3)
    | bit(row.alertReserve, 4)
    | bit(Boolean(row.alertFreeze), 16)
    | bit(row.overrideDews, 5)
    | bit(row.overrideDepeg, 6)
    | bit(row.overrideSafety, 7)
    | bit(row.overrideLaunch, 8)
    | bit(row.overrideReserve, 9)
    | bit(Boolean(row.overrideFreeze), 17)
    | (encodeDewsBand(row.dewsMinBand) << 10)
    | (encodeSafetyMode(row.safetyMode) << 12)
    | (encodeDepegStep(row.depegWorseningBpsStep) << 14);
  return `${row.stablecoinId}~${packed.toString(36)}`;
}

export function packWatchlistPresetState(row: WatchlistTokenPresetState): string {
  const packed = bit(row.alertDews, 0)
    | bit(row.alertDepeg, 1)
    | bit(row.alertSafety, 2)
    | (encodeDepegStep(row.depegWorseningBpsStep) << 3);
  return `${row.presetId}~${packed.toString(36)}`;
}

function splitPacked(value: string, max: number): { id: string; packed: number } | null {
  if (value.length > 160) return null;
  const separator = value.lastIndexOf("~");
  if (separator <= 0 || separator === value.length - 1) return null;
  const id = value.slice(0, separator);
  const encoded = value.slice(separator + 1);
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(id) || !/^[0-9a-z]+$/.test(encoded)) return null;
  const packed = Number.parseInt(encoded, 36);
  if (!Number.isSafeInteger(packed) || packed < 0 || packed > max) return null;
  return { id, packed };
}

export function unpackWatchlistDirectState(value: string): WatchlistTokenDirectState | null {
  const decoded = splitPacked(value, DIRECT_PACK_MAX);
  if (!decoded) return null;
  const { id, packed } = decoded;
  return {
    stablecoinId: id,
    alertDews: Boolean(packed & (1 << 0)),
    alertDepeg: Boolean(packed & (1 << 1)),
    alertSafety: Boolean(packed & (1 << 2)),
    alertLaunch: Boolean(packed & (1 << 3)),
    alertReserve: Boolean(packed & (1 << 4)),
    alertFreeze: Boolean(packed & (1 << 16)),
    overrideDews: Boolean(packed & (1 << 5)),
    overrideDepeg: Boolean(packed & (1 << 6)),
    overrideSafety: Boolean(packed & (1 << 7)),
    overrideLaunch: Boolean(packed & (1 << 8)),
    overrideReserve: Boolean(packed & (1 << 9)),
    overrideFreeze: Boolean(packed & (1 << 17)),
    dewsMinBand: decodeDewsBand((packed >> 10) & 0x3),
    safetyMode: decodeSafetyMode((packed >> 12) & 0x3),
    depegWorseningBpsStep: decodeDepegStep((packed >> 14) & 0x3),
  };
}

export function unpackWatchlistPresetState(value: string): WatchlistTokenPresetState | null {
  const decoded = splitPacked(value, PRESET_PACK_MAX);
  if (!decoded) return null;
  const { id, packed } = decoded;
  return {
    presetId: id,
    alertDews: Boolean(packed & (1 << 0)),
    alertDepeg: Boolean(packed & (1 << 1)),
    alertSafety: Boolean(packed & (1 << 2)),
    depegWorseningBpsStep: decodeDepegStep((packed >> 3) & 0x3),
  };
}

function cleanToken(raw: string): string {
  return raw
    .trim()
    // eslint-disable-next-line security/detect-unsafe-regex -- bounded command-prefix strip before max-length validation.
    .replace(/^\/import(@\S+)?\s+/i, "")
    .replace(/[`\s]/g, "");
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(Uint8Array.from(bytes)).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBounded(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(Uint8Array.from(bytes)).body!.pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_DECOMPRESSED_TOKEN_BYTES) {
      await reader.cancel();
      throw new Error("Watchlist token expands past the decoded limit");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function digest96(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return digest.slice(0, V2_DIGEST_BYTES);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function sortedUniqueRows<T>(
  rows: readonly T[],
  id: (row: T) => string,
): T[] {
  const sorted = [...rows].sort((left, right) => id(left).localeCompare(id(right)));
  if (sorted.length > MAX_TOKEN_ROWS) throw new Error("Watchlist token contains too many rows");
  for (let index = 1; index < sorted.length; index += 1) {
    if (id(sorted[index - 1]) === id(sorted[index])) throw new Error("Watchlist token contains duplicate rows");
  }
  return sorted;
}

function encodeBinaryRows<T>(
  rows: readonly T[],
  rowBytes: number,
  id: (row: T) => string,
  packed: (row: T) => number,
  registry: ReadonlyMap<number, string | null>,
): string {
  const sorted = sortedUniqueRows(rows, id);
  const bytes = new Uint8Array(sorted.length * rowBytes);
  const view = new DataView(bytes.buffer);
  sorted.forEach((row, index) => {
    const rowId = id(row);
    const hash = fnv1a32(rowId);
    if (registry.get(hash) !== rowId) throw new Error(`Watchlist token id is not uniquely registered: ${rowId}`);
    const offset = index * rowBytes;
    view.setUint32(offset, hash);
    if (rowBytes === DIRECT_BINARY_ROW_BYTES) view.setUint16(offset + 4, packed(row));
    else view.setUint8(offset + 4, packed(row));
  });
  return bytesToBase64Url(bytes);
}

function packedNumber(entry: string): number {
  const separator = entry.lastIndexOf("~");
  return Number.parseInt(entry.slice(separator + 1), 36);
}

function decodeBinaryRows<T>(
  value: unknown,
  rowBytes: number,
  registry: ReadonlyMap<number, string | null>,
  unpack: (entry: string) => T | null,
): T[] | null {
  if (typeof value !== "string") return null;
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(value);
  } catch {
    return null;
  }
  if (bytes.byteLength % rowBytes !== 0 || bytes.byteLength / rowBytes > MAX_TOKEN_ROWS) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows: T[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < bytes.byteLength; offset += rowBytes) {
    const id = registry.get(view.getUint32(offset));
    if (!id || seen.has(id)) return null;
    const packed = rowBytes === DIRECT_BINARY_ROW_BYTES ? view.getUint16(offset + 4) : view.getUint8(offset + 4);
    const row = unpack(`${id}~${packed.toString(36)}`);
    if (!row) return null;
    seen.add(id);
    rows.push(row);
  }
  return rows;
}

const V3_DIRECT_RECORD_BITS = 50;
const V3_DIRECT_PACK_BITS = 18;

function writeBits(bytes: Uint8Array, bitOffset: number, value: number, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const sourceBit = count - index - 1;
    if (Math.floor(value / (2 ** sourceBit)) % 2 === 0) continue;
    const target = bitOffset + index;
    bytes[Math.floor(target / 8)] |= 1 << (7 - (target % 8));
  }
}

function readBits(bytes: Uint8Array, bitOffset: number, count: number): number {
  let value = 0;
  for (let index = 0; index < count; index += 1) {
    const target = bitOffset + index;
    value = (value * 2) + ((bytes[Math.floor(target / 8)] >> (7 - (target % 8))) & 1);
  }
  return value;
}

function encodeV3DirectRows(rows: readonly WatchlistTokenDirectState[]): string {
  const sorted = sortedUniqueRows(rows, (row) => row.stablecoinId);
  const bytes = new Uint8Array(Math.ceil((sorted.length * V3_DIRECT_RECORD_BITS) / 8));
  sorted.forEach((row, index) => {
    const hash = fnv1a32(row.stablecoinId);
    if (DIRECT_ID_BY_HASH.get(hash) !== row.stablecoinId) throw new Error(`Watchlist token id is not uniquely registered: ${row.stablecoinId}`);
    const packed = packedNumber(packWatchlistDirectState(row));
    if (packed > DIRECT_PACK_MAX) throw new Error("pw3 direct intent exceeds its bitfield");
    const offset = index * V3_DIRECT_RECORD_BITS;
    writeBits(bytes, offset, hash, 32);
    writeBits(bytes, offset + 32, packed, V3_DIRECT_PACK_BITS);
  });
  return bytesToBase64Url(bytes);
}

function decodeV3DirectRows(value: unknown): WatchlistTokenDirectState[] | null {
  if (typeof value !== "string") return null;
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(value);
  } catch {
    return null;
  }
  const rowCount = Math.floor((bytes.byteLength * 8) / V3_DIRECT_RECORD_BITS);
  if (rowCount > MAX_TOKEN_ROWS || Math.ceil((rowCount * V3_DIRECT_RECORD_BITS) / 8) !== bytes.byteLength) return null;
  const rows: WatchlistTokenDirectState[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rowCount; index += 1) {
    const offset = index * V3_DIRECT_RECORD_BITS;
    const id = DIRECT_ID_BY_HASH.get(readBits(bytes, offset, 32));
    if (!id || seen.has(id)) return null;
    const row = unpackWatchlistDirectState(`${id}~${readBits(bytes, offset + 32, V3_DIRECT_PACK_BITS).toString(36)}`);
    if (!row) return null;
    seen.add(id);
    rows.push(row);
  }
  return rows;
}

/** pw3 extends pw2's direct row with freeze and local-freeze-override bits. */
export async function encodeWatchlistTokenV3(state: WatchlistTokenV2State): Promise<string> {
  const body: WatchlistTokenV3Body = {
    v: V3_TOKEN_VERSION,
    r: state.registryVersion,
    d: encodeV3DirectRows(state.direct),
    p: encodeBinaryRows(
      state.presets,
      PRESET_BINARY_ROW_BYTES,
      (row) => row.presetId,
      (row) => packedNumber(packWatchlistPresetState(row)),
      PRESET_ID_BY_HASH,
    ),
  };
  const compressed = await gzip(new TextEncoder().encode(JSON.stringify(body)));
  const token = `${V3_PREFIX}.${bytesToBase64Url(compressed)}.${bytesToBase64Url(await digest96(compressed))}`;
  if (token.length > MAX_WATCHLIST_TOKEN_CHARS) throw new Error("Watchlist token exceeds the copy/paste limit");
  return token;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function decodeV1(cleaned: string): WatchlistTokenDecodeResult {
  let decoded: string;
  try {
    decoded = base64UrlToString(cleaned);
  } catch {
    return { ok: false, error: "malformed" };
  }
  const parsedResult = parseJson(decoded);
  if (!parsedResult.ok) return { ok: false, error: "malformed" };
  const parsed = parsedResult.value;
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "malformed" };
  const body = parsed as Record<string, unknown>;
  if (body.v !== V1_TOKEN_VERSION) return { ok: false, error: "unsupported-version" };
  const coinIds = asStringArray(body.c);
  const alertTypes = asStringArray(body.t);
  const presetIds = asStringArray(body.p);
  if (coinIds.length === 0 && presetIds.length === 0) return { ok: false, error: "empty" };
  return { ok: true, version: 1, state: { coinIds, alertTypes, presetIds } };
}

async function decodeV2(cleaned: string): Promise<WatchlistTokenDecodeResult> {
  const parts = cleaned.split(".");
  if (parts.length !== 3 || parts[0] !== V2_PREFIX) return { ok: false, error: "malformed" };
  let compressed: Uint8Array;
  let suppliedDigest: Uint8Array;
  try {
    compressed = base64UrlToBytes(parts[1]);
    suppliedDigest = base64UrlToBytes(parts[2]);
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (suppliedDigest.byteLength !== V2_DIGEST_BYTES) return { ok: false, error: "malformed" };
  if (!equalBytes(suppliedDigest, await digest96(compressed))) return { ok: false, error: "integrity" };

  let decoded: string;
  try {
    decoded = new TextDecoder().decode(await gunzipBounded(compressed));
  } catch {
    return { ok: false, error: "malformed" };
  }
  const parsedResult = parseJson(decoded);
  if (!parsedResult.ok) return { ok: false, error: "malformed" };
  const parsed = parsedResult.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "malformed" };
  const body = parsed as Partial<WatchlistTokenV2Body>;
  if (body.v !== V2_TOKEN_VERSION) return { ok: false, error: "unsupported-version" };
  if (typeof body.r !== "string" || body.r.length < 1 || body.r.length > 64) return { ok: false, error: "malformed" };
  const direct = decodeBinaryRows(body.d, DIRECT_BINARY_ROW_BYTES, DIRECT_ID_BY_HASH, unpackWatchlistDirectState);
  const presets = decodeBinaryRows(body.p, PRESET_BINARY_ROW_BYTES, PRESET_ID_BY_HASH, unpackWatchlistPresetState);
  if (!direct || !presets) return { ok: false, error: "malformed" };
  const directIds = new Set(direct.map((row) => row.stablecoinId));
  const presetIds = new Set(presets.map((row) => row.presetId));
  if (directIds.size !== direct.length || presetIds.size !== presets.length) return { ok: false, error: "malformed" };
  if (direct.length === 0 && presets.length === 0) return { ok: false, error: "empty" };
  return { ok: true, version: 2, state: { registryVersion: body.r, direct, presets } };
}

async function decodeV3(cleaned: string): Promise<WatchlistTokenDecodeResult> {
  const parts = cleaned.split(".");
  if (parts.length !== 3 || parts[0] !== V3_PREFIX) return { ok: false, error: "malformed" };
  let compressed: Uint8Array;
  let suppliedDigest: Uint8Array;
  try {
    compressed = base64UrlToBytes(parts[1]);
    suppliedDigest = base64UrlToBytes(parts[2]);
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (suppliedDigest.byteLength !== V2_DIGEST_BYTES) return { ok: false, error: "malformed" };
  if (!equalBytes(suppliedDigest, await digest96(compressed))) return { ok: false, error: "integrity" };
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(await gunzipBounded(compressed));
  } catch {
    return { ok: false, error: "malformed" };
  }
  const parsedResult = parseJson(decoded);
  if (!parsedResult.ok) return { ok: false, error: "malformed" };
  const parsed = parsedResult.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "malformed" };
  const body = parsed as Partial<WatchlistTokenV3Body>;
  if (body.v !== V3_TOKEN_VERSION) return { ok: false, error: "unsupported-version" };
  if (typeof body.r !== "string" || body.r.length < 1 || body.r.length > 64) return { ok: false, error: "malformed" };
  const direct = decodeV3DirectRows(body.d);
  const presets = decodeBinaryRows(body.p, PRESET_BINARY_ROW_BYTES, PRESET_ID_BY_HASH, unpackWatchlistPresetState);
  if (!direct || !presets || (direct.length === 0 && presets.length === 0)) return { ok: false, error: direct && presets ? "empty" : "malformed" };
  return { ok: true, version: 3, state: { registryVersion: body.r, direct, presets } };
}

export async function decodeWatchlistToken(raw: string): Promise<WatchlistTokenDecodeResult> {
  const cleaned = cleanToken(raw);
  if (cleaned.length === 0) return { ok: false, error: "empty" };
  if (cleaned.startsWith(`${V2_PREFIX}.`) || cleaned.startsWith(`${V3_PREFIX}.`)) {
    if (cleaned.length > MAX_WATCHLIST_TOKEN_CHARS) return { ok: false, error: "too-large" };
    return cleaned.startsWith(`${V3_PREFIX}.`) ? decodeV3(cleaned) : decodeV2(cleaned);
  }
  if (cleaned.length > LEGACY_V1_MAX_WATCHLIST_TOKEN_CHARS) return { ok: false, error: "too-large" };
  return decodeV1(cleaned);
}
