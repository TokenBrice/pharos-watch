import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { encodeBalanceOfCallData } from "../../lib/evm-selectors";
import { getPublicRpcUrl, getSecondaryFallbackRpcUrl } from "../../lib/public-rpc-registry";
import type { AdapterContext, AdapterResult } from "./types";
import { normalizeEvmAddress, resolveCoinContractAddress } from "./evm";
import {
  abiObservation,
  executeEvmObservationPlan,
  uint256Observation,
  type AnyEvmObservationField,
} from "./evm-observation-plan";
import {
  decimalNumberFromBigInt,
  fetchOnchainMulticall3,
  normalizeSlices,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
} from "./helpers";

const ADAPTER_KEY = "idle-cdo-epoch-variant";
const ETHEREUM_RPC_URL = getPublicRpcUrl("ethereum");
const ETHEREUM_FALLBACK_RPC_URL = getSecondaryFallbackRpcUrl("ethereum");

/**
 * An `IdleCDOEpochVariant` credit vault is deliberately NOT ERC-4626: `asset()`
 * and `totalAssets()` revert, and the deposited underlying never sits in the
 * contract — it is forwarded to the whitelisted borrower's wallet. The only
 * honest source of composition is the CDO's own epoch accounting:
 *
 *   getContractValue() = underlying.balanceOf(cdo)          // unlent, if any
 *                      + strategyToken.balanceOf(cdo) * px  // the receivable
 *
 * so `getContractValue() - underlying.balanceOf(cdo)` is exactly the borrower
 * receivable, with no double counting. The receivable is a single-obligor
 * private-credit claim and is published WITHOUT a `coinId`: it is not the
 * deposit token, and linking it to one would present a loan book as that
 * token's reserves.
 *
 * Reference implementation (pinned): Idle-Labs/idle-tranches @ d7b98b9,
 * `contracts/IdleCDO.sol` and `contracts/IdleCDOEpochVariant.sol`.
 */
const IDLE_CDO_ABI = [
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "AATranche", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "BBTranche", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getContractValue", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lastNAVAA", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lastNAVBB", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "unclaimedFees", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochDuration", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochEndDate", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "defaulted", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "isEpochRunning", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

const TRANCHE_ABI = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "minter", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/** `epochDuration` is the credit cycle; anything shorter than this is not a liquidity claim. */
const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;
/** Tolerated drift between `getContractValue()` and `lastNAVAA + lastNAVBB` before degrading. */
const NAV_RECONCILIATION_TOLERANCE = 0.001;

type IdleCdoParams = ReturnType<typeof readParams>;

function requireAddress(value: string | null | undefined, label: string): `0x${string}` {
  const normalized = normalizeEvmAddress(value);
  if (!normalized) throw new Error(`${ADAPTER_KEY}: ${label} is not a valid EVM address`);
  return normalized;
}

function readParams(config: LiveReservesConfig) {
  return parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
}

export interface IdleCdoEpochVariantSnapshot {
  cdoAddress: string;
  trancheAddress: string;
  tranche: "AA" | "BB";
  underlyingAddress: string;
  underlyingDecimals: number;
  /** Total vault value in underlying units: unlent balance + valued receivable. */
  contractValueRaw: bigint;
  /** Underlying actually sitting in the CDO. Zero for a fully drawn credit cycle. */
  unlentRaw: bigint;
  navAaRaw: bigint;
  navBbRaw: bigint;
  unclaimedFeesRaw: bigint;
  trancheSupplyRaw: bigint;
  epochDurationSec: bigint;
  epochEndDateSec: bigint;
  defaulted: boolean;
  epochRunning: boolean;
}

function juniorNavRaw(snapshot: IdleCdoEpochVariantSnapshot): bigint {
  return snapshot.tranche === "AA" ? snapshot.navBbRaw : 0n;
}

function ownNavRaw(snapshot: IdleCdoEpochVariantSnapshot): bigint {
  return snapshot.tranche === "AA" ? snapshot.navAaRaw : snapshot.navBbRaw;
}

/**
 * The receivable's liquidity horizon comes from the credit cycle, not from the
 * time left in it: using the remaining term would make the exposure look more
 * liquid every day and snap back at each roll. A defaulted facility has no
 * observable recovery horizon at all, so it degrades to `unknown` rather than
 * keeping the performing-case band.
 */
function resolveCreditLiquidityHorizon(
  snapshot: IdleCdoEpochVariantSnapshot,
): ReserveSlice["liquidityHorizon"] {
  if (snapshot.defaulted) return "unknown";
  if (snapshot.epochDurationSec <= 0n) return "unknown";
  return snapshot.epochDurationSec > BigInt(SEVEN_DAYS_SEC) ? "over-seven-days" : "seven-days";
}

export function adaptIdleCdoEpochVariantSnapshot(
  snapshot: IdleCdoEpochVariantSnapshot,
  params: Pick<IdleCdoParams, "creditSlice" | "unlentSlice" | "sourceUrls">,
): AdapterResult {
  const warnings: LiveReserveWarning[] = [];

  if (snapshot.contractValueRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY} observed zero contract value`);
  }
  if (snapshot.trancheSupplyRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY} observed zero ${snapshot.tranche} tranche supply`);
  }
  if (snapshot.unlentRaw > snapshot.contractValueRaw) {
    throw new Error(`${ADAPTER_KEY} unlent underlying exceeds total contract value`);
  }
  if (ownNavRaw(snapshot) <= 0n) {
    throw new Error(
      `${ADAPTER_KEY} observed zero NAV for the ${snapshot.tranche} tranche while its supply is positive`,
    );
  }

  const receivableRaw = snapshot.contractValueRaw - snapshot.unlentRaw;
  if (receivableRaw <= 0n && snapshot.unlentRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY} observed no reserve value`);
  }

  const contractValueUsd = decimalNumberFromBigInt(snapshot.contractValueRaw, snapshot.underlyingDecimals);
  const unlentUsd = decimalNumberFromBigInt(snapshot.unlentRaw, snapshot.underlyingDecimals);
  const receivableUsd = decimalNumberFromBigInt(receivableRaw, snapshot.underlyingDecimals);
  const navTotalUsd = decimalNumberFromBigInt(
    snapshot.navAaRaw + snapshot.navBbRaw,
    snapshot.underlyingDecimals,
  );

  const navDrift = contractValueUsd > 0 ? Math.abs(contractValueUsd - navTotalUsd) / contractValueUsd : 1;
  if (navDrift > NAV_RECONCILIATION_TOLERANCE) {
    warnings.push(reserveDegradedWarning(
      "idle-cdo-nav-reconciliation-drift",
      `IdleCDO tranche NAVs differ from getContractValue() by ${(navDrift * 100).toFixed(3)}%`,
    ));
  }
  if (snapshot.defaulted) {
    warnings.push(reserveDegradedWarning(
      "idle-cdo-defaulted",
      "The IdleCDO credit vault reports defaulted=true; the borrower receivable is impaired",
    ));
  }
  if (!snapshot.epochRunning) {
    warnings.push(reserveInfoWarning(
      "idle-cdo-epoch-not-running",
      "The IdleCDO credit vault is between epochs; the published composition reflects the last settled cycle",
    ));
  }
  // Seniority is only worth something while a junior tranche actually carries
  // value. Recording that absence is the honest treatment; the composition is
  // NOT re-rated upward for an "AA senior" label with no first-loss beneath it.
  if (snapshot.tranche === "AA" && juniorNavRaw(snapshot) <= 0n) {
    warnings.push(reserveDegradedWarning(
      "idle-cdo-no-junior-subordination",
      "The senior AA tranche has no live junior (BB) NAV beneath it, so it absorbs the first loss on the facility",
    ));
  }
  if (snapshot.unlentRaw <= 0n) {
    warnings.push(reserveInfoWarning(
      "idle-cdo-no-unlent-underlying",
      "The IdleCDO holds no unlent underlying; the entire reserve is the borrower receivable",
    ));
  }

  const liquidityHorizon = resolveCreditLiquidityHorizon(snapshot);
  const slices = normalizeSlices([
    {
      sourceKey: params.creditSlice.sourceKey,
      name: params.creditSlice.name,
      pct: (receivableUsd / contractValueUsd) * 100,
      risk: params.creditSlice.risk,
      assetClass: params.creditSlice.assetClass,
      issuerOrObligor: params.creditSlice.issuerOrObligor,
      riskFactors: [...params.creditSlice.riskFactors],
      ...(liquidityHorizon ? { liquidityHorizon } : {}),
    },
    {
      sourceKey: params.unlentSlice.sourceKey,
      name: params.unlentSlice.name,
      pct: (unlentUsd / contractValueUsd) * 100,
      risk: params.unlentSlice.risk,
      coinId: params.unlentSlice.coinId,
      ...(params.unlentSlice.depType ? { depType: params.unlentSlice.depType } : {}),
      ...(params.unlentSlice.assetClass ? { assetClass: params.unlentSlice.assetClass } : {}),
      ...(params.unlentSlice.issuerOrObligor ? { issuerOrObligor: params.unlentSlice.issuerOrObligor } : {}),
      ...(params.unlentSlice.riskFactors ? { riskFactors: [...params.unlentSlice.riskFactors] } : {}),
      ...(params.unlentSlice.blacklistable != null
        ? { blacklistable: params.unlentSlice.blacklistable }
        : {}),
      liquidityHorizon: "immediate" as const,
    },
  ], 6);

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "idle-cdo-epoch-variant-onchain-accounting",
        cdoAddress: snapshot.cdoAddress,
        trancheAddress: snapshot.trancheAddress,
        tranche: snapshot.tranche,
        underlyingAddress: snapshot.underlyingAddress,
        contractValueRaw: snapshot.contractValueRaw.toString(),
        unlentRaw: snapshot.unlentRaw.toString(),
        receivableRaw: receivableRaw.toString(),
        navAaRaw: snapshot.navAaRaw.toString(),
        navBbRaw: snapshot.navBbRaw.toString(),
        unclaimedFeesRaw: snapshot.unclaimedFeesRaw.toString(),
        trancheSupplyRaw: snapshot.trancheSupplyRaw.toString(),
        epochDurationSec: snapshot.epochDurationSec.toString(),
        epochEndDateSec: snapshot.epochEndDateSec.toString(),
        defaulted: snapshot.defaulted,
        epochRunning: snapshot.epochRunning,
        juniorSubordinationUsd: decimalNumberFromBigInt(juniorNavRaw(snapshot), snapshot.underlyingDecimals),
        ...(params.sourceUrls ? { sourceUrls: [...params.sourceUrls] } : {}),
      }),
      supplyUsd: contractValueUsd,
      totalReserveUsd: contractValueUsd,
      collateralizationRatio: navTotalUsd > 0 ? contractValueUsd / navTotalUsd : undefined,
    },
  };
}

async function executeObservationPlan<const Fields extends readonly AnyEvmObservationField[]>(
  fields: Fields,
  chain: string,
  signal: AbortSignal,
  params: IdleCdoParams,
  ctx?: AdapterContext,
): Promise<Awaited<ReturnType<typeof executeEvmObservationPlan<Fields>>>> {
  return executeEvmObservationPlan({
    adapterKey: ADAPTER_KEY,
    fields,
    read: (calls) => fetchOnchainMulticall3({
      calls,
      chain,
      signal,
      ctx,
      rpcUrl: params.rpcUrl ?? ETHEREUM_RPC_URL,
      fallbackRpcUrl: params.fallbackRpcUrl ?? ETHEREUM_FALLBACK_RPC_URL,
      timeoutMs: 12_000,
    }),
  });
}

export async function fetchIdleCdoEpochVariantReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = readParams(config);
  const trancheAddress = resolveCoinContractAddress(coin, input.chain);
  if (!trancheAddress) {
    throw new Error(`${ADAPTER_KEY}: no ${input.chain} contract configured for ${coin.id}`);
  }
  const cdoAddress = requireAddress(params.cdoAddress, "cdoAddress");
  const expectedUnderlying = requireAddress(params.underlyingAddress, "underlyingAddress");
  const normalizedTranche = requireAddress(trancheAddress, `${input.chain} tranche contract`);

  // One multicall3 round: the whole vault state plus the unlent ERC-20 balance
  // arrive in a single fetch, keeping the cron's shared 6-connection budget.
  const observed = await executeObservationPlan([
    abiObservation({
      label: "underlying",
      contract: cdoAddress,
      abi: IDLE_CDO_ABI,
      functionName: "token",
      verify: (value) =>
        normalizeEvmAddress(value as string) === expectedUnderlying
          ? null
          : `IdleCDO token() is ${String(value)}, expected ${expectedUnderlying}`,
    }),
    abiObservation({
      label: "aaTranche",
      contract: cdoAddress,
      abi: IDLE_CDO_ABI,
      functionName: "AATranche",
    }),
    abiObservation({
      label: "bbTranche",
      contract: cdoAddress,
      abi: IDLE_CDO_ABI,
      functionName: "BBTranche",
    }),
    abiObservation({
      label: "contractValue",
      contract: cdoAddress,
      abi: IDLE_CDO_ABI,
      functionName: "getContractValue",
    }),
    abiObservation({ label: "navAa", contract: cdoAddress, abi: IDLE_CDO_ABI, functionName: "lastNAVAA" }),
    abiObservation({ label: "navBb", contract: cdoAddress, abi: IDLE_CDO_ABI, functionName: "lastNAVBB" }),
    abiObservation({
      label: "unclaimedFees",
      contract: cdoAddress,
      abi: IDLE_CDO_ABI,
      functionName: "unclaimedFees",
    }),
    abiObservation({
      label: "epochDuration",
      contract: cdoAddress,
      abi: IDLE_CDO_ABI,
      functionName: "epochDuration",
    }),
    abiObservation({
      label: "epochEndDate",
      contract: cdoAddress,
      abi: IDLE_CDO_ABI,
      functionName: "epochEndDate",
    }),
    abiObservation({ label: "defaulted", contract: cdoAddress, abi: IDLE_CDO_ABI, functionName: "defaulted" }),
    abiObservation({
      label: "epochRunning",
      contract: cdoAddress,
      abi: IDLE_CDO_ABI,
      functionName: "isEpochRunning",
    }),
    abiObservation({
      label: "trancheSupply",
      contract: normalizedTranche,
      abi: TRANCHE_ABI,
      functionName: "totalSupply",
    }),
    abiObservation({
      label: "trancheMinter",
      contract: normalizedTranche,
      abi: TRANCHE_ABI,
      functionName: "minter",
      verify: (value) =>
        normalizeEvmAddress(value as string) === cdoAddress
          ? null
          : `tranche minter() is ${String(value)}, expected the configured IdleCDO ${cdoAddress}`,
    }),
    uint256Observation({
      label: "unlent",
      contract: expectedUnderlying,
      data: encodeBalanceOfCallData(cdoAddress),
    }),
  ] as const, input.chain, signal, params, ctx);

  const declaredTranche = normalizeEvmAddress(
    (params.tranche === "AA" ? observed.values.aaTranche : observed.values.bbTranche) as string,
  );
  if (declaredTranche !== normalizedTranche) {
    throw new Error(
      `${ADAPTER_KEY}: IdleCDO ${params.tranche}Tranche() is ${declaredTranche}, expected ${normalizedTranche}`,
    );
  }

  return adaptIdleCdoEpochVariantSnapshot({
    cdoAddress,
    trancheAddress: normalizedTranche,
    tranche: params.tranche,
    underlyingAddress: expectedUnderlying,
    underlyingDecimals: params.underlyingDecimals,
    contractValueRaw: observed.values.contractValue as bigint,
    unlentRaw: observed.values.unlent,
    navAaRaw: observed.values.navAa as bigint,
    navBbRaw: observed.values.navBb as bigint,
    unclaimedFeesRaw: observed.values.unclaimedFees as bigint,
    trancheSupplyRaw: observed.values.trancheSupply as bigint,
    epochDurationSec: observed.values.epochDuration as bigint,
    epochEndDateSec: observed.values.epochEndDate as bigint,
    defaulted: observed.values.defaulted as boolean,
    epochRunning: observed.values.epochRunning as boolean,
  }, params);
}
