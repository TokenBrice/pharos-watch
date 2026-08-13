import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { decodeUint256Word } from "./abi-decode";
import {
  decimalStringFromBigInt,
  freshnessMetadataFromTimestamp,
  makeOnchainCallers,
  requireOnchainInput,
} from "./helpers";
import { validateDecimals } from "./slice-math";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "./validate";

const READ_WITH_AGE_SELECTOR = "0x393e5ede";
const CHRONICLE_NAV_DECIMALS = 18;
const DEFAULT_MAX_ORACLE_AGE_SEC = 2 * DAY_SECONDS;

export interface ChronicleNavParams {
  consumerAddress: string;
  tokenAddress: string;
  assetLabel: string;
  assetRisk: ReserveSlice["risk"];
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  maxOracleAgeSec?: number;
}

export interface ChronicleNavData {
  navPerToken: bigint;
  totalSupply: bigint;
  tokenDecimals: number;
  updatedAt: number;
}

export function decodeChronicleReadWithAge(raw: string): { value: bigint; age: number } {
  if (!/^0x[0-9a-fA-F]{128}$/.test(raw)) {
    throw new Error("chronicle-nav: readWithAge() returned malformed payload");
  }

  const value = decodeUint256Word(`0x${raw.slice(2, 66)}`);
  const ageRaw = decodeUint256Word(`0x${raw.slice(66, 130)}`);
  if (value == null || ageRaw == null) {
    throw new Error("chronicle-nav: readWithAge() returned malformed payload");
  }

  const age = Number(ageRaw);
  if (!Number.isSafeInteger(age) || age <= 0) {
    throw new Error("chronicle-nav: readWithAge() returned invalid age timestamp");
  }

  return { value, age };
}

function readChronicleNavParams(config: LiveReservesConfig): ChronicleNavParams {
  return parseLiveReserveAdapterParams("chronicle-nav", config.params);
}

export function adaptChronicleNavResponse(data: ChronicleNavData, params: ChronicleNavParams): AdapterResult {
  if (data.navPerToken <= 0n) {
    throw new Error("chronicle-nav: readWithAge() reported zero or negative NAV per token");
  }

  return {
    slices: [
      {
        name: params.assetLabel,
        pct: 100,
        risk: params.assetRisk,
      },
    ],
    metadata: {
      navPerToken: decimalStringFromBigInt(data.navPerToken, CHRONICLE_NAV_DECIMALS),
      totalSupplyFormatted: decimalStringFromBigInt(data.totalSupply, data.tokenDecimals),
      totalSupplyRaw: data.totalSupply.toString(),
      navDecimals: CHRONICLE_NAV_DECIMALS,
      tokenDecimals: data.tokenDecimals,
      oracleUpdatedAt: data.updatedAt,
      oracleTimestampSource: "chronicle-readWithAge",
      ...freshnessMetadataFromTimestamp(
        data.updatedAt,
        "chronicle-nav-readWithAge",
        "Chronicle readWithAge() did not expose a source timestamp",
      ),
    },
  };
}

export async function fetchChronicleNavReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "chronicle-nav");
  const params = readChronicleNavParams(config);
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });

  const [rawReadWithAge, rawTokenDecimals, rawTotalSupply] = await Promise.all([
    onchain.raw(params.consumerAddress, READ_WITH_AGE_SELECTOR),
    onchain.uint256(params.tokenAddress, DECIMALS_SELECTOR),
    onchain.uint256(params.tokenAddress, TOTAL_SUPPLY_SELECTOR),
  ]);

  if (rawReadWithAge == null) {
    throw new Error("chronicle-nav: readWithAge() call failed");
  }

  const { value, age } = decodeChronicleReadWithAge(rawReadWithAge);
  const maxOracleAgeSec = params.maxOracleAgeSec ?? DEFAULT_MAX_ORACLE_AGE_SEC;
  const now = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
  if (age > now + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) {
    throw new Error(`chronicle-nav: readWithAge() age timestamp is in the future (${age - now}s)`);
  }

  const ageSec = now - age;
  if (ageSec > maxOracleAgeSec) {
    throw new Error(`chronicle-nav: readWithAge() data is stale (${ageSec}s > ${maxOracleAgeSec}s)`);
  }

  if (rawTokenDecimals == null) {
    throw new Error("chronicle-nav: token decimals() call failed");
  }
  let tokenDecimals: number;
  try {
    tokenDecimals = validateDecimals(rawTokenDecimals, "chronicle-nav: token decimals");
  } catch {
    throw new Error(`chronicle-nav: token decimals out of range (${rawTokenDecimals})`);
  }

  if (rawTotalSupply == null) {
    throw new Error("chronicle-nav: token totalSupply() call failed");
  }

  return adaptChronicleNavResponse(
    {
      navPerToken: value,
      totalSupply: rawTotalSupply,
      tokenDecimals,
      updatedAt: age,
    },
    params,
  );
}
