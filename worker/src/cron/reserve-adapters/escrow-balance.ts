import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { RedemptionRouteStatus } from "@shared/types/redemption";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
} from "./helpers";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER = "escrow-balance";

type EscrowBalanceParams = LiveReserveAdapterParamsByKey[typeof ADAPTER];

function readSlice(params: EscrowBalanceParams): ReserveSlice {
  return {
    name: params.slice.name,
    pct: 100,
    risk: params.slice.risk,
    ...(params.slice.coinId ? { coinId: params.slice.coinId } : {}),
    ...(params.slice.depType ? { depType: params.slice.depType } : {}),
  };
}

function encodeCall(params: EscrowBalanceParams): string {
  return `${params.selector}${(params.args ?? []).map((word) => word.slice(2)).join("")}`;
}

/**
 * Reads the redemption capacity of a coin whose exit route is paid out of one
 * pinned escrow/reserve contract, via a single token-denominated view call. The
 * escrow lives on the chain named by the primary input, which is normally not
 * the chain the tracked coin circulates on (Circle xReserve holds Ethereum USDC
 * for tokens issued on a remote domain), so the contract is pinned in params
 * rather than resolved from the coin's own deployments.
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

  const escrowBalanceRaw = await onchain.uint256(params.contract, encodeCall(params));
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

  return {
    slices: [readSlice(params)],
    metadata: {
      ...notApplicableFreshnessMetadata({ proofKind: "escrow-balance-view" }),
      chain: input.chain,
      contractAddress: params.contract,
      escrowBalanceRaw: escrowBalanceRaw.toString(),
      escrowBalanceUsd,
      immediateRedeemableUsd: escrowBalanceUsd,
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: escrowBalanceUsd,
        capacityKind: "live-direct",
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
