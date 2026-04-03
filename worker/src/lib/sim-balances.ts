import { resolveTrackedTreasuryStablecoin } from "@shared/lib/treasury-stable-exposure";
import { fetchWithRetry } from "./fetch-retry";
import {
  SIM_BALANCES_BASE_URL,
  SIM_DEFI_POSITIONS_BASE_URL,
  SIM_BALANCES_MAX_RETRIES,
  SIM_BALANCES_REQUEST_TIMEOUT_MS,
  USER_AGENT,
} from "./constants";

interface SimWarning {
  message?: string;
}

interface SimBalanceRecord {
  chain_id?: number;
  address?: string;
  value_usd?: number;
}

interface SimBalancesResponse {
  balances?: SimBalanceRecord[];
  warnings?: SimWarning[];
  next_offset?: string;
}

interface SimDefiPositionTokenRef {
  address?: string;
  price_usd?: number;
  holdings?: number;
}

interface SimDefiPositionRangeLeg {
  holdings?: number;
  price_usd?: number;
}

interface SimDefiPositionRange {
  token0?: SimDefiPositionRangeLeg;
  token1?: SimDefiPositionRangeLeg;
}

interface SimDefiPositionSupply {
  value_usd?: number;
}

interface SimDefiPositionRecord {
  chain_id?: number;
  value_usd?: number;
  token?: SimDefiPositionTokenRef;
  underlying_token?: SimDefiPositionTokenRef;
  loan_token?: SimDefiPositionTokenRef;
  asset?: SimDefiPositionTokenRef;
  token0?: SimDefiPositionTokenRef;
  token1?: SimDefiPositionTokenRef;
  positions?: SimDefiPositionRange[];
  supply?: SimDefiPositionSupply;
}

interface SimDefiPositionsResponse {
  positions?: SimDefiPositionRecord[];
  warnings?: SimWarning[];
}

export interface SimWalletBalance {
  chainId: number;
  tokenAddress: string;
  usdValue: number;
}

export interface SimDerivedStableBalance extends SimWalletBalance {
  consumedBalanceKeys?: string[];
}

export interface SimWalletBalancesResult {
  balances: SimWalletBalance[];
  warnings: string[];
}

export interface SimWalletDefiStableBalancesResult {
  balances: SimDerivedStableBalance[];
  warnings: string[];
}

interface FetchSimWalletBalancesOptions {
  apiKey: string;
  address: string;
  chainIds: number[];
  stablecoinOnly?: boolean;
  signal?: AbortSignal;
}

function buildBalancesUrl(address: string, chainIds: number[], stablecoinOnly: boolean, offset?: string): string {
  const params = new URLSearchParams({
    chain_ids: chainIds.join(","),
    exclude_spam_tokens: "true",
    limit: "1000",
  });
  if (stablecoinOnly) params.set("asset_class", "stablecoin");
  if (offset) params.set("offset", offset);
  return `${SIM_BALANCES_BASE_URL}/${address}?${params.toString()}`;
}

function buildDefiPositionsUrl(address: string, chainIds: number[]): string {
  const params = new URLSearchParams({
    chain_ids: chainIds.join(","),
  });
  return `${SIM_DEFI_POSITIONS_BASE_URL}/${address}?${params.toString()}`;
}

function buildBalanceKey(chainId: number, tokenAddress: string): string {
  return `${chainId}:${tokenAddress.toLowerCase()}`;
}

function normalizeBalance(record: SimBalanceRecord): SimWalletBalance | null {
  if (
    !Number.isFinite(record.chain_id)
    || typeof record.address !== "string"
    || !Number.isFinite(record.value_usd)
  ) {
    return null;
  }
  return {
    chainId: record.chain_id!,
    tokenAddress: record.address,
    usdValue: record.value_usd!,
  };
}

function getPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeTrackedStableBalance(
  chainId: number,
  tokenAddress: string | undefined,
  usdValue: number | null,
  consumedTokenAddress?: string,
): SimDerivedStableBalance | null {
  if (!tokenAddress || usdValue == null || !resolveTrackedTreasuryStablecoin(chainId, tokenAddress)) {
    return null;
  }

  return {
    chainId,
    tokenAddress,
    usdValue,
    consumedBalanceKeys: consumedTokenAddress ? [buildBalanceKey(chainId, consumedTokenAddress)] : undefined,
  };
}

function extractPairLegUsd(
  outerToken: SimDefiPositionTokenRef | undefined,
  rangeLeg: SimDefiPositionRangeLeg | SimDefiPositionTokenRef | undefined,
): number | null {
  const holdings = getPositiveNumber(rangeLeg?.holdings);
  const priceUsd = getPositiveNumber(rangeLeg?.price_usd) ?? getPositiveNumber(outerToken?.price_usd);
  if (holdings == null || priceUsd == null) return null;
  return holdings * priceUsd;
}

export function extractTrackedStableBalancesFromSimDefiPosition(
  position: SimDefiPositionRecord,
): SimDerivedStableBalance[] {
  const chainId = getPositiveNumber(position.chain_id);
  if (chainId == null) return [];

  const balances: SimDerivedStableBalance[] = [];
  const consumedTokenAddress = position.token?.address;

  const directUnderlyingCandidates = [
    {
      tokenAddress: position.underlying_token?.address,
      usdValue: getPositiveNumber(position.supply?.value_usd) ?? getPositiveNumber(position.value_usd),
    },
    {
      tokenAddress: position.loan_token?.address,
      usdValue: getPositiveNumber(position.supply?.value_usd) ?? getPositiveNumber(position.value_usd),
    },
    {
      tokenAddress: position.asset?.address,
      usdValue: getPositiveNumber(position.value_usd),
    },
  ];

  for (const candidate of directUnderlyingCandidates) {
    const normalized = normalizeTrackedStableBalance(
      chainId,
      candidate.tokenAddress,
      candidate.usdValue,
      consumedTokenAddress,
    );
    if (normalized) {
      balances.push(normalized);
      break;
    }
  }

  const ranges = Array.isArray(position.positions) && position.positions.length > 0
    ? position.positions
    : [{ token0: position.token0, token1: position.token1 }];

  for (const range of ranges) {
    const token0Balance = normalizeTrackedStableBalance(
      chainId,
      position.token0?.address,
      extractPairLegUsd(position.token0, range.token0),
      consumedTokenAddress,
    );
    if (token0Balance) balances.push(token0Balance);

    const token1Balance = normalizeTrackedStableBalance(
      chainId,
      position.token1?.address,
      extractPairLegUsd(position.token1, range.token1),
      consumedTokenAddress,
    );
    if (token1Balance) balances.push(token1Balance);
  }

  return balances;
}

export async function fetchSimWalletBalances({
  apiKey,
  address,
  chainIds,
  stablecoinOnly = false,
  signal,
}: FetchSimWalletBalancesOptions): Promise<SimWalletBalancesResult> {
  const balances: SimWalletBalance[] = [];
  const warnings: string[] = [];
  let offset: string | undefined;

  do {
    const response = await fetchWithRetry(
      buildBalancesUrl(address, chainIds, stablecoinOnly, offset),
      {
        headers: {
          "X-Sim-Api-Key": apiKey,
          "User-Agent": USER_AGENT,
        },
        signal,
      },
      SIM_BALANCES_MAX_RETRIES,
      { timeoutMs: SIM_BALANCES_REQUEST_TIMEOUT_MS },
    );

    if (!response) {
      throw new Error(`Sim balances request failed for ${address}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Sim balances request returned ${response.status} for ${address}`);
    }

    const json = await response.json() as SimBalancesResponse;
    for (const warning of json.warnings ?? []) {
      if (warning.message) warnings.push(warning.message);
    }
    for (const record of json.balances ?? []) {
      const normalized = normalizeBalance(record);
      if (normalized) balances.push(normalized);
    }
    offset = json.next_offset || undefined;
  } while (offset);

  return { balances, warnings };
}

export async function fetchSimWalletDefiStableBalances({
  apiKey,
  address,
  chainIds,
  signal,
}: Omit<FetchSimWalletBalancesOptions, "stablecoinOnly">): Promise<SimWalletDefiStableBalancesResult> {
  const response = await fetchWithRetry(
    buildDefiPositionsUrl(address, chainIds),
    {
      headers: {
        "X-Sim-Api-Key": apiKey,
        "User-Agent": USER_AGENT,
      },
      signal,
    },
    SIM_BALANCES_MAX_RETRIES,
    { timeoutMs: SIM_BALANCES_REQUEST_TIMEOUT_MS },
  );

  if (!response) {
    throw new Error(`Sim DeFi positions request failed for ${address}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Sim DeFi positions request returned ${response.status} for ${address}`);
  }

  const json = await response.json() as SimDefiPositionsResponse;
  const warnings: string[] = [];
  for (const warning of json.warnings ?? []) {
    if (warning.message) warnings.push(warning.message);
  }

  const balances = (json.positions ?? []).flatMap(extractTrackedStableBalancesFromSimDefiPosition);
  return { balances, warnings };
}
