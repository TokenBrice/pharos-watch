import { z } from "zod";
import { STELLAR_HORIZON_API } from "../../../lib/constants";
import { fetchJsonPostWithRetry, fetchJsonWithRetry } from "../../reserve-adapters/request";

const STELLAR_RPC = "https://soroban-rpc.mainnet.stellar.gateway.fm";
const BOUNDED_READ = { maxRetries: 0, maxResponseBytes: 64 * 1024 };
const AmountSchema = z.string().regex(/^\d{1,19}\.\d{7}$/);
const AssetResponseSchema = z.object({ _embedded: z.object({ records: z.array(z.object({
  asset_code: z.string(), asset_issuer: z.string(),
  balances: z.object({ authorized: AmountSchema, authorized_to_maintain_liabilities: AmountSchema, unauthorized: AmountSchema }),
  claimable_balances_amount: AmountSchema, liquidity_pools_amount: AmountSchema, contracts_amount: AmountSchema,
})).length(1) }) });
const SimulationSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.literal(1), result: z.object({
  latestLedger: z.number().int().positive(), results: z.array(z.object({ xdr: z.string(), auth: z.array(z.unknown()).length(0) })).length(1),
  error: z.never().optional(), restorePreamble: z.never().optional(),
}), error: z.never().optional() });

function strKeyBytes(address: string, version: number): Uint8Array {
  if (!/^[GC][A-Z2-7]{55}$/.test(address)) throw new Error("stellar-invalid-strkey");
  const bytes: number[] = [];
  let bits = 0, value = 0;
  for (const char of address) {
    value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  let crc = 0;
  for (const byte of bytes.slice(0, 33)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  if (bytes.length !== 35 || bytes[0] !== version || bytes[33] !== (crc & 255) || bytes[34] !== crc >>> 8) {
    throw new Error("stellar-invalid-strkey-checksum");
  }
  return Uint8Array.from(bytes.slice(1, 33));
}

/** Unsigned, zero-source TransactionEnvelope v1 with one argument-free read.
 * Only simulateTransaction consumes it; it is never signed or submitted. */
function readEnvelope(contract: Uint8Array, method: "total_supply" | "decimals"): string {
  const bytes: number[] = [];
  const u32 = (n: number) => bytes.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  u32(2); u32(0); bytes.push(...new Uint8Array(32)); // Envelope TX, ed25519 source.
  u32(100); u32(0); u32(1); u32(0); u32(0); // Fee, sequence, no preconditions/memo.
  u32(1); u32(0); u32(24); u32(0); u32(1); bytes.push(...contract); // InvokeContract.
  u32(method.length); bytes.push(...new TextEncoder().encode(method));
  while (bytes.length % 4) bytes.push(0);
  u32(0); u32(0); u32(0); u32(0); // No args, authorizations, extension or signatures.
  return btoa(String.fromCharCode(...bytes));
}

function readScVal(encoded: string, type: 3 | 10): bigint {
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  if (bytes.length !== (type === 3 ? 8 : 20) || view.getUint32(0) !== type) throw new Error("stellar-invalid-scval");
  if (type === 3) return BigInt(view.getUint32(4));
  const raw = (view.getBigInt64(4) << 64n) + view.getBigUint64(12);
  if (raw < 0n) throw new Error("stellar-negative-supply");
  return raw;
}

export async function fetchStellarSupply(address: string, decimals: number, signal: AbortSignal): Promise<bigint> {
  const classic = /^([a-zA-Z0-9]{1,12})-(G[A-Z2-7]{55})$/.exec(address);
  if (classic) {
    const [, code, issuer] = classic;
    strKeyBytes(issuer, 48);
    if (decimals !== 7) throw new Error("stellar-classic-decimals-mismatch");
    const query = new URLSearchParams({ asset_code: code, asset_issuer: issuer, limit: "2" });
    const response = await fetchJsonWithRetry<unknown>(`${STELLAR_HORIZON_API}/assets?${query}`, signal, 10_000, undefined, BOUNDED_READ);
    const [asset] = AssetResponseSchema.parse(response)._embedded.records;
    if (asset.asset_code !== code || asset.asset_issuer !== issuer) throw new Error("stellar-asset-identity-mismatch");
    // Disjoint Horizon custody buckets; do not add the deprecated amount field.
    return [...Object.values(asset.balances), asset.claimable_balances_amount, asset.liquidity_pools_amount, asset.contracts_amount]
      .reduce((sum, amount) => sum + BigInt(amount.replace(".", "")), 0n);
  }
  const contract = address.slice(address.lastIndexOf("-") + 1);
  const contractBytes = strKeyBytes(contract, 16);
  const simulate = async (method: "total_supply" | "decimals") => SimulationSchema.parse(await fetchJsonPostWithRetry<unknown>(
    STELLAR_RPC, { jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: { transaction: readEnvelope(contractBytes, method) } },
    signal, 10_000, undefined, BOUNDED_READ,
  )).result;
  const scale = await simulate("decimals");
  if (readScVal(scale.results[0].xdr, 3) !== BigInt(decimals)) throw new Error("stellar-contract-decimals-mismatch");
  const supply = await simulate("total_supply");
  if (supply.latestLedger < scale.latestLedger) throw new Error("stellar-ledger-regressed");
  return readScVal(supply.results[0].xdr, 10);
}
