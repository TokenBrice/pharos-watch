import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { RedemptionRouteStatus } from "@shared/types/redemption";
import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs";
import type { AdapterContext, AdapterResult } from "./types";
import { decimalNumberFromBigInt, makeOnchainCallers, probeTrackedTokenSupply, reserveInfoWarning } from "./helpers";
import { parseEvmAddressResult } from "./evm";
import { decodeStrictBoolWord } from "./abi-decode";
import { encodeBalanceOfCallData } from "../../lib/evm-selectors";
import { rethrowIfAborted } from "../../lib/abort";

type CuratedValidatedParams = LiveReserveAdapterParamsByKey["curated-validated"];
type RedemptionCapacityParams = NonNullable<CuratedValidatedParams["redemptionCapacity"]>;

interface CuratedRedemptionProbe {
  capacityUsd: number;
  capacityRaw: string;
  /** `null` when the coin pinned no pause getter. */
  paused: boolean | null;
}

function capacityCallData(read: RedemptionCapacityParams["capacityRead"]): string {
  return read.kind === "erc20-balance-of" ? encodeBalanceOfCallData(read.holder) : read.selector;
}

/**
 * Same-run read of an opted-in coin's executable redemption capacity. Every
 * pinned identity must still resolve and every read must succeed, otherwise the
 * probe returns `null` and the caller keeps the curated slices and the static
 * redemption block rather than publishing an unproven live route.
 */
async function probeRedemptionCapacity(
  params: CuratedValidatedParams,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<CuratedRedemptionProbe | null> {
  const capacity = params.redemptionCapacity;
  if (!capacity) return null;

  const onchain = makeOnchainCallers(
    { chain: capacity.chain },
    { signal, ctx, rpcUrl: params.rpcUrl, fallbackRpcUrl: params.fallbackRpcUrl },
  );
  const identityChecks = capacity.identityChecks ?? [];

  try {
    const [identityResults, capacityRaw, pausedRaw] = await Promise.all([
      Promise.all(identityChecks.map((check) => onchain.raw(check.contract, check.selector))),
      onchain.uint256(capacity.capacityRead.contract, capacityCallData(capacity.capacityRead)),
      capacity.pauseCheck ? onchain.raw(capacity.pauseCheck.contract, capacity.pauseCheck.selector) : null,
    ]);

    for (const [index, check] of identityChecks.entries()) {
      const raw = identityResults[index];
      const observed = raw ? parseEvmAddressResult(raw as `0x${string}`) : null;
      if (observed !== check.expectedAddress.toLowerCase()) return null;
    }

    if (capacityRaw == null || capacityRaw < 0n) return null;

    let paused: boolean | null = null;
    if (capacity.pauseCheck) {
      paused = decodeStrictBoolWord(pausedRaw);
      if (paused == null) return null;
    }

    const capacityUsd = decimalNumberFromBigInt(capacityRaw, capacity.decimals);
    if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;

    return { capacityUsd, capacityRaw: capacityRaw.toString(), paused };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return null;
  }
}

/** Openness is asserted only when the route can actually pay out this run; a
 *  measured zero is no evidence either way, so it defers to the static config. */
function liveRouteStatus(
  capacity: RedemptionCapacityParams,
  probe: CuratedRedemptionProbe,
  staticRouteStatus: RedemptionRouteStatus,
) {
  if (probe.paused === true) {
    return {
      routeStatus: "paused" as const,
      routeStatusSource: "onchain" as const,
      routeStatusReason: `${capacity.pauseCheck!.contract} pause getter ${capacity.pauseCheck!.selector} returned true in the same run`,
    };
  }
  if (probe.capacityUsd > 0) {
    return {
      routeStatus: "open" as const,
      routeStatusSource: "onchain" as const,
      routeStatusReason: `${capacity.capacityRead.contract} read in the same run on ${capacity.chain}: ${probe.capacityRaw} (${capacity.decimals} decimals)${probe.paused === false ? ", pause getter false" : ""}`,
    };
  }
  return { routeStatus: staticRouteStatus, routeStatusSource: "static-config" as const };
}

/**
 * Adapter that validates on-chain supply is non-zero, then returns the
 * coin's curated `reserves` array as live slices.  This gives multi-component
 * reserve visibility for coins that lack a dedicated transparency API but
 * have well-researched curated reserve breakdowns.
 *
 * Coins that additionally pin a `redemptionCapacity` params block get a live
 * same-run read of their executable exit route; every other coin keeps the
 * static redemption block untouched.
 */
export async function fetchCuratedValidatedReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  if (!coin.reserves || coin.reserves.length === 0) {
    throw new Error("curated-validated adapter requires coin.reserves to be defined and non-empty");
  }

  const params = parseLiveReserveAdapterParams("curated-validated", config.params);
  const [totalSupply, probe] = await Promise.all([
    probeTrackedTokenSupply(
      coin, config.inputs.primary, signal, "curated-validated", ctx, params.rpcUrl, params.fallbackRpcUrl,
    ),
    probeRedemptionCapacity(params, signal, ctx),
  ]);
  const routeStatus = REDEMPTION_BACKSTOP_CONFIGS[coin.id]?.routeStatus ?? "unknown";
  const capacity = params.redemptionCapacity;
  const warnings: LiveReserveWarning[] = [];
  if (capacity && probe == null) {
    warnings.push(
      reserveInfoWarning(
        "curated-redemption-capacity-unreadable",
        `curated-validated redemption probe for ${coin.id} did not return a matching identity/capacity set this run; live redemption telemetry withheld`,
      ),
    );
  }

  return {
    slices: coin.reserves,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      totalSupplyRaw: totalSupply.toString(),
      redemption: capacity && probe
        ? {
            capacityUsd: probe.capacityUsd,
            capacityKind: "live-direct" as const,
            freshnessKind: "same-run-onchain" as const,
            holderEligibility: capacity.holderEligibility,
            settlementDelaySec: 0,
            ...liveRouteStatus(capacity, probe, routeStatus),
            sourceUrls: [...capacity.sourceUrls],
          }
        : {
            capacityKind: "documented-eventual" as const,
            freshnessKind: "same-run-onchain" as const,
            routeStatus,
            routeStatusSource: "static-config" as const,
          },
    },
  };
}
