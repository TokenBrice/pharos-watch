import { z } from "zod";
import type { AdapterContext } from "./types";
import { fetchJsonPostWithRetry } from "./request";
import { getRpcAuthHeaders, registryRpcUrls } from "../../lib/chain-registry";
import { throwIfAborted } from "../../lib/abort";
import { redactProviderUrls } from "../../lib/safe-error-message";
import { base64ToBytes } from "@shared/lib/base64";
import { toErrorMessage } from "@shared/lib/error-utils";

const accountSchema = z.object({ owner: z.string(), executable: z.boolean(), data: z.tuple([z.string().max(100_000), z.literal("base64")]) });
const responseSchema = z.object({ result: z.object({ context: z.object({ slot: z.number().int().positive().safe() }), value: z.array(accountSchema.nullable()).max(100) }) });
export interface SolanaAccount { owner: string; data: Uint8Array; executable?: boolean }
export const SOLANA_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOLANA_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const NO_PROGRAM_ADDRESSES: readonly string[] = [];

/** A single getMultipleAccounts response is atomic at its returned slot. minContextSlot is only a lower bound, never a historical-slot selector. */
async function fetchSolanaAccountCensus(addresses: string[], signal: AbortSignal, ctx: AdapterContext | undefined, minContextSlot: number | undefined, includeBlockTime: boolean, maxResponseBytes: number, programAddresses: readonly string[] = NO_PROGRAM_ADDRESSES) {
  if (addresses.length === 0 || addresses.length > 100 || new Set(addresses).size !== addresses.length) throw new Error("Solana census requires 1–100 unique accounts");
  if (programAddresses.some((address) => !addresses.includes(address))) throw new Error("Solana program witness missing from census");
  const configured = ctx?.chainRpcs?.get("solana");
  const urls = [...new Set([...registryRpcUrls(configured), "https://api.mainnet-beta.solana.com", "https://api.mainnet.solana.com", "https://solana-rpc.publicnode.com"].filter((url): url is string => !!url))];
  let lastError: unknown;
  for (const url of urls) {
    throwIfAborted(signal);
    try {
      const options = { headers: getRpcAuthHeaders(url), maxResponseBytes, maxRetries: 1 };
      const raw = await fetchJsonPostWithRetry<unknown>(url, { jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [addresses, { encoding: "base64", commitment: "finalized", ...(minContextSlot === undefined ? {} : { minContextSlot }) }] }, signal, 10_000, ctx, options);
      const { result } = responseSchema.parse(raw);
      if (result.value.length !== addresses.length || result.context.slot < (minContextSlot ?? 0)) throw new Error("Invalid Solana account census context");
      let timestamp = 0;
      if (includeBlockTime) {
        const timeRaw = await fetchJsonPostWithRetry<unknown>(url, { jsonrpc: "2.0", id: 2, method: "getBlockTime", params: [result.context.slot] }, signal, 10_000, ctx, options);
        timestamp = z.object({ result: z.number().int().positive().safe() }).parse(timeRaw).result;
      }
      const accounts = new Map<string, SolanaAccount | null>();
      result.value.forEach((account, i) => {
        const programWitness = programAddresses.includes(addresses[i]);
        if (account && account.executable !== programWitness) throw new Error("Solana census executable identity mismatch");
        accounts.set(addresses[i], account ? { owner: account.owner, data: base64ToBytes(account.data[0]), ...(programWitness ? { executable: true } : {}) } : null);
      });
      return { accounts, observedBlock: { chain: "solana", number: result.context.slot, timestamp } };
    } catch (error) { lastError = error; }
  }
  throwIfAborted(signal);
  throw new Error(`Solana census failed: ${redactProviderUrls(toErrorMessage(lastError))}`);
}

export async function fetchSolanaAccounts(addresses: string[], signal: AbortSignal, ctx?: AdapterContext, minContextSlot?: number) {
  return fetchSolanaAccountCensus(addresses, signal, ctx, minContextSlot, true, 1_048_576);
}

/** Program witnesses share the exact finalized bank with their state and mint accounts. */
export async function fetchSolanaAccountsWithPrograms(addresses: string[], programAddresses: readonly string[], signal: AbortSignal, ctx?: AdapterContext) {
  return fetchSolanaAccountCensus(addresses, signal, ctx, undefined, true, 1_048_576, programAddresses);
}

/** Quote batches need one atomic bank context, not an additional block-time RPC. */
export async function fetchSolanaAccountBatch(addresses: string[], signal: AbortSignal, ctx?: AdapterContext, minContextSlot?: number) {
  if (addresses.length > 8) throw new Error("Solana quote batch exceeds eight accounts");
  const census = await fetchSolanaAccountCensus(addresses, signal, ctx, minContextSlot, false, 100_000);
  return { accounts: census.accounts, slot: census.observedBlock.number };
}

export function solanaPublicKey(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error("Invalid Solana public key length");
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let result = "";
  while (value > 0n) { result = alphabet[Number(value % 58n)] + result; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = "1" + result; }
  return result;
}

/** Decode mint quantity and the time-selected Token-2022 scaled-UI multiplier. */
export function readSolanaMint(account: SolanaAccount | null | undefined, observedAtSec: number) {
  if (!account || account.executable || (account.owner !== SOLANA_TOKEN_PROGRAM && account.owner !== SOLANA_TOKEN_2022_PROGRAM)) throw new Error("Solana mint token-program identity mismatch");
  const data = account.data;
  if (data.length < 82 || data.length === 355 || data[45] !== 1 || data[44] > 18) throw new Error("Solana mint layout or initialization mismatch");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const authorityTag = view.getUint32(0, true);
  if (authorityTag !== 0 && authorityTag !== 1) throw new Error("Solana mint authority option invalid");
  let multiplier = 1;
  let scaledUi = false;
  if (data.length !== 82) {
    if (account.owner !== SOLANA_TOKEN_2022_PROGRAM || data.length < 166 || data[165] !== 1) throw new Error("Solana mint extension layout mismatch");
    const seen = new Set<number>();
    let cursor = 166;
    while (cursor < data.length) {
      if (data.length - cursor < 2) {
        if (data[cursor] !== 0) throw new Error("Solana mint truncated extension type");
        break;
      }
      const type = view.getUint16(cursor, true);
      if (type === 0) {
        for (let i = cursor; i < data.length; i++) if (data[i] !== 0) throw new Error("Solana mint nonempty extension padding");
        break;
      }
      if (data.length - cursor < 4 || seen.has(type)) throw new Error("Solana mint duplicate or truncated extension");
      seen.add(type);
      const length = view.getUint16(cursor + 2, true);
      cursor += 4;
      if (cursor + length > data.length) throw new Error("Solana mint extension exceeds account");
      // Interest-bearing and confidential supplies need different accounting;
      // raw amounts must not silently become complete visible liabilities.
      if (type === 10 || type === 24) throw new Error("Solana mint unsupported supply accounting");
      if (type === 25) {
        if (length !== 56) throw new Error("Solana scaled-UI extension length mismatch");
        const current = view.getFloat64(cursor + 32, true);
        const effectiveAt = view.getBigInt64(cursor + 40, true);
        const next = view.getFloat64(cursor + 48, true);
        if (!Number.isSafeInteger(observedAtSec) || observedAtSec <= 0 || !Number.isFinite(current) || current <= 0 || !Number.isFinite(next) || next <= 0) throw new Error("Solana scaled-UI multiplier invalid");
        multiplier = BigInt(observedAtSec) >= effectiveAt ? next : current;
        scaledUi = true;
      }
      cursor += length;
    }
  }
  return {
    rawSupply: view.getBigUint64(36, true),
    decimals: data[44],
    mintAuthority: authorityTag === 1 ? solanaPublicKey(data.subarray(4, 36)) : null,
    multiplier,
    scaledUi,
  };
}

/** Match Token-2022's float multiply then truncate, bounded to exact JS integers. */
export function scaledSolanaRawAmount(raw: bigint, multiplier: number): bigint {
  if (raw < 0n || raw > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isFinite(multiplier) || multiplier <= 0) throw new Error("Solana scaled amount is not safely representable");
  const scaled = Math.trunc(Number(raw) * multiplier);
  if (!Number.isSafeInteger(scaled) || scaled < 0) throw new Error("Solana scaled amount exceeds safe precision");
  return BigInt(scaled);
}
