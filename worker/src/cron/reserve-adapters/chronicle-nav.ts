import type { ContractDeployment, ReserveSlice, StablecoinMeta } from "@shared/types/core";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { CHAIN_META } from "@shared/lib/chains";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { DECIMALS_SELECTOR } from "../../lib/evm-selectors";
import { rethrowIfAborted } from "../../lib/abort";
import { logWorkerEventArgs } from "../../lib/structured-log";
import type { AdapterContext, AdapterResult } from "./types";
import { decodeUint256Word } from "./abi-decode";
import {
  decimalStringFromBigInt,
  fetchErc20TotalSupply,
  fetchTronErc20TotalSupply,
  freshnessMetadataFromTimestamp,
  makeOnchainCallers,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
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
  navScope: "native-fund-share" | "portfolio";
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  maxOracleAgeSec?: number;
}

export interface ChronicleNavSupplyContribution {
  chain: string;
  tokenAddress: string;
  raw: bigint;
  decimals: number;
}

export interface ChronicleNavSupplyAggregate {
  contributions: ChronicleNavSupplyContribution[];
  omittedNonEvmChains: string[];
  omittedNoRpcChains: string[];
  omittedReadFailureChains: string[];
}

export interface ChronicleNavData {
  navPerToken: bigint;
  supply: ChronicleNavSupplyAggregate;
  tokenDecimals: number;
  updatedAt: number;
}

function isEvmContract(contract: ContractDeployment): boolean {
  return CHAIN_META[contract.chain]?.type === "evm";
}

function isTronContract(contract: ContractDeployment): boolean {
  return CHAIN_META[contract.chain]?.type === "tron";
}

/** True when an EVM chain has an RPC entry in the context's chainRpc map.
 *  Without a map the chain is treated as readable and left to fail through its
 *  normal read path (mirrors usd1-bundle-oracle's supply scope check). */
function chainHasRpc(chain: string, ctx?: AdapterContext): boolean {
  const chainRpcs = ctx?.chainRpcs;
  return chainRpcs == null || chainRpcs.has(chain);
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

/**
 * Aggregate totalSupply across every registry-typed EVM + Tron chain in
 * coin.contracts, mirroring chainlink-por/usd1-bundle-oracle's multichain
 * liability scope. Non-EVM chains (Solana, Aptos, …) are omitted from the
 * gross-supply diagnostic and surfaced as an info warning, a chain without a
 * configured RPC is omitted as an info warning, and a failed per-chain read
 * degrades with `supplyReadComplete = false`. A zero read is a valid empty
 * deployment rather than a failure.
 */
async function aggregateChronicleSupply(
  coin: StablecoinMeta,
  input: ReturnType<typeof requireOnchainInput>,
  params: ChronicleNavParams,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<ChronicleNavSupplyAggregate> {
  const allContracts = coin.contracts ?? [];
  const evmContracts = allContracts.filter(isEvmContract);
  const tronContracts = allContracts.filter(isTronContract);
  const omittedNonEvmChains = allContracts
    .filter((contract) => !isEvmContract(contract) && !isTronContract(contract))
    .map((contract) => contract.chain);
  const readableContracts = [...evmContracts, ...tronContracts];

  if (readableContracts.length === 0) {
    throw new Error(`chronicle-nav: no EVM or Tron contracts available for ${coin.id}`);
  }

  const supplyReads = await Promise.all(
    readableContracts.map(async (contract) => {
      if (contract.decimals == null) {
        logWorkerEventArgs(
          "handler",
          "warn",
          `[chronicle-nav] ${contract.chain} supply probe skipped for ${coin.symbol}: contract decimals are missing`,
        );
        return { contract, raw: null, noRpc: false };
      }
      if (!isTronContract(contract) && !chainHasRpc(contract.chain, ctx)) {
        return { contract, raw: null, noRpc: true };
      }
      let raw: bigint | null;
      if (isTronContract(contract)) {
        raw = await fetchTronErc20TotalSupply(contract.address, signal, ctx);
      } else {
        try {
          raw = await fetchErc20TotalSupply(
            { ...input, chain: contract.chain },
            contract.address,
            signal,
            ctx,
            contract.chain === input.chain ? params.rpcUrl : undefined,
            contract.chain === input.chain ? params.fallbackRpcUrl : undefined,
          );
        } catch (error) {
          rethrowIfAborted(error, signal);
          raw = null;
        }
      }
      return { contract, raw, noRpc: false };
    }),
  );

  const successful = supplyReads.filter(
    (entry): entry is { contract: ContractDeployment; raw: bigint; noRpc: boolean } =>
      entry.raw != null && entry.raw > 0n,
  );
  const failed = supplyReads.filter((entry) => entry.raw == null && !entry.noRpc);
  const omittedNoRpcChains = supplyReads
    .filter((entry) => entry.noRpc)
    .map((entry) => entry.contract.chain);

  if (successful.length === 0) {
    throw new Error(`chronicle-nav: totalSupply() calls failed on all EVM/Tron chains for ${coin.id}`);
  }

  return {
    contributions: successful.map((entry) => ({
      chain: entry.contract.chain,
      tokenAddress: entry.contract.address,
      raw: entry.raw,
      decimals: entry.contract.decimals as number,
    })),
    omittedNonEvmChains,
    omittedNoRpcChains,
    omittedReadFailureChains: failed.map((entry) => entry.contract.chain),
  };
}

function supplyAggregateWarnings(supply: ChronicleNavSupplyAggregate): LiveReserveWarning[] {
  const warnings: LiveReserveWarning[] = [];
  if (supply.omittedNonEvmChains.length > 0) {
    warnings.push(
      reserveInfoWarning(
        "por-supply-chain-omitted",
        `Supply aggregation omits non-EVM chains: ${supply.omittedNonEvmChains.join(", ")}`,
      ),
    );
  }
  if (supply.omittedNoRpcChains.length > 0) {
    warnings.push(
      reserveInfoWarning(
        "por-supply-chain-omitted",
        `Supply aggregation omits chains with no RPC configured: ${supply.omittedNoRpcChains.join(", ")}`,
      ),
    );
  }
  if (supply.omittedReadFailureChains.length > 0) {
    warnings.push(
      reserveDegradedWarning(
        "partial-supply-read-failure",
        `Supply aggregation omits chains whose totalSupply() read failed: ${supply.omittedReadFailureChains.join(", ")}`,
      ),
    );
  }
  return warnings;
}

export function adaptChronicleNavResponse(data: ChronicleNavData, params: ChronicleNavParams): AdapterResult {
  if (data.navPerToken <= 0n) {
    throw new Error("chronicle-nav: readWithAge() reported zero or negative NAV per token");
  }

  const totalSupplyRaw = data.supply.contributions.reduce((sum, contribution) => sum + contribution.raw, 0n);
  if (totalSupplyRaw <= 0n) {
    throw new Error("chronicle-nav: observed zero token supply across readable chains");
  }

  const warnings = supplyAggregateWarnings(data.supply);
  const mixedDecimals = data.supply.contributions.some(
    (contribution) => contribution.decimals !== data.tokenDecimals,
  );
  if (mixedDecimals) {
    warnings.push(
      reserveDegradedWarning(
        "mixed-supply-decimals",
        "Supply aggregation mixes token decimals; the aggregate raw total is not a single-unit quantity",
      ),
    );
  }
  if (params.navScope === "portfolio") {
    warnings.push(
      reserveDegradedWarning(
        "nav-portfolio-composition-unverified",
        "NAV values the portfolio but does not verify its composition; dated holdings are required for scoring",
      ),
    );
  }

  return {
    slices: [
      {
        sourceKey: `chronicle-nav:token:${params.tokenAddress.toLowerCase()}`,
        name: params.assetLabel,
        pct: 100,
        risk: params.assetRisk,
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      navPerToken: decimalStringFromBigInt(data.navPerToken, CHRONICLE_NAV_DECIMALS),
      totalSupplyFormatted: decimalStringFromBigInt(totalSupplyRaw, data.tokenDecimals),
      totalSupplyRaw: totalSupplyRaw.toString(),
      navDecimals: CHRONICLE_NAV_DECIMALS,
      tokenDecimals: data.tokenDecimals,
      oracleUpdatedAt: data.updatedAt,
      oracleTimestampSource: "chronicle-readWithAge",
      supplyContributions: data.supply.contributions.map((contribution) => ({
        chain: contribution.chain,
        tokenAddress: contribution.tokenAddress,
        supplyRaw: contribution.raw.toString(),
        decimals: contribution.decimals,
      })),
      supplyReadComplete: data.supply.omittedReadFailureChains.length === 0,
      supplyCoverageComplete:
        data.supply.omittedReadFailureChains.length === 0 &&
        data.supply.omittedNonEvmChains.length === 0 &&
        data.supply.omittedNoRpcChains.length === 0,
      ...freshnessMetadataFromTimestamp(
        data.updatedAt,
        "chronicle-nav-readWithAge",
        "Chronicle readWithAge() did not expose a source timestamp",
      ),
    },
  };
}

export async function fetchChronicleNavReserves(
  coin: StablecoinMeta,
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

  const [rawReadWithAge, rawTokenDecimals] = await Promise.all([
    onchain.raw(params.consumerAddress, READ_WITH_AGE_SELECTOR),
    onchain.uint256(params.tokenAddress, DECIMALS_SELECTOR),
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

  const supply = await aggregateChronicleSupply(coin, input, params, signal, ctx);

  return adaptChronicleNavResponse(
    {
      navPerToken: value,
      supply,
      tokenDecimals,
      updatedAt: age,
    },
    params,
  );
}
