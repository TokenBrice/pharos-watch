import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { RedemptionRouteStatus } from "@shared/types/redemption";
import { TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import { validateDecimals } from "./slice-math";
import {
  buildCoverageShortfallWarnings,
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
} from "./helpers";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER = "escrow-balance";
const ERC20_BALANCE_OF_SELECTOR = "0x70a08231";
const MAX_MULTI_READS = 16;

type EscrowBalanceParams = LiveReserveAdapterParamsByKey[typeof ADAPTER];
type EscrowBalanceMultiParams = Extract<EscrowBalanceParams, { reads: unknown }>;

function readSlice(params: EscrowBalanceParams): ReserveSlice {
  const escrowContract = "reads" in params ? params.reads[0]!.contract : params.contract;
  return {
    sourceKey: `escrow-balance:${escrowContract.toLowerCase()}`,
    name: params.slice.name,
    pct: 100,
    risk: params.slice.risk,
    ...(params.slice.coinId ? { coinId: params.slice.coinId } : {}),
    ...(params.slice.depType ? { depType: params.slice.depType } : {}),
    ...(params.slice.blacklistable != null ? { blacklistable: params.slice.blacklistable } : {}),
  };
}

function encodeSelectorCall(selector: string, args?: readonly string[]): string {
  return `${selector}${(args ?? []).map((word) => word.slice(2)).join("")}`;
}

function encodeErc20BalanceOfCall(holder: string): string {
  return `${ERC20_BALANCE_OF_SELECTOR}${holder.slice(2).toLowerCase().padStart(64, "0")}`;
}

function parseFirstUint256Word(result: string | null): bigint | null {
  if (result == null || !/^0x[0-9a-fA-F]{64,}$/.test(result)) return null;
  return BigInt(`0x${result.slice(2, 66)}`);
}

async function fetchMultiReadCapacity(
  coin: StablecoinMeta,
  params: EscrowBalanceMultiParams,
  onchain: ReturnType<typeof makeOnchainCallers>,
): Promise<{
  capacityRaw: string[];
  capacityUsd: number;
  routeStatus: RedemptionRouteStatus;
  routeStatusReason: string;
}> {
  if (params.reads.length > MAX_MULTI_READS) {
    throw new Error(`${ADAPTER}: capacity read count exceeds ${MAX_MULTI_READS} for ${coin.id}`);
  }

  const capacityRaw: string[] = [];
  let capacityUsd = 0;

  for (const [index, read] of params.reads.entries()) {
    if (read.identityCheck) {
      const identityRaw = await onchain.uint256(
        read.contract,
        encodeSelectorCall(read.identityCheck.selector, read.identityCheck.args),
      );
      if (identityRaw == null) {
        throw new Error(`${ADAPTER}: identity check ${index + 1} failed for ${coin.id}`);
      }
      if (identityRaw !== BigInt(read.identityCheck.expectedAddress)) {
        throw new Error(`${ADAPTER}: identity check ${index + 1} mismatch for ${coin.id}`);
      }
    }

    const valueRaw = "selector" in read
      ? parseFirstUint256Word(
          await onchain.raw(read.contract, encodeSelectorCall(read.selector, read.args)),
        )
      : await onchain.uint256(read.contract, encodeErc20BalanceOfCall(read.erc20BalanceOf));
    if (valueRaw == null) {
      throw new Error(`${ADAPTER}: capacity read ${index + 1} failed for ${coin.id}`);
    }

    capacityRaw.push(valueRaw.toString());
    capacityUsd += decimalNumberFromBigInt(valueRaw, read.decimals);
  }

  let paused = false;
  if (params.pauseCheck) {
    const pausedRaw = await onchain.uint256(
      params.pauseCheck.contract,
      encodeSelectorCall(params.pauseCheck.selector, params.pauseCheck.args),
    );
    if (pausedRaw == null) {
      throw new Error(`${ADAPTER}: pause check failed for ${coin.id}`);
    }
    paused = pausedRaw !== 0n;
  }

  if (paused) {
    return {
      capacityRaw,
      capacityUsd,
      routeStatus: "paused",
      routeStatusReason: "Configured on-chain redemption pause check returned true",
    };
  }
  if (capacityUsd > 0) {
    return {
      capacityRaw,
      capacityUsd,
      routeStatus: "open",
      routeStatusReason: params.pauseCheck
        ? `${params.reads.length} pinned capacity reads succeeded with a positive sum and the on-chain pause check returned false`
        : `${params.reads.length} pinned capacity reads succeeded with a positive sum`,
    };
  }
  return {
    capacityRaw,
    capacityUsd,
    routeStatus: "unknown",
    routeStatusReason: `${params.reads.length} pinned capacity reads succeeded but summed capacity is zero`,
  };
}

function compareEscrowSupply(balanceUsd: number, supplyUsd: number | undefined) {
  const coverageRatio = supplyUsd == null ? undefined : balanceUsd / supplyUsd;
  return {
    warnings: buildCoverageShortfallWarnings({
      code: "reserve-undercollateralized",
      message: (pct) => `Escrow backing covers ${pct}% of coin supply`,
      coverageRatio,
    }),
    metadata: supplyUsd == null ? {} : {
      totalReserveUsd: balanceUsd,
      supplyUsd,
      collateralizationRatio: coverageRatio,
    },
    capacityUsd: supplyUsd == null ? balanceUsd : Math.min(balanceUsd, supplyUsd),
    capacityRatioOfSupply: coverageRatio == null ? undefined : Math.min(1, coverageRatio),
  };
}

/**
 * Reads the redemption capacity of a coin whose exit route is paid out of
 * reviewer-pinned escrow/reserve state. The original mode performs one
 * token-denominated view call; the bounded multi-read mode sums several pinned
 * selector or ERC-20 balance reads and withholds the observation if any read or
 * identity check fails. Contracts are config-owned rather than resolved from
 * the coin's deployments because the payout state can live elsewhere.
 */
export async function fetchEscrowBalanceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER);
  const params = parseLiveReserveAdapterParams(ADAPTER, config.params);

  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });

  let supplyUsd: number | undefined;
  if (params.compareToCoinSupply) {
    const contract = coin.contracts?.find((deployment) => deployment.chain === input.chain);
    if (!contract) throw new Error(`${ADAPTER}: no ${input.chain} coin contract configured for ${coin.id}`);
    const decimals = validateDecimals(contract.decimals, `${ADAPTER} coin supply decimals`);
    const supplyRaw = await onchain.uint256(contract.address, TOTAL_SUPPLY_SELECTOR);
    if (supplyRaw == null || supplyRaw <= 0n) {
      throw new Error(`${ADAPTER}: totalSupply() failed for ${coin.id}`);
    }
    supplyUsd = decimalNumberFromBigInt(supplyRaw, decimals);
  }

  if ("reads" in params) {
    const multiRead = await fetchMultiReadCapacity(coin, params, onchain);
    const contractAddresses = [...new Set(params.reads.map((read) => read.contract))];
    const comparison = compareEscrowSupply(multiRead.capacityUsd, supplyUsd);

    return {
      slices: [readSlice(params)],
      ...(comparison.warnings.length > 0 ? { warnings: comparison.warnings } : {}),
      metadata: {
        ...notApplicableFreshnessMetadata({ proofKind: "escrow-balance-view" }),
        chain: input.chain,
        contractAddresses,
        escrowBalanceReadCount: params.reads.length,
        escrowBalancesRaw: multiRead.capacityRaw,
        escrowBalanceUsd: multiRead.capacityUsd,
        ...comparison.metadata,
        ...buildRedemptionSnapshotMetadata({
          capacityUsd: multiRead.routeStatus === "paused" ? 0 : comparison.capacityUsd,
          ...(comparison.capacityRatioOfSupply != null ? {
            capacityRatioOfSupply: multiRead.routeStatus === "paused" ? 0 : comparison.capacityRatioOfSupply,
          } : {}),
          capacityKind: supplyUsd == null ? "live-direct" : "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          routeStatus: multiRead.routeStatus,
          routeStatusSource: "onchain",
          routeStatusReason: multiRead.routeStatusReason,
          ...(params.holderEligibility ? { holderEligibility: params.holderEligibility } : {}),
          ...(params.settlementDelaySec != null
            ? { settlementDelaySec: params.settlementDelaySec }
            : {}),
          sourceUrls: params.sourceUrls,
        }),
      },
    };
  }

  const escrowBalanceRaw = await onchain.uint256(
    params.contract,
    encodeSelectorCall(params.selector, params.args),
  );
  if (escrowBalanceRaw == null) {
    throw new Error(`${ADAPTER}: escrow balance call failed for ${coin.id}`);
  }
  if (escrowBalanceRaw <= 0n) {
    throw new Error(`${ADAPTER}: escrow balance is zero for ${coin.id}`);
  }

  let routeStatus: RedemptionRouteStatus = "open";
  if (params.pausedSelector) {
    const pausedRaw = await onchain.uint256(params.contract, params.pausedSelector);
    if (pausedRaw == null) {
      throw new Error(`${ADAPTER}: pause check failed for ${coin.id}`);
    }
    routeStatus = pausedRaw === 0n ? "open" : "paused";
  }

  const escrowBalanceUsd = decimalNumberFromBigInt(escrowBalanceRaw, params.decimals);
  const comparison = compareEscrowSupply(escrowBalanceUsd, supplyUsd);

  return {
    slices: [readSlice(params)],
    ...(comparison.warnings.length > 0 ? { warnings: comparison.warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({ proofKind: "escrow-balance-view" }),
      chain: input.chain,
      contractAddress: params.contract,
      escrowBalanceRaw: escrowBalanceRaw.toString(),
      escrowBalanceUsd,
      ...comparison.metadata,
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: routeStatus === "paused" ? 0 : comparison.capacityUsd,
        ...(comparison.capacityRatioOfSupply != null ? {
          capacityRatioOfSupply: routeStatus === "paused" ? 0 : comparison.capacityRatioOfSupply,
        } : {}),
        capacityKind: supplyUsd == null ? "live-direct" : "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus,
        routeStatusSource: "onchain",
        ...(params.holderEligibility ? { holderEligibility: params.holderEligibility } : {}),
        ...(params.settlementDelaySec != null
          ? { settlementDelaySec: params.settlementDelaySec }
          : {}),
        sourceUrls: params.sourceUrls,
      }),
    },
  };
}
