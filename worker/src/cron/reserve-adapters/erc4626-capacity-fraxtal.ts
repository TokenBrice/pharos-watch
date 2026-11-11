import { reserveDegradedWarning } from "./helpers";
import { observeSfrxusdCrosschainRedemptionRoute } from "./sfrxusd-crosschain-redemption";
import {
  makeObservation, makeUnavailableObservation, routeForSource,
  type Erc4626CapacityObservation, type Erc4626RedemptionLiquidityConfig, type ObserveConfiguredErc4626CapacityInput,
} from "./erc4626-capacity-observation";

export async function observeFraxtalHopCapacity(
  input: ObserveConfiguredErc4626CapacityInput,
  configured: Extract<Erc4626RedemptionLiquidityConfig, { source: "fraxtal-hop-withdrawable" }>,
): Promise<Erc4626CapacityObservation> {
  const attempt = await observeSfrxusdCrosschainRedemptionRoute(
    configured,
    input.contractAddress,
    input.signal,
    input.ctx,
    {
      ethereumRpcUrls: [input.rpcUrl, input.fallbackRpcUrl].filter(
        (url): url is string => Boolean(url),
      ),
    },
  );
  if (attempt.status === "accepted") {
    const capacityRaw = BigInt(attempt.state.capacity.cappedPreviewOutputFrxUsdRaw);
    const settlementBoundUnproven = attempt.state.settlementUpperBoundSec == null
      || attempt.state.settlementEvidence === "unbounded";
    return makeObservation(
      "fraxtal-hop-withdrawable",
      capacityRaw,
      18,
      [],
      {
        freshnessKind: "same-run-onchain",
        routeStatusSource: "onchain",
        capacityKind: settlementBoundUnproven ? "documented-bound" : "live-direct-bounded",
        ...(settlementBoundUnproven ? { settlementBoundUnproven: true } : {}),
        sourceTimestamp: Math.min(
          attempt.state.ethereumBlock.blockTimestamp,
          attempt.state.fraxtalBlock.blockTimestamp,
        ),
        sourceUrls: attempt.state.sourceUrls,
        holderEligibility: "any-holder",
        routeStatus: "open",
      },
      {},
      settlementBoundUnproven ? {} : { sfrxusdCrosschainWithdrawableRaw: capacityRaw.toString() },
      attempt,
    );
  }
  return makeUnavailableObservation(
    "fraxtal-hop-withdrawable",
    null,
    18,
    [
      reserveDegradedWarning(
        `sfrxusd-crosschain-redemption-${attempt.rejectionCode}`,
        `sfrxUSD cross-chain redemption route validation failed closed: ${attempt.rejectionCode}`,
      ),
    ],
    {
      ...routeForSource("fraxtal-hop-withdrawable"),
      ...(attempt.rejectionCode === "route-paused" ? {
        routeStatus: "paused",
        routeStatusSource: "onchain",
        routeStatusReason: "sfrxUSD cross-chain route pause observed on-chain",
      } : {}),
    },
    attempt,
  );
}
