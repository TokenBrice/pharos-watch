import { CHAIN_META, resolveChainId } from "../types/chain-identity";

const COMMON_CHAIN_ALIASES: Readonly<Record<string, string>> = {
  eth: "ethereum",
  arb: "arbitrum",
  op: "optimism",
  matic: "polygon",
  avax: "avalanche",
  bnb: "bsc",
  xdai: "gnosis",
  ftm: "fantom",
  sol: "solana",
  trx: "tron",
};

const MOVE_CHAINS = new Set(["sui", "iota", "aptos", "movement", "initia"]);
const PEGGY_HYBRID_CHAINS = new Set(["injective", "mantra"]);
const PURE_HEX_NON_EVM_CHAINS = new Set(["hyperliquid", "hydration", "cardano", "liquid", "icon", "havah"]);

const EVM_HEX_40_RE = /^0x[0-9a-fA-F]{40}$/;
const STARKNET_HEX_RE = /^0x([0-9a-fA-F]{1,64})$/;
const MOVE_ACCOUNT_HEX_RE = /^0x([0-9a-fA-F]{1,64})$/;

/** Split a Move address or type tag ("0x2::usdc::USDC") into its account hex and optional "::" suffix. */
function matchMoveAddress(raw: string): [string, string, string | undefined] | null {
  const sep = raw.indexOf("::");
  const account = sep === -1 ? raw : raw.slice(0, sep);
  const suffix = sep === -1 ? undefined : raw.slice(sep);
  if (suffix !== undefined && suffix.length <= 2) return null;
  const match = account.match(MOVE_ACCOUNT_HEX_RE);
  return match ? [raw, match[1], suffix] : null;
}
const PEGGY_HEX_RE = /^peggy(0x[0-9a-fA-F]{40})$/i;
const PURE_HEX_NON_EVM_RE = /^(?:0x|cx)?[0-9a-fA-F]+$/;
// XRPL issued currencies are stored as "<code>.<issuer>" or "<code>-<issuer>",
// with the code either as 40-char hex or as a 3+ character ticker.
const XRPL_ASSET_RE = /^([0-9A-Za-z]{3,40})[.:-](r[1-9A-HJ-NP-Za-km-z]{24,34})$/;
const XRPL_HEX_CURRENCY_RE = /^[0-9a-fA-F]{40}$/;
// Stellar assets: "<code>-<issuer>" (stored) or the standard "<code>:<issuer>".
const STELLAR_ASSET_RE = /^([A-Za-z0-9]{1,12})[:-](G[A-Z2-7]{55})$/;
// Hedera "long-zero" EVM alias of a native 0.0.<num> entity.
const HEDERA_LONG_ZERO_RE = /^0x0{24}([0-9a-fA-F]{16})$/;
const CAIP2_EVM_RE = /^eip155:(0|[1-9]\d*)$/i;
const DECIMAL_INT_RE = /^(0|[1-9]\d*)$/;

/** XRPL currency codes longer than 3 characters are carried on-ledger as 40-char hex (ASCII, zero-padded). */
function normalizeXrplCurrency(code: string): string {
  if (XRPL_HEX_CURRENCY_RE.test(code)) {
    const upper = code.toUpperCase();
    // Standard 3-character codes in their 160-bit form decode back to the ticker.
    const standard = upper.match(/^0{24}([0-9A-F]{6})0{10}$/);
    if (standard) {
      const ticker = String.fromCharCode(...(standard[1].match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
      if (/^[0-9A-Za-z]{3}$/.test(ticker)) return ticker;
    }
    return upper;
  }
  if (code.length === 3) return code;
  const bytes = new TextEncoder().encode(code);
  if (bytes.length > 20) return code;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").padEnd(40, "0").toUpperCase();
}

function normalizeXrplAsset(raw: string): string | null {
  const match = raw.match(XRPL_ASSET_RE);
  return match ? `${normalizeXrplCurrency(match[1])}.${match[2]}` : null;
}

function normalizeStellarAsset(raw: string): string | null {
  const match = raw.match(STELLAR_ASSET_RE);
  return match ? `${match[1]}-${match[2]}` : null;
}

function normalizeHederaAddress(raw: string): string {
  const longZero = raw.match(HEDERA_LONG_ZERO_RE);
  if (longZero) return `0.0.${BigInt(`0x${longZero[1]}`).toString()}`;
  return EVM_HEX_40_RE.test(raw) ? raw.toLowerCase() : raw;
}

/**
 * Resolve a chain identifier, display name, DefiLlama alias, common ticker
 * alias, numeric EVM chain ID, or CAIP-2 `eip155:<id>` string to its canonical
 * `CHAIN_META` key, or `null` when unrecognized.
 */
export function resolveDeploymentChainId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const caipMatch = trimmed.match(CAIP2_EVM_RE);
  if (caipMatch) {
    const chainNum = Number(caipMatch[1]);
    return Number.isSafeInteger(chainNum) ? resolveChainId(chainNum) : null;
  }

  if (DECIMAL_INT_RE.test(trimmed)) {
    const chainNum = Number(trimmed);
    return Number.isSafeInteger(chainNum) ? resolveChainId(chainNum) : null;
  }

  const lower = trimmed.toLowerCase();
  const commonAlias = COMMON_CHAIN_ALIASES[lower];
  if (commonAlias) return commonAlias;

  return resolveChainId(trimmed);
}

/**
 * Normalize a deployment address according to its chain family so lookups unify
 * checksummed EVM, unpadded Starknet/Move hex, Hedera EVM aliases, Injective/Mantra
 * peggy addresses, pure-hex non-EVM IDs, and XRPL hex currencies while preserving
 * exact case on Base58/Bech32/native-denom chains.
 */
export function normalizeDeploymentAddress(chainId: string, rawAddress: string): string {
  const trimmed = rawAddress.trim();
  if (!trimmed) return "";

  const meta = CHAIN_META[chainId];
  if (meta?.type === "evm") {
    return EVM_HEX_40_RE.test(trimmed) ? trimmed.toLowerCase() : trimmed;
  }

  if (chainId === "starknet") {
    const match = trimmed.match(STARKNET_HEX_RE);
    return match ? `0x${match[1].toLowerCase().padStart(64, "0")}` : trimmed;
  }

  if (MOVE_CHAINS.has(chainId)) {
    const match = matchMoveAddress(trimmed);
    if (!match) return trimmed;
    const suffix = match[2] ?? "";
    return `0x${match[1].toLowerCase().padStart(64, "0")}${suffix}`;
  }

  if (chainId === "hedera") {
    return normalizeHederaAddress(trimmed);
  }

  if (PEGGY_HYBRID_CHAINS.has(chainId)) {
    if (EVM_HEX_40_RE.test(trimmed)) return trimmed.toLowerCase();
    const peggyMatch = trimmed.match(PEGGY_HEX_RE);
    if (peggyMatch) return `peggy${peggyMatch[1].toLowerCase()}`;
    return trimmed;
  }

  if (PURE_HEX_NON_EVM_CHAINS.has(chainId)) {
    return PURE_HEX_NON_EVM_RE.test(trimmed) ? trimmed.toLowerCase() : trimmed;
  }

  if (chainId === "xrpl") {
    return normalizeXrplAsset(trimmed) ?? trimmed;
  }

  if (chainId === "stellar") {
    return normalizeStellarAsset(trimmed) ?? trimmed;
  }

  return trimmed;
}

/**
 * Produce candidate normalized address keys for a chainless `?address=` query.
 * Preserves case-sensitivity for Base58/Bech32/non-hex chains while unifying
 * checksummed hex, padded Starknet/Move hex, peggy0x, and XRPL hex prefixes.
 */
export function normalizeAddressForChainlessLookup(rawAddress: string): string[] {
  const trimmed = rawAddress.trim();
  if (!trimmed) return [];

  const keys = new Set<string>([trimmed]);

  if (EVM_HEX_40_RE.test(trimmed)) {
    keys.add(trimmed.toLowerCase());
  }

  const starknetMatch = trimmed.match(STARKNET_HEX_RE);
  if (starknetMatch) {
    keys.add(trimmed.toLowerCase());
    keys.add(`0x${starknetMatch[1].toLowerCase().padStart(64, "0")}`);
  }

  const moveMatch = matchMoveAddress(trimmed);
  if (moveMatch && moveMatch[2]) {
    keys.add(`0x${moveMatch[1].toLowerCase().padStart(64, "0")}${moveMatch[2]}`);
  }

  const peggyMatch = trimmed.match(PEGGY_HEX_RE);
  if (peggyMatch) {
    keys.add(`peggy${peggyMatch[1].toLowerCase()}`);
  }

  const xrplAsset = normalizeXrplAsset(trimmed);
  if (xrplAsset) keys.add(xrplAsset);

  const stellarAsset = normalizeStellarAsset(trimmed);
  if (stellarAsset) keys.add(stellarAsset);

  if (HEDERA_LONG_ZERO_RE.test(trimmed)) keys.add(normalizeHederaAddress(trimmed));

  if (PURE_HEX_NON_EVM_RE.test(trimmed)) {
    keys.add(trimmed.toLowerCase());
  }

  return [...keys];
}

/**
 * Parse a `chain:address` contract tuple, splitting only on the first colon so
 * Move type tags (`sui:0x...::usdc::USDC`) and CAIP-2 prefixes (`eip155:1:0x...`)
 * both parse unambiguously.
 */
export function parseContractTuple(raw: string): { rawChain: string; rawAddress: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^eip155:/i.test(trimmed)) {
    const secondColon = trimmed.indexOf(":", 7);
    if (secondColon <= 7 || secondColon === trimmed.length - 1) return null;
    const rawChain = trimmed.slice(0, secondColon).trim();
    const rawAddress = trimmed.slice(secondColon + 1).trim();
    return rawChain && rawAddress ? { rawChain, rawAddress } : null;
  }

  const sep = trimmed.indexOf(":");
  if (sep <= 0 || sep === trimmed.length - 1) return null;
  const rawChain = trimmed.slice(0, sep).trim();
  const rawAddress = trimmed.slice(sep + 1).trim();
  return rawChain && rawAddress ? { rawChain, rawAddress } : null;
}
