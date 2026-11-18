import { CHAIN_META } from "../types/chain-identity";
import { canonicalEvmAddress } from "./evm-address";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Validate the canonical key emitted for a verified physical price-forming pool. */
export function isCanonicalPricePoolKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const separator = value.indexOf(":");
  if (separator <= 0) return false;
  const chain = value.slice(0, separator);
  if (!Object.prototype.hasOwnProperty.call(CHAIN_META, chain)) return false;

  const pool = value.slice(separator + 1);
  const { type } = CHAIN_META[chain];
  // Uniswap V4 identifies pools by a bytes32 PoolId rather than a contract address.
  if (type === "evm" && /^0x[0-9a-f]{64}$/.test(pool)) return !/^0x0{64}$/.test(pool);
  if (type === "evm" || type === "tron") return canonicalEvmAddress(pool, { allowZero: false }) === pool;
  if (chain === "sui") return /^0x[0-9a-f]{64}$/.test(pool) && !/^0x0{64}$/.test(pool);
  if (chain !== "solana" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool)) return false;

  let decoded = 0n;
  for (const char of pool) decoded = decoded * 58n + BigInt(BASE58_ALPHABET.indexOf(char));
  const leadingZeroBytes = pool.match(/^1*/)?.[0].length ?? 0;
  return decoded > 0n && leadingZeroBytes + Math.ceil(decoded.toString(16).length / 2) === 32;
}
