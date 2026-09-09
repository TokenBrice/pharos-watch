import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import { CHAIN_META } from "@shared/lib/chains";
import type { ContractDeployment, ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { EvmMulticall3Result } from "../../lib/evm-rpc";
import { encodeBalanceOfCallData } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decimalNumberFromBigInt,
  fetchErc20Balance,
  fetchErc20TotalSupply,
  fetchJsonAdapterInput,
  fetchOnchainMulticall3,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromValues,
  verifiedFreshnessMetadata,
  type OnchainMulticall3Call,
} from "./helpers";

const ADAPTER_KEY = "krwq-custodian";

// Reviewed canonical collateral token addresses. The custodian/treasury holder
// addresses are issuer-reported per snapshot, but these token identities are
// fixed on-chain facts that the adapter pins.
const USDC_ETHEREUM = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const FRXUSD_ETHEREUM = "0xcacd6fd266af91b8aed52accc382b4e165586e29";

type KrwqLegKey = "usdc" | "frxusd" | "treasury";

interface KrwqLegPayload {
  /** Issuer-reported USD value. */
  totalAssets?: number | string;
  /** Issuer-reported raw token units (native decimals). */
  totalAssetsRaw?: number | string;
  custodianAddress?: string;
  treasuryAddress?: string;
}

export interface KrwqCustodianPayload {
  usdc?: KrwqLegPayload;
  frxusd?: KrwqLegPayload;
  treasury?: KrwqLegPayload;
  totalKrwqMinted?: number | string;
  totalKrwqMintedRaw?: number | string;
  reserveRatio?: number | string;
  timestamp?: string;
}

interface KrwqLegConfig {
  key: KrwqLegKey;
  name: string;
  risk: ReserveSlice["risk"];
  coinId: string;
  chain: "ethereum" | "base";
  tokenAddress: string;
  decimals: number;
}

const KRWQ_LEGS: readonly KrwqLegConfig[] = [
  {
    key: "usdc",
    name: "USDC custodian reserves",
    risk: getCanonicalReserveAssetRisk("USDC") ?? "low",
    coinId: "usdc-circle",
    chain: "ethereum",
    tokenAddress: USDC_ETHEREUM,
    decimals: 6,
  },
  {
    key: "frxusd",
    name: "frxUSD custodian reserves",
    risk: getCanonicalReserveAssetRisk("FRXUSD") ?? "low",
    coinId: "frxusd-frax",
    chain: "ethereum",
    tokenAddress: FRXUSD_ETHEREUM,
    decimals: 18,
  },
  {
    // The Base treasury bucket holds USDC today while the issuer transitions
    // toward Korean Treasury Bonds; the slice documents that intent in its name.
    key: "treasury",
    name: "Treasury USDC (Korean Treasury Bond transition)",
    risk: getCanonicalReserveAssetRisk("USDC") ?? "low",
    coinId: "usdc-circle",
    chain: "base",
    tokenAddress: USDC_BASE,
    decimals: 6,
  },
];

export interface KrwqOnchainBalances {
  usdc: bigint | null;
  frxusd: bigint | null;
  treasury: bigint | null;
}

export interface KrwqSupplyContribution {
  chain: string;
  tokenAddress: string;
  raw: bigint;
  decimals: number;
}

export interface KrwqSupplyAggregate {
  contributions: KrwqSupplyContribution[];
  omittedNonEvmChains: string[];
  omittedReadFailureChains: string[];
}

/** Strict amount parser: finite numbers pass through, numeric strings are
 *  converted, and anything else throws so a malformed payload can never
 *  silently read as zero. */
function parseStrictAmount(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new Error(`${ADAPTER_KEY} ${label} is not a finite number: ${String(value)}`);
}

/** Raw-unit parser for the issuer's `totalAssetsRaw` fields. The frxUSD raw
 *  amount exceeds `Number.MAX_SAFE_INTEGER`, so numeric strings are the only
 *  lossless representation; small amounts may arrive as safe integers. */
function parseRawAmount(value: unknown, label: string): bigint {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
    throw new Error(`${ADAPTER_KEY} ${label} is not an unsigned integer string: ${String(value)}`);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new Error(`${ADAPTER_KEY} ${label} is not an unsigned integer: ${String(value)}`);
}

function holderAddressFor(payload: KrwqCustodianPayload, key: KrwqLegKey): string | null {
  const leg = payload[key];
  if (!leg || typeof leg !== "object") return null;
  const address = key === "treasury" ? leg.treasuryAddress : leg.custodianAddress;
  if (typeof address !== "string") return null;
  const trimmed = address.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed : null;
}

function balanceFromMulticallResult(result: EvmMulticall3Result | undefined): bigint | null {
  if (!result || !result.success) return null;
  try {
    return BigInt(result.returnData);
  } catch {
    return null;
  }
}

async function aggregateKrwqSupply(
  coin: StablecoinMeta,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<KrwqSupplyAggregate> {
  const contracts = coin.contracts ?? [];
  const evmContracts = contracts.filter(
    (contract) => CHAIN_META[contract.chain]?.type === "evm",
  );
  const omittedNonEvmChains = contracts
    .filter((contract) => CHAIN_META[contract.chain]?.type !== "evm")
    .map((contract) => contract.chain);

  const reads = await Promise.all(
    evmContracts.map(async (contract) => {
      const raw = await fetchErc20TotalSupply(
        { kind: "onchain-evm", chain: contract.chain, rpcMode: "public-rpc" },
        contract.address,
        signal,
        ctx,
      );
      return { contract, raw };
    }),
  );

  return {
    contributions: reads
      .filter((entry): entry is { contract: ContractDeployment; raw: bigint } => entry.raw != null)
      .map((entry) => ({
        chain: entry.contract.chain,
        tokenAddress: entry.contract.address,
        raw: entry.raw,
        decimals: entry.contract.decimals,
      })),
    omittedNonEvmChains,
    omittedReadFailureChains: reads
      .filter((entry) => entry.raw == null)
      .map((entry) => entry.contract.chain),
  };
}

export function adaptKrwqCustodian(
  payload: KrwqCustodianPayload,
  onchain: KrwqOnchainBalances,
  supply: KrwqSupplyAggregate,
): AdapterResult {
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.timestamp);
  if (sourceTimestamp == null) {
    throw new Error(`${ADAPTER_KEY} payload has an unreadable timestamp`);
  }

  const warnings: LiveReserveWarning[] = [];
  const sliceInputs: Array<{
    value: number;
    sourceKey: string;
    name: string;
    risk: ReserveSlice["risk"];
    coinId: string;
  }> = [];

  for (const leg of KRWQ_LEGS) {
    const legPayload = payload[leg.key];
    if (!legPayload || typeof legPayload !== "object") {
      throw new Error(`${ADAPTER_KEY} payload missing ${leg.key} leg`);
    }

    const value = parseStrictAmount(legPayload.totalAssets, `${leg.key} totalAssets`);
    if (value < 0) {
      throw new Error(`${ADAPTER_KEY} ${leg.key} totalAssets is negative`);
    }
    if (value === 0) continue;

    let rawApi: bigint | null = null;
    try {
      rawApi = parseRawAmount(legPayload.totalAssetsRaw, `${leg.key} totalAssetsRaw`);
    } catch {
      rawApi = null;
    }

    const balance = onchain[leg.key];
    if (balance == null) {
      warnings.push(reserveDegradedWarning(
        "krwq-onchain-read-failed",
        `${leg.name} could not be verified on-chain (balanceOf failed or reverted); keeping issuer-reported value $${value.toFixed(2)}`,
      ));
    } else if (rawApi == null) {
      warnings.push(reserveDegradedWarning(
        "krwq-onchain-unverifiable",
        `${leg.name} reported no verifiable raw amount; keeping issuer-reported value $${value.toFixed(2)}`,
      ));
    } else if (balance !== rawApi) {
      warnings.push(reserveDegradedWarning(
        "krwq-onchain-mismatch",
        `${leg.name} on-chain balance ${balance.toString()} differs from issuer-reported ${rawApi.toString()}; keeping issuer-reported value $${value.toFixed(2)}`,
      ));
    }

    sliceInputs.push({ sourceKey: `krwq-custodian:${leg.key}`, name: leg.name, value, risk: leg.risk, coinId: leg.coinId });
  }

  if (sliceInputs.length === 0) {
    throw new Error(`${ADAPTER_KEY} payload contained no positive reserve amounts`);
  }

  const totalReserveUsd = sliceInputs.reduce((sum, slice) => sum + slice.value, 0);

  if (supply.omittedNonEvmChains.length > 0) {
    warnings.push(reserveInfoWarning(
      "krwq-supply-chain-omitted",
      `Supply aggregation omits non-EVM chains: ${supply.omittedNonEvmChains.join(", ")}`,
    ));
  }
  if (supply.omittedReadFailureChains.length > 0) {
    warnings.push(reserveInfoWarning(
      "krwq-supply-chain-omitted",
      `Supply aggregation omits chains whose totalSupply() read failed: ${supply.omittedReadFailureChains.join(", ")}`,
    ));
  }

  const supplyUsd = supply.contributions.reduce(
    (total, contribution) => total + decimalNumberFromBigInt(contribution.raw, contribution.decimals),
    0,
  );

  return {
    slices: slicesFromValues(sliceInputs),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      totalReserveUsd,
      ...(supplyUsd > 0
        ? { supplyUsd, collateralizationRatio: totalReserveUsd / supplyUsd }
        : {}),
      details: { timestamp: payload.timestamp },
    },
  };
}

export async function fetchKrwqCustodianReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const payload = await fetchJsonAdapterInput<KrwqCustodianPayload>(
    config,
    ADAPTER_KEY,
    signal,
    12_000,
    ctx,
  );

  const onchain: KrwqOnchainBalances = { usdc: null, frxusd: null, treasury: null };

  // Both Ethereum legs read in a single Multicall3 aggregate (the frxUSD
  // balanceOf can revert, so each call is allowFailure=true and decoded
  // independently).
  const ethCalls: OnchainMulticall3Call[] = [];
  for (const leg of KRWQ_LEGS) {
    if (leg.chain !== "ethereum") continue;
    const holder = holderAddressFor(payload, leg.key);
    if (holder == null) continue;
    ethCalls.push({
      label: `${leg.key}-balance`,
      contract: leg.tokenAddress,
      data: encodeBalanceOfCallData(holder),
      allowFailure: true,
    });
  }
  if (ethCalls.length > 0) {
    const results = await fetchOnchainMulticall3({ chain: "ethereum", calls: ethCalls, signal, ctx });
    if (results != null) {
      for (const result of results) {
        const legKey = result.label.replace(/-balance$/, "") as KrwqLegKey;
        onchain[legKey] = balanceFromMulticallResult(result);
      }
    }
  }

  // Base treasury USDC is a second chain, read via the standard balance helper.
  const treasuryHolder = holderAddressFor(payload, "treasury");
  if (treasuryHolder != null) {
    onchain.treasury = await fetchErc20Balance(
      { kind: "onchain-evm", chain: "base", rpcMode: "public-rpc" },
      USDC_BASE,
      treasuryHolder,
      signal,
      ctx,
    );
  }

  const supply = await aggregateKrwqSupply(coin, signal, ctx);

  return adaptKrwqCustodian(payload, onchain, supply);
}
