import { fetchWithRetry } from "./fetch-retry";
import {
  SIM_BALANCES_BASE_URL,
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

export interface SimWalletBalance {
  chainId: number;
  tokenAddress: string;
  usdValue: number;
}

export interface SimWalletBalancesResult {
  balances: SimWalletBalance[];
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
