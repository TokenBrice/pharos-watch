import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import { CHAIN_META } from "@shared/lib/chains";
import type { ContractDeployment, ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { EvmMulticall3Result } from "../../lib/evm-rpc";
import { encodeBalanceOfCallData } from "../../lib/evm-selectors";
import { decodeStrictAddressWord } from "./abi-decode";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decimalNumberFromBigInt,
  fetchErc20Balance,
  fetchErc20TotalSupply,
  fetchJsonAdapterInput,
  fetchOnchainMulticall3,
  parseDigitString,
  parseFiniteNumber,
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
// fixed on-chain facts that the adapter pins alongside reviewed holder identities.
const USDC_ETHEREUM = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const KRWQ_ETHEREUM = "0xc00db6b41473d065027f5ed6fada20fde75f142e";
// Reviewed September 15, 2026: verified custodian immutable token bindings;
// treasury Safe shares the custodian owner's 3-of-5 signer set. This is dated
// identity evidence, not continuous Safe control or legal segregation monitoring.
const REVIEWED_HOLDERS = {
  usdc: "0x5573b8db24043bee020c36ee0df32694dffef04c",
  frxusd: "0x7e88ac6a9c2dad21fea4de6b54c764ca4d99c05d",
  treasury: "0xa3e0b562c6fd7d6f570b2afc2cc4e240226d8b54",
} as const;
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

export interface KrwqCustodianBindings {
  usdc: boolean;
  frxusd: boolean;
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

function parseStrictAmount(value: unknown, label: string): number {
  return parseFiniteNumber(value, {
    label: `${ADAPTER_KEY} ${label}`,
    allowGrouped: true,
  });
}

function parseRawAmount(value: unknown, label: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return parseDigitString(
    value,
    `${ADAPTER_KEY} ${label} is not an unsigned integer${typeof value === "string" ? " string" : ""}: ${String(value)}`,
  );
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
  bindings?: KrwqCustodianBindings,
): AdapterResult {
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.timestamp);
  if (sourceTimestamp == null) {
    throw new Error(`${ADAPTER_KEY} payload has an unreadable timestamp`);
  }

  const warnings: LiveReserveWarning[] = [];
  if (KRWQ_LEGS.some((leg) => holderAddressFor(payload, leg.key)?.toLowerCase() !== REVIEWED_HOLDERS[leg.key])
    || bindings?.usdc !== true || bindings?.frxusd !== true) {
    warnings.push(reserveDegradedWarning(
      "krwq-holder-unverified",
      "Reserve holder differs from the reviewed identity or live custodian token bindings could not be verified",
    ));
  }
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

    const reportedValue = parseStrictAmount(legPayload.totalAssets, `${leg.key} totalAssets`);
    if (reportedValue < 0) {
      throw new Error(`${ADAPTER_KEY} ${leg.key} totalAssets is negative`);
    }

    let rawApi: bigint | null = null;
    try {
      rawApi = parseRawAmount(legPayload.totalAssetsRaw, `${leg.key} totalAssetsRaw`);
    } catch {
      rawApi = null;
    }

    const balance = onchain[leg.key];
    const value = balance != null ? decimalNumberFromBigInt(balance, leg.decimals) : reportedValue;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${ADAPTER_KEY} ${leg.key} on-chain amount is invalid`);
    }
    if (balance == null) {
      warnings.push(reserveDegradedWarning(
        "krwq-onchain-read-failed",
        `${leg.name} could not be verified on-chain (balanceOf failed or reverted); using observed value $${value.toFixed(2)}`,
      ));
    } else if (rawApi == null) {
      warnings.push(reserveDegradedWarning(
        "krwq-onchain-unverifiable",
        `${leg.name} reported no verifiable raw amount; using observed value $${value.toFixed(2)}`,
      ));
    } else if (balance !== rawApi) {
      warnings.push(reserveDegradedWarning(
        "krwq-onchain-mismatch",
        `${leg.name} on-chain balance ${balance.toString()} differs from issuer-reported ${rawApi.toString()}; using observed value $${value.toFixed(2)}`,
      ));
    }

    if (value === 0) continue;
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

  const grossSupplyTokens = supply.contributions.reduce(
    (total, contribution) => total + decimalNumberFromBigInt(contribution.raw, contribution.decimals),
    0,
  );

  return {
    slices: slicesFromValues(sliceInputs),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      totalReserveUsd,
      // Gross cross-chain KRWQ is neither USD nor reconciled circulating
      // liabilities. Keep it diagnostic until FX and bridge exclusions agree.
      details: {
        timestamp: payload.timestamp,
        grossSupplyTokens,
        supplyUnit: "KRWQ",
        supplyScope: "gross-onchain-diagnostic",
        omittedSupplyChains: [...supply.omittedNonEvmChains, ...supply.omittedReadFailureChains],
        coverageRatioUnavailableReason: "KRW-denominated gross supply requires FX valuation and cross-chain liability reconciliation",
        holderIdentityReviewedAt: "2026-09-15",
      },
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
  const bindings: KrwqCustodianBindings = { usdc: false, frxusd: false };

  // Both Ethereum legs read in a single Multicall3 aggregate (the frxUSD
  // balanceOf can revert, so each call is allowFailure=true and decoded
  // independently).
  const ethCalls: OnchainMulticall3Call[] = [];
  for (const leg of KRWQ_LEGS) {
    if (leg.chain !== "ethereum") continue;
    const holder = REVIEWED_HOLDERS[leg.key];
    ethCalls.push({
      label: `${leg.key}-balance`,
      contract: leg.tokenAddress,
      data: encodeBalanceOfCallData(holder),
      allowFailure: true,
    });
    ethCalls.push(
      { label: `${leg.key}-krwq`, contract: holder, data: "0x1ee5e23a", allowFailure: true },
      { label: `${leg.key}-collateral`, contract: holder, data: "0x9de54cd3", allowFailure: true },
    );
  }
  if (ethCalls.length > 0) {
    const results = await fetchOnchainMulticall3({ chain: "ethereum", calls: ethCalls, signal, ctx });
    if (results != null) {
      for (const leg of KRWQ_LEGS) {
        if (leg.key === "treasury") continue;
        onchain[leg.key] = balanceFromMulticallResult(results.find((result) => result.label === `${leg.key}-balance`));
        const krwq = results.find((result) => result.label === `${leg.key}-krwq`);
        const collateral = results.find((result) => result.label === `${leg.key}-collateral`);
        bindings[leg.key] = krwq?.success === true && collateral?.success === true
          && decodeStrictAddressWord(krwq.returnData) === KRWQ_ETHEREUM
          && decodeStrictAddressWord(collateral.returnData) === leg.tokenAddress;
      }
    }
  }

  // Base treasury USDC is a second chain, read via the standard balance helper.
  const treasuryHolder = REVIEWED_HOLDERS.treasury;
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

  return adaptKrwqCustodian(payload, onchain, supply, bindings);
}
