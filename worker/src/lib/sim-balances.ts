import { resolveTrackedTreasuryStablecoin } from "@shared/lib/treasury-stable-exposure";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { TreasuryBalanceToken, TreasuryDerivedPosition } from "@shared/lib/treasury-stable-exposure";
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
  symbol?: string;
  name?: string;
  asset_class?: string;
  is_stablecoin?: boolean;
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

const KNOWN_STABLE_SYMBOLS = new Set(
  ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.symbol.trim().toUpperCase()),
);
const KNOWN_STABLE_NAMES = new Set(
  ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.name.trim().toLowerCase()),
);

export type SimWalletBalance = TreasuryBalanceToken;

export interface SimWalletBalancesResult {
  balances: SimWalletBalance[];
  warnings: string[];
}

export interface SimWalletDefiTreasuryPositionsResult {
  positions: TreasuryDerivedPosition[];
  warnings: string[];
}

interface FetchSimWalletBalancesOptions {
  apiKey: string;
  address: string;
  chainIds: number[];
  stablecoinOnly?: boolean;
  signal?: AbortSignal;
}

interface StableCandidateAssessment {
  stableLeg: TreasuryBalanceToken | null;
  stableLike: boolean;
  missingUsd: boolean;
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

function buildOwnedBalanceKey(ownerAddress: string, chainId: number, tokenAddress: string): string {
  return `${ownerAddress.toLowerCase()}:${chainId}:${tokenAddress.toLowerCase()}`;
}

function normalizeBalance(record: SimBalanceRecord, ownerAddress: string): SimWalletBalance | null {
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
    balanceKey: buildOwnedBalanceKey(ownerAddress, record.chain_id!, record.address),
  };
}

function getPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeStableName(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function normalizeStableSymbol(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function tokenLooksStable(token: SimDefiPositionTokenRef | undefined): boolean {
  if (!token) return false;
  if (token.is_stablecoin === true) return true;
  if (token.asset_class?.trim().toLowerCase() === "stablecoin") return true;

  const symbol = normalizeStableSymbol(token.symbol);
  if (symbol && KNOWN_STABLE_SYMBOLS.has(symbol)) return true;

  const name = normalizeStableName(token.name);
  if (name && KNOWN_STABLE_NAMES.has(name)) return true;

  return false;
}

function buildSyntheticUntrackedStableAddress(
  chainId: number,
  token: SimDefiPositionTokenRef | undefined,
): string {
  const symbol = normalizeStableSymbol(token?.symbol)?.toLowerCase();
  const name = normalizeStableName(token?.name)?.replace(/[^a-z0-9]+/g, "-");
  const suffix = symbol ?? name ?? "unknown";
  return `untracked-stable:${chainId}:${suffix}`;
}

function assessStableCandidate(
  ownerAddress: string,
  chainId: number,
  token: SimDefiPositionTokenRef | undefined,
  usdValue: number | null,
): StableCandidateAssessment {
  const tokenAddress = typeof token?.address === "string" && token.address.length > 0 ? token.address : null;

  if (tokenAddress && resolveTrackedTreasuryStablecoin(chainId, tokenAddress)) {
    if (usdValue == null) {
      return { stableLeg: null, stableLike: true, missingUsd: true };
    }
    return {
      stableLeg: {
        chainId,
        tokenAddress,
        usdValue,
        balanceKey: buildOwnedBalanceKey(ownerAddress, chainId, tokenAddress),
      },
      stableLike: true,
      missingUsd: false,
    };
  }

  if (!tokenLooksStable(token)) {
    return {
      stableLeg: null,
      stableLike: false,
      missingUsd: false,
    };
  }

  if (usdValue == null) {
    return { stableLeg: null, stableLike: true, missingUsd: true };
  }

  const unresolvedAddress = tokenAddress ?? buildSyntheticUntrackedStableAddress(chainId, token);
  return {
    stableLeg: {
      chainId,
      tokenAddress: unresolvedAddress,
      usdValue,
      balanceKey: buildOwnedBalanceKey(ownerAddress, chainId, unresolvedAddress),
    },
    stableLike: true,
    missingUsd: false,
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

export function extractTreasuryDerivedPositionFromSimDefiPosition(
  ownerAddress: string,
  position: SimDefiPositionRecord,
): TreasuryDerivedPosition {
  const chainId = getPositiveNumber(position.chain_id);
  if (chainId == null) {
    return {
      positionUsd: null,
      stableLegs: [],
      partialStableExposure: false,
      warnings: [],
    };
  }

  const stableLegs: TreasuryBalanceToken[] = [];
  const warnings: string[] = [];
  const consumedBalanceKeys = typeof position.token?.address === "string" && position.token.address.length > 0
    ? [buildOwnedBalanceKey(ownerAddress, chainId, position.token.address)]
    : [];

  let partialStableExposure = false;
  const positionUsd = getPositiveNumber(position.supply?.value_usd) ?? getPositiveNumber(position.value_usd);

  const directUnderlyingCandidates = [
    {
      label: "underlying token",
      token: position.underlying_token,
      usdValue: getPositiveNumber(position.supply?.value_usd) ?? getPositiveNumber(position.value_usd),
    },
    {
      label: "loan token",
      token: position.loan_token,
      usdValue: getPositiveNumber(position.supply?.value_usd) ?? getPositiveNumber(position.value_usd),
    },
    {
      label: "asset token",
      token: position.asset,
      usdValue: getPositiveNumber(position.value_usd),
    },
  ];

  for (const candidate of directUnderlyingCandidates) {
    const assessment = assessStableCandidate(ownerAddress, chainId, candidate.token, candidate.usdValue);
    if (assessment.stableLeg) {
      stableLegs.push(assessment.stableLeg);
      break;
    }
    if (assessment.stableLike && assessment.missingUsd) {
      partialStableExposure = true;
      warnings.push(`Derived treasury position omitted a stable-like ${candidate.label} without a usable USD value.`);
      break;
    }
  }

  const ranges = Array.isArray(position.positions) && position.positions.length > 0
    ? position.positions
    : [{ token0: position.token0, token1: position.token1 }];

  for (const range of ranges) {
    const token0Assessment = assessStableCandidate(
      ownerAddress,
      chainId,
      position.token0,
      extractPairLegUsd(position.token0, range.token0),
    );
    if (token0Assessment.stableLeg) {
      stableLegs.push(token0Assessment.stableLeg);
    } else if (token0Assessment.stableLike && token0Assessment.missingUsd) {
      partialStableExposure = true;
      warnings.push("Derived treasury LP position omitted a stable-like token0 leg without a usable USD value.");
    }

    const token1Assessment = assessStableCandidate(
      ownerAddress,
      chainId,
      position.token1,
      extractPairLegUsd(position.token1, range.token1),
    );
    if (token1Assessment.stableLeg) {
      stableLegs.push(token1Assessment.stableLeg);
    } else if (token1Assessment.stableLike && token1Assessment.missingUsd) {
      partialStableExposure = true;
      warnings.push("Derived treasury LP position omitted a stable-like token1 leg without a usable USD value.");
    }
  }

  if (stableLegs.length > 0 && positionUsd == null) {
    partialStableExposure = true;
    warnings.push("Derived treasury position contributed stable exposure but did not expose a total USD position value.");
  }

  return {
    positionUsd,
    stableLegs,
    consumedBalanceKeys,
    partialStableExposure,
    warnings,
  };
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
      const normalized = normalizeBalance(record, address);
      if (normalized) balances.push(normalized);
    }
    offset = json.next_offset || undefined;
  } while (offset);

  return { balances, warnings };
}

export async function fetchSimWalletDefiTreasuryPositions({
  apiKey,
  address,
  chainIds,
  signal,
}: Omit<FetchSimWalletBalancesOptions, "stablecoinOnly">): Promise<SimWalletDefiTreasuryPositionsResult> {
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

  const positions = (json.positions ?? []).map((position) => extractTreasuryDerivedPositionFromSimDefiPosition(address, position));
  return { positions, warnings };
}
