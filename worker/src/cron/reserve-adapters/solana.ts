import { z } from "zod";
import type { AdapterContext } from "./types";
import { fetchJsonPostWithRetry } from "./request";
import { getAlchemyAuthHeaders } from "../../lib/chain-registry";
import { throwIfAborted } from "../../lib/abort";
import { redactProviderUrls } from "../../lib/safe-error-message";
import { toErrorMessage } from "@shared/lib/error-utils";

const accountSchema = z.object({ owner: z.string(), executable: z.boolean(), data: z.tuple([z.string().max(100_000), z.literal("base64")]) });
const responseSchema = z.object({ result: z.object({ context: z.object({ slot: z.number().int().positive().safe() }), value: z.array(accountSchema.nullable()).max(100) }) });
export interface SolanaAccount { owner: string; data: Uint8Array }

/** A single getMultipleAccounts response is atomic at its returned slot. minContextSlot is only a lower bound, never a historical-slot selector. */
export async function fetchSolanaAccounts(addresses: string[], signal: AbortSignal, ctx?: AdapterContext, minContextSlot?: number) {
  if (addresses.length === 0 || addresses.length > 100 || new Set(addresses).size !== addresses.length) throw new Error("Solana census requires 1–100 unique accounts");
  const configured = ctx?.chainRpcs?.get("solana");
  const urls = [...new Set([configured?.rpcUrl, configured?.fallbackRpcUrl, "https://api.mainnet-beta.solana.com", "https://api.mainnet.solana.com", "https://solana-rpc.publicnode.com"].filter((url): url is string => !!url))];
  let lastError: unknown;
  for (const url of urls) {
    throwIfAborted(signal);
    try {
      const options = { headers: getAlchemyAuthHeaders(url), maxResponseBytes: 1_048_576, maxRetries: 1 };
      const raw = await fetchJsonPostWithRetry<unknown>(url, { jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [addresses, { encoding: "base64", commitment: "finalized", ...(minContextSlot === undefined ? {} : { minContextSlot }) }] }, signal, 10_000, ctx, options);
      const { result } = responseSchema.parse(raw);
      if (result.value.length !== addresses.length || result.context.slot < (minContextSlot ?? 0)) throw new Error("Invalid Solana account census context");
      const timeRaw = await fetchJsonPostWithRetry<unknown>(url, { jsonrpc: "2.0", id: 2, method: "getBlockTime", params: [result.context.slot] }, signal, 10_000, ctx, options);
      const timestamp = z.object({ result: z.number().int().positive().safe() }).parse(timeRaw).result;
      const accounts = new Map<string, SolanaAccount | null>();
      result.value.forEach((account, i) => {
        if (account?.executable) throw new Error("Executable account in Solana reserve census");
        accounts.set(addresses[i], account ? { owner: account.owner, data: Uint8Array.from(atob(account.data[0]), (c) => c.charCodeAt(0)) } : null);
      });
      return { accounts, observedBlock: { chain: "solana", number: result.context.slot, timestamp } };
    } catch (error) { lastError = error; }
  }
  throwIfAborted(signal);
  throw new Error(`Solana census failed: ${redactProviderUrls(toErrorMessage(lastError))}`);
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
