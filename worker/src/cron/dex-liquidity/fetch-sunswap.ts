import {
  DIRECT_API_POOL_MIN_TVL_USD,
  makeDexApiFetchResult,
  type DexApiFetchResult,
  type DexApiPool,
} from "../../lib/dex-api-common";
import { rethrowIfAborted } from "../../lib/abort";
import { USER_AGENT } from "../../lib/constants";
import { toErrorMessage } from "../../lib/error-utils";
import { cancelUnsuccessfulResponseBodyQuietly } from "../../lib/response-body";
import { buildDirectApiRequestSignal } from "./direct-api-policy";
import { isDexApiRecord, readDexApiJson } from "./direct-api-json";

const SUNSWAP_POOL_SCAN_API = "https://open.sun.io/apiv2/pools/scan";
const SUNSWAP_PROTOCOL = "V2";
const PAGE_SIZE = 100;
const MAX_PAGES = 60;
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

interface SunSwapPoolRow {
  protocol: string;
  poolAddress: string;
  poolType: string;
  contractIndex: number;
  feeRate: number;
  tokenAddressList: string[];
  tokenAmountList: string[];
  tokenAmountVol1dList?: string[];
  reserveUsd: number;
  volumeUsd1d: number;
  tokenSymbolList: string[];
  tokenDecimalList: number[];
  tokenPriceUsdList?: number[];
}

interface SunSwapPoolScanResponse {
  code?: number;
  msg?: string;
  data?: {
    list?: unknown[];
    meta?: { hasMore?: boolean; returnSize?: number };
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown, length: number): value is string[] {
  return Array.isArray(value) && value.length === length && value.every((item) => typeof item === "string");
}

function isSunSwapPoolRow(value: unknown): value is SunSwapPoolRow {
  if (!isDexApiRecord(value)) return false;
  const tokenCount = Array.isArray(value.tokenAddressList) ? value.tokenAddressList.length : 0;
  return value.protocol === SUNSWAP_PROTOCOL &&
    typeof value.poolAddress === "string" &&
    typeof value.poolType === "string" &&
    Number.isSafeInteger(value.contractIndex) &&
    isFiniteNumber(value.feeRate) &&
    tokenCount === 2 &&
    isStringArray(value.tokenAddressList, tokenCount) &&
    isStringArray(value.tokenAmountList, tokenCount) &&
    isStringArray(value.tokenSymbolList, tokenCount) &&
    Array.isArray(value.tokenDecimalList) &&
    value.tokenDecimalList.length === tokenCount &&
    value.tokenDecimalList.every((item) => Number.isInteger(item) && item >= 0 && item <= 255) &&
    isFiniteNumber(value.reserveUsd) &&
    isFiniteNumber(value.volumeUsd1d);
}

function parseNonNegativeNumber(value: string | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseSunSwapV2Pool(value: unknown): DexApiPool | null {
  if (!isSunSwapPoolRow(value)) return null;
  if (
    !TRON_ADDRESS.test(value.poolAddress) ||
    value.tokenAddressList.some((address) => !TRON_ADDRESS.test(address)) ||
    value.tokenAddressList[0] === value.tokenAddressList[1] ||
    value.feeRate !== 0.003 ||
    value.reserveUsd < DIRECT_API_POOL_MIN_TVL_USD
  ) return null;

  const balances = value.tokenAmountList.map(parseNonNegativeNumber);
  if (balances.some((balance) => balance == null)) return null;
  const tokenVolumes = value.tokenAmountVol1dList?.length === 2
    ? value.tokenAmountVol1dList.map(parseNonNegativeNumber)
    : null;
  const tokenPrices = value.tokenPriceUsdList?.length === 2 ? value.tokenPriceUsdList : [];
  const price0 = tokenPrices[0];
  const price1 = tokenPrices[1];

  return {
    source: "sunswap",
    chain: "tron",
    poolAddress: value.poolAddress,
    poolType: "sunswap-v2",
    tokens: value.tokenAddressList.map((address, index) => ({
      address,
      symbol: value.tokenSymbolList[index]!.trim(),
      decimals: value.tokenDecimalList[index]!,
      priceUsd: isFiniteNumber(tokenPrices[index]) && tokenPrices[index]! > 0 ? tokenPrices[index]! : null,
    })),
    price: isFiniteNumber(price0) && price0 > 0 && isFiniteNumber(price1) && price1 > 0 ? price0 / price1 : null,
    tvlUsd: value.reserveUsd,
    volume24hUsd: Math.max(0, value.volumeUsd1d),
    feeRate: 0.003,
    balances: balances as number[],
    balancesNormalized: true,
    tokenVolumes24h:
      tokenVolumes && tokenVolumes.every((volume) => volume != null) ? tokenVolumes as number[] : null,
  };
}

function buildScanUrl(contractIndex: number): string {
  const url = new URL(SUNSWAP_POOL_SCAN_API);
  url.searchParams.set("protocol", SUNSWAP_PROTOCOL);
  url.searchParams.set("pageSize", String(PAGE_SIZE));
  url.searchParams.set("contractIndex", String(contractIndex));
  return url.toString();
}

export async function fetchSunSwapPools(signal?: AbortSignal): Promise<DexApiFetchResult> {
  const pools: DexApiPool[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let contractIndex = 0;
  let successfulPages = 0;
  let completed = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    let response: Response;
    try {
      response = await fetch(buildScanUrl(contractIndex), {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: buildDirectApiRequestSignal(signal),
      });
    } catch (error) {
      rethrowIfAborted(error, signal);
      errors.push(`page ${page} request failed: ${toErrorMessage(error)}`);
      break;
    }
    if (!response.ok) {
      errors.push(`page ${page} returned ${response.status}`);
      await cancelUnsuccessfulResponseBodyQuietly(response);
      break;
    }
    const parsed = await readDexApiJson<SunSwapPoolScanResponse>(response, `SunSwap page ${page}`);
    if (!parsed.ok) {
      errors.push(parsed.error);
      break;
    }
    const body = parsed.data;
    const rows = body.data?.list;
    const meta = body.data?.meta;
    if (body.code !== 0 || !Array.isArray(rows) || !meta || typeof meta.hasMore !== "boolean") {
      errors.push(`page ${page} returned malformed body: ${body.msg ?? "unknown error"}`);
      break;
    }
    successfulPages++;
    if (rows.length === 0) {
      completed = true;
      break;
    }

    let pageMaxIndex = contractIndex;
    let malformedRows = 0;
    for (const row of rows) {
      if (
        !isDexApiRecord(row) ||
        typeof row.contractIndex !== "number" ||
        !Number.isSafeInteger(row.contractIndex) ||
        row.contractIndex <= contractIndex
      ) {
        malformedRows++;
        continue;
      }
      pageMaxIndex = Math.max(pageMaxIndex, row.contractIndex);
      const pool = parseSunSwapV2Pool(row);
      if (pool) pools.push(pool);
    }
    if (malformedRows > 0) warnings.push(`page ${page} skipped ${malformedRows} malformed row(s)`);
    if (pageMaxIndex <= contractIndex) {
      errors.push(`page ${page} did not advance contractIndex`);
      break;
    }
    contractIndex = pageMaxIndex;
    if (!meta.hasMore) {
      completed = true;
      break;
    }
    if (page === MAX_PAGES) errors.push(`pagination cap reached; resumeFromContractIndex=${contractIndex}`);
  }

  return makeDexApiFetchResult(pools, {
    ok: successfulPages > 0,
    degraded: errors.length > 0 || !completed,
    errors,
    warnings,
    pagination: {
      state: completed ? "complete" : "partial",
      headRefreshed: successfulPages > 0,
      pagesFetched: successfulPages,
      cursor: completed ? null : String(contractIndex),
      cycleCompleted: completed,
    },
  });
}
