import { canonicalExitRouteScopedKey } from "@shared/lib/exit-route-identity";
import {
  isTezosDiscoveryDeployment,
  TEZOS_UUSD_DISCOVERY_ADDRESS,
} from "@shared/lib/dex-deployment-coverage";
import type { ContractDeployment } from "@shared/types/core";
import { DEX_PRICE_OBSERVATION_MIN_TVL_USD, USER_AGENT } from "../../lib/constants";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { isPlausibleDexObservationPrice } from "../dex-liquidity/price-sanity";
import { DEX_LIQUIDITY_POOL_MIN_TVL_USD } from "../dex-liquidity/constants";
import { buildStageSignal, toStagedPool, type CrawlStageContext } from "./staged-pool";
import type { DexDeploymentProviderCheck, StagedPool } from "./types";

/** Mainnet TzKT endpoint. TzKT's free API requires attribution in product copy. */
const TEZOS_TZKT_API = "https://api.tzkt.io";

const TEZOS_PROVIDER = "tezos";
const TEZOS_POOL_SOURCE = "tezos";

const TEZOS_UUSD_ADDRESS = TEZOS_UUSD_DISCOVERY_ADDRESS;
const TEZOS_UUSD_TOKEN_ID = "0";
const TEZOS_UUSD_DECIMALS = 12;
const TEZOS_REQUEST_TIMEOUT_MS = 8_000;
const TEZOS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TEZOS_TOKEN_BALANCE_PAGE_LIMIT = 10_000;
/** A single account.in query keeps this stage well below URL and request budgets. */
const TEZOS_MAX_ACCOUNT_FILTER_ADDRESSES = 150;

/** Known official Youves pools; discovery still requires that TzKT reports a live uUSD balance. */
const KNOWN_YOUVES_POOL_ADDRESSES: Record<string, true> = {
  KT1JeWiS8j1kic4PHx7aTnEr9p4xVtJNzk5b: true,
  KT1AVbWyM8E7DptyBCu4B5J5B7Nswkq7Skc6: true,
  KT1Xbx9pykNd38zag4yZvnmdSNBknmCETvQV: true,
};

/** Token identities whose metadata is stable enough for a metadata-less row. */
const KNOWN_TEZOS_TOKEN_METADATA: Record<string, { symbol: string; decimals: number }> = {
  "KT18fp5rcTW7mbWDmzFwjLDUhs5MeJmagDSZ:17": { symbol: "wUSDC", decimals: 6 },
  "KT1K9gCRgaLRFKTErYt1wVxA3Frb9FjasjTV:0": { symbol: "kUSD", decimals: 18 },
  "KT1LN4LPSqTMS7Sd2CJw4bbDGRkMv2t68Fy9": { symbol: "USDtz", decimals: 6 },
  "KT1XnTn74bUtxHfDtBmm2bGZAQfhPbvKWR8o:0": { symbol: "USDt", decimals: 6 },
};

const USD_STABLE_SYMBOLS: Record<string, true> = {
  DAI: true,
  KUSD: true,
  MUSD: true,
  USDC: true,
  "USDC.E": true,
  USDCE: true,
  USDT: true,
  USDS: true,
  USDTA: true,
  USDTEZ: true,
  USDTZ: true,
  WUSDC: true,
};

const DEFAULT_USD_STABLE_DECIMALS: Record<string, number> = {
  DAI: 18,
  KUSD: 18,
  MUSD: 18,
  USDC: 6,
  "USDC.E": 6,
  USDCE: 6,
  USDT: 6,
  USDS: 18,
  USDTA: 6,
  USDTEZ: 6,
  USDTZ: 6,
  WUSDC: 6,
};

const EXCLUDED_POOL_LIKE_ALIASES = /reward|saving|vesting|option|engine|intent|lending|farm|fee|treasury|staking/i;
const POOL_LIKE_ALIAS = /swap|pool|flat|dex|amm|stable|liquidity|quipu|plenty|spicy|vortex/i;

export interface TezosPoolsStageResult {
  providerChecks: DexDeploymentProviderCheck[];
  stoppedEarly?: boolean;
}

export interface TezosPoolsStageDependencies {
  fetchJsonWithRetry: typeof fetchJsonWithRetry;
}

const defaultTezosPoolsStageDependencies: TezosPoolsStageDependencies = {
  fetchJsonWithRetry,
};

interface TzktAccount {
  address: string;
  alias?: string;
}

interface ParsedTokenBalance {
  account: TzktAccount;
  tokenAddress: string;
  tokenId: string;
  balance: string;
  symbol: string | null;
  decimals: number | null;
  raw: unknown;
}

interface ReserveGroup {
  account: TzktAccount;
  rows: ParsedTokenBalance[];
}

interface PoolEvaluation {
  pool: StagedPool | null;
  unpriced: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function parseAddress(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseAccount(value: unknown): TzktAccount | null {
  if (typeof value === "string" && value.length > 0) return { address: value };
  const row = asRecord(value);
  if (!row) return null;
  const address = parseAddress(row.address);
  if (!address) return null;
  return {
    address,
    ...(typeof row.alias === "string" && row.alias.trim() ? { alias: row.alias.trim() } : {}),
  };
}

function parsePositiveInteger(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value) > 0n ? value : null;
  } catch {
    return null;
  }
}

function parseDecimals(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 36 ? parsed : null;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\s+/g, "");
}

function knownMetadataForToken(tokenAddress: string, tokenId: string): { symbol: string; decimals: number } | null {
  return KNOWN_TEZOS_TOKEN_METADATA[`${tokenAddress}:${tokenId}`] ?? null;
}

function metadataForToken(
  tokenAddress: string,
  tokenId: string,
  symbol: string | null,
  decimals: number | null,
): {
  symbol: string | null;
  decimals: number | null;
} {
  const known = knownMetadataForToken(tokenAddress, tokenId);
  const resolvedSymbol = symbol ?? known?.symbol ?? null;
  const normalized = resolvedSymbol ? normalizeSymbol(resolvedSymbol) : null;
  return {
    symbol: resolvedSymbol,
    decimals: decimals ?? known?.decimals ?? (normalized ? DEFAULT_USD_STABLE_DECIMALS[normalized] ?? null : null),
  };
}

function parseTokenBalance(value: unknown): ParsedTokenBalance | null {
  const row = asRecord(value);
  if (!row) return null;
  const account = parseAccount(row.account);
  const balance = parsePositiveInteger(row.balance);
  const token = asRecord(row.token);
  const selectedContract = asRecord(row["token.contract"]);
  const contract = asRecord(token?.contract ?? selectedContract);
  const tokenAddress = parseAddress(contract?.address ?? row["token.contract"]);
  const tokenIdValue = token?.tokenId ?? row["token.tokenId"];
  const tokenId = typeof tokenIdValue === "string" || typeof tokenIdValue === "number" ? String(tokenIdValue) : null;
  const metadata = asRecord(token?.metadata ?? row["token.metadata"]);
  const rawSymbol = metadata?.symbol;
  const symbol = typeof rawSymbol === "string" && rawSymbol.trim() ? rawSymbol.trim() : null;
  const decimals = parseDecimals(metadata?.decimals);
  if (!account || !balance || !tokenAddress || tokenId == null) return null;
  const resolvedMetadata = metadataForToken(tokenAddress, tokenId, symbol, decimals);
  return {
    account,
    tokenAddress,
    tokenId,
    balance,
    symbol: resolvedMetadata.symbol,
    decimals: resolvedMetadata.decimals,
    raw: value,
  };
}

function parseHolder(value: unknown): { account: TzktAccount; balance: string } | null {
  const row = asRecord(value);
  if (!row) return null;
  const account = parseAccount(row.account);
  const balance = parsePositiveInteger(row.balance);
  return account && balance ? { account, balance } : null;
}

function isContractAddress(address: string): boolean {
  return address.startsWith("KT1");
}


function isPoolLikeAccount(address: string, alias: string | undefined): boolean {
  if (KNOWN_YOUVES_POOL_ADDRESSES[address]) return true;
  if (!alias || EXCLUDED_POOL_LIKE_ALIASES.test(alias)) return false;
  return /uusd|quipu|plenty|spicy|vortex|flat/i.test(alias) && POOL_LIKE_ALIAS.test(alias);
}
function isUsdStableToken(row: ParsedTokenBalance): boolean {
  if (row.tokenAddress === TEZOS_UUSD_ADDRESS && row.tokenId === TEZOS_UUSD_TOKEN_ID) return false;
  if (knownMetadataForToken(row.tokenAddress, row.tokenId)) return true;
  const normalized = row.symbol ? normalizeSymbol(row.symbol) : "";
  return USD_STABLE_SYMBOLS[normalized] === true;
}

function aliasMentionsSymbol(alias: string | undefined, symbol: string | null): boolean {
  if (!alias || !symbol) return false;
  return alias.toUpperCase().includes(symbol.toUpperCase());
}

function selectStableQuote(rows: readonly ParsedTokenBalance[], alias: string | undefined): ParsedTokenBalance | null {
  const quotes = rows.filter(isUsdStableToken);
  if (quotes.length === 0) return null;
  const aliasQuotes = quotes.filter((quote) => aliasMentionsSymbol(alias, quote.symbol));
  const candidates = aliasQuotes.length > 0 ? aliasQuotes : quotes;
  const known = candidates.find((quote) => knownMetadataForToken(quote.tokenAddress, quote.tokenId));
  if (known) return known;
  return candidates.reduce((largest, quote) => {
    try {
      return BigInt(quote.balance) > BigInt(largest.balance) ? quote : largest;
    } catch {
      return largest;
    }
  });
}

function amountFromRaw(raw: string, decimals: number | null): number | null {
  if (decimals == null) return null;
  const numeric = Number(raw);
  const scale = 10 ** decimals;
  if (!Number.isFinite(numeric) || !Number.isFinite(scale) || scale <= 0) return null;
  const amount = numeric / scale;
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function classifyPoolAlias(alias: string | undefined): {
  protocol: string;
  dexId: string;
  poolType: string;
} {
  const normalized = alias?.toLowerCase() ?? "";
  if (normalized.includes("flatyouves") || normalized.includes("flat")) {
    return { protocol: "youves-flat", dexId: "flatyouves", poolType: "tezos-flat-curve" };
  }
  if (normalized.includes("quipu")) {
    return { protocol: "quipuswap", dexId: "quipuswap", poolType: "tezos-stable-swap" };
  }
  if (normalized.includes("plenty")) {
    return { protocol: "plenty", dexId: "plenty", poolType: "tezos-stable-swap" };
  }
  if (normalized.includes("spicy")) {
    return { protocol: "spicyswap", dexId: "spicyswap", poolType: "tezos-stable-swap" };
  }
  if (normalized.includes("vortex")) {
    return { protocol: "vortex", dexId: "vortex", poolType: "tezos-constant-product" };
  }
  return { protocol: "tezos-amm", dexId: "tezos-amm", poolType: "tezos-stable-swap" };
}

function evaluatePool(
  group: ReserveGroup,
  target: ContractDeployment,
  context: CrawlStageContext,
): PoolEvaluation {
  const alias = group.account.alias;
  if (!isPoolLikeAccount(group.account.address, alias)) return { pool: null, unpriced: false };

  const tracked = group.rows.find(
    (row) => row.tokenAddress === target.address && row.tokenId === TEZOS_UUSD_TOKEN_ID,
  );
  if (!tracked) return { pool: null, unpriced: true };

  const quote = selectStableQuote(group.rows.filter((row) => row !== tracked), alias);
  if (!quote) return { pool: null, unpriced: true };

  const trackedAmount = amountFromRaw(tracked.balance, target.decimals ?? TEZOS_UUSD_DECIMALS);
  const quoteAmount = amountFromRaw(quote.balance, quote.decimals);
  if (trackedAmount == null || quoteAmount == null) return { pool: null, unpriced: true };

  const marketPriceUsd = quoteAmount / trackedAmount;
  const tvlUsd = 2 * Math.min(trackedAmount, quoteAmount);
  if (
    !Number.isFinite(marketPriceUsd) ||
    marketPriceUsd <= 0 ||
    !Number.isFinite(tvlUsd) ||
    tvlUsd <= 0
  ) {
    return { pool: null, unpriced: true };
  }

  // A reserve imbalance can put a market price outside the peg sanity band
  // while the contract is still an observable pool. Keep its census row with a
  // null price and degrade the provider rather than dropping a real venue.
  const priceUsd = isPlausibleDexObservationPrice(context.stablecoinId, marketPriceUsd, context.references)
    ? marketPriceUsd
    : null;

  // The pool is known but below the repository's retained-pool floor. This is
  // intentionally not degraded: both TzKT pages completed and the result is a
  // verified-empty census at the scoring threshold.
  if (tvlUsd < DEX_LIQUIDITY_POOL_MIN_TVL_USD) return { pool: null, unpriced: false };

  const family = classifyPoolAlias(alias);
  const poolId = canonicalExitRouteScopedKey(target.chain, group.account.address);
  const symbol = `uUSD / ${quote.symbol ?? "USD"}`;
  const rawJson = JSON.stringify({
    account: group.account,
    reserves: [tracked.raw, quote.raw],
  });
  const balanceRatio = Math.min(trackedAmount, quoteAmount) / Math.max(trackedAmount, quoteAmount);
  const pool = toStagedPool(context, {
    poolId,
    source: TEZOS_POOL_SOURCE,
    chain: target.chain,
    protocol: family.protocol,
    dexId: family.dexId,
    symbol,
    tvlUsd,
    volume24h: null,
    qualityMultiplier: null,
    poolType: family.poolType,
    feeTier: null,
    balanceRatio: Number.isFinite(balanceRatio) ? balanceRatio : null,
    isStable: true,
    baseToken: target.address,
    quoteToken: quote.tokenAddress,
    quoteSymbol: quote.symbol,
    priceUsd,
    lockedLiqPct: null,
    rawJson,
  });
  return { pool, unpriced: priceUsd == null };
}

function providerCheck(
  target: ContractDeployment,
  status: DexDeploymentProviderCheck["status"],
  observedPoolCount?: number,
  retryable?: boolean,
): DexDeploymentProviderCheck {
  return {
    chain: target.chain,
    address: target.address,
    provider: TEZOS_PROVIDER,
    status,
    ...(observedPoolCount != null ? { observedPoolCount } : {}),
    ...(retryable === true ? { retryable: true } : {}),
  };
}

function buildHolderUrl(target: ContractDeployment): string {
  const url = new URL("/v1/tokens/balances", TEZOS_TZKT_API);
  url.searchParams.set("token.contract", target.address);
  url.searchParams.set("token.tokenId", TEZOS_UUSD_TOKEN_ID);
  url.searchParams.set("balance.gt", "0");
  url.searchParams.set("sort.desc", "balance");
  url.searchParams.set("limit", String(TEZOS_TOKEN_BALANCE_PAGE_LIMIT));
  url.searchParams.set("select", "account,balance");
  return url.toString();
}

function buildReserveUrl(addresses: readonly string[]): string {
  const url = new URL("/v1/tokens/balances", TEZOS_TZKT_API);
  url.searchParams.set("account.in", addresses.join(","));
  url.searchParams.set("balance.gt", "0");
  url.searchParams.set("limit", String(TEZOS_TOKEN_BALANCE_PAGE_LIMIT));
  url.searchParams.set("select", "account,balance,token");
  return url.toString();
}

async function fetchJson(
  url: string,
  context: CrawlStageContext,
  dependencies: TezosPoolsStageDependencies,
): Promise<unknown | null> {
  const result = await dependencies.fetchJsonWithRetry<unknown>(
    url,
    {
      headers: { "User-Agent": USER_AGENT },
      signal: buildStageSignal(context.signal, context.deadlineMs, TEZOS_REQUEST_TIMEOUT_MS),
    },
    0,
    {
      timeoutMs: TEZOS_REQUEST_TIMEOUT_MS,
      maxResponseBytes: TEZOS_MAX_RESPONSE_BYTES,
    },
  );
  return result?.body ?? null;
}

/**
 * Tezos uUSD census using two TzKT reads:
 *  1. enumerate all positive uUSD holders and retain originated accounts;
 *  2. read every token reserve held by those accounts at the current indexed head.
 *
 * The second response is intentionally used as the reserve source rather than a
 * TVL aggregator. Unknown/non-USD quote assets are degraded, never treated as
 * empty. The two requests stay well inside the six-connection trigger budget.
 */
export async function crawlTezosPoolsStage(input: {
  coinTargets: ContractDeployment[];
  context: CrawlStageContext;
  dependencies?: TezosPoolsStageDependencies;
}): Promise<TezosPoolsStageResult> {
  const dependencies = input.dependencies ?? defaultTezosPoolsStageDependencies;
  const targets = input.coinTargets.filter(
    (target) => isTezosDiscoveryDeployment(target.chain, target.address),
  );
  if (targets.length === 0 || input.context.timeExceeded()) return { providerChecks: [] };

  const target = targets[0]!;
  const providerChecks: DexDeploymentProviderCheck[] = [];
  let holders: unknown[];
  try {
    const holderBody = await fetchJson(buildHolderUrl(target), input.context, dependencies);
    if (!Array.isArray(holderBody)) {
      providerChecks.push(providerCheck(target, "failure", undefined, holderBody == null));
      return { providerChecks };
    }
    holders = holderBody;
  } catch (error) {
    if (input.context.signal?.aborted) throw error;
    providerChecks.push(providerCheck(target, "failure", undefined, true));
    return { providerChecks };
  }

  if (input.context.timeExceeded()) return { providerChecks, stoppedEarly: true };

  const parsedHolders: Array<{ account: TzktAccount; balance: string }> = [];
  for (const row of holders) {
    const parsed = parseHolder(row);
    if (!parsed) {
      providerChecks.push(providerCheck(target, "failure"));
      return { providerChecks };
    }
    parsedHolders.push(parsed);
  }

  const holderPageTruncated = holders.length >= TEZOS_TOKEN_BALANCE_PAGE_LIMIT;
  const uniqueContracts = new Map<string, TzktAccount>();
  for (const holder of parsedHolders) {
    if (isContractAddress(holder.account.address)) uniqueContracts.set(holder.account.address, holder.account);
  }

  // Keep known official pools in the filter first if the holder page ever grows
  // beyond the URL-safe cap; truncation remains degraded rather than empty.
  const orderedAddresses = [
    ...Object.keys(KNOWN_YOUVES_POOL_ADDRESSES).filter((address) => uniqueContracts.has(address)),
    ...[...uniqueContracts.keys()].filter((address) => !KNOWN_YOUVES_POOL_ADDRESSES[address]),
  ];
  const reserveAddresses = orderedAddresses.slice(0, TEZOS_MAX_ACCOUNT_FILTER_ADDRESSES);
  const accountFilterTruncated = reserveAddresses.length < orderedAddresses.length;

  if (reserveAddresses.length === 0) {
    providerChecks.push(providerCheck(target, holderPageTruncated ? "degraded" : "success", 0));
    return { providerChecks };
  }

  let reserves: unknown[];
  try {
    const reserveBody = await fetchJson(buildReserveUrl(reserveAddresses), input.context, dependencies);
    if (!Array.isArray(reserveBody)) {
      providerChecks.push(providerCheck(target, "failure", undefined, reserveBody == null));
      return { providerChecks };
    }
    reserves = reserveBody;
  } catch (error) {
    if (input.context.signal?.aborted) throw error;
    providerChecks.push(providerCheck(target, "failure", undefined, true));
    return { providerChecks };
  }

  const groups = new Map<string, ReserveGroup>();
  for (const row of reserves) {
    const parsed = parseTokenBalance(row);
    if (!parsed || !uniqueContracts.has(parsed.account.address)) {
      providerChecks.push(providerCheck(target, "failure"));
      return { providerChecks };
    }
    const holderAccount = uniqueContracts.get(parsed.account.address)!;
    const group = groups.get(parsed.account.address) ?? {
      account: {
        ...holderAccount,
        ...(parsed.account.alias ? { alias: parsed.account.alias } : {}),
      },
      rows: [],
    };
    if (!group.account.alias && parsed.account.alias) group.account.alias = parsed.account.alias;
    group.rows.push(parsed);
    groups.set(parsed.account.address, group);
  }

  let observedPoolCount = 0;
  let unpricedPoolCount = 0;
  let unclassifiedContractCount = 0;
  for (const [address, account] of uniqueContracts) {
    if (!account.alias && !KNOWN_YOUVES_POOL_ADDRESSES[address]) unclassifiedContractCount++;
    if (!groups.has(address) && isPoolLikeAccount(address, account.alias)) unpricedPoolCount++;
  }
  for (const group of groups.values()) {
    const evaluation = evaluatePool(group, target, input.context);
    if (evaluation.unpriced) unpricedPoolCount++;
    if (!evaluation.pool) continue;
    observedPoolCount++;
    if (!input.context.hasKnownPool(evaluation.pool.poolId)) {
      input.context.addPool(evaluation.pool);
    }
    if (
      evaluation.pool.priceUsd != null &&
      evaluation.pool.tvlUsd != null &&
      evaluation.pool.tvlUsd >= DEX_PRICE_OBSERVATION_MIN_TVL_USD
    ) {
      input.context.addPriceObs({
        stablecoinId: input.context.stablecoinId,
        price: evaluation.pool.priceUsd,
        tvl: evaluation.pool.tvlUsd,
        chain: target.chain,
        protocol: evaluation.pool.dexId ?? evaluation.pool.protocol,
      });
    }
  }

  const reservePageTruncated = reserves.length >= TEZOS_TOKEN_BALANCE_PAGE_LIMIT;
  const degraded =
    holderPageTruncated ||
    reservePageTruncated ||
    accountFilterTruncated ||
    unpricedPoolCount > 0 ||
    unclassifiedContractCount > 0;
  providerChecks.push(providerCheck(target, degraded ? "degraded" : "success", observedPoolCount));
  return { providerChecks };
}
