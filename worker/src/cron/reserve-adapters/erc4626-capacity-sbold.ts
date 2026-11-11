import { decodeAbiWordAt, decodeUint256Word } from "./abi-decode";
import { reserveInfoWarning } from "./helpers";
import { probeFailure, routeForSource, type CapacityProbeResult, type ObserveConfiguredErc4626CapacityInput } from "./erc4626-capacity-observation";

// K3 sBOLD calcFragments() -> (totalBold, boldAmount, collValue, collInBold).
// Word index 1 (boldAmount) is the compounded BOLD across the vault's Liquity V2
// Stability Pools — the on-demand SP-withdrawable amount that sBOLD._maxWithdraw
// caps redemptions at, and which excludes not-yet-swapped collateral (index 3).
const SBOLD_CALC_FRAGMENTS_SELECTOR = "0x160b71df";
const SBOLD_CALC_FRAGMENTS_LIQUID_BOLD_WORD_INDEX = 1;
const SBOLD_CALC_FRAGMENTS_COLL_IN_BOLD_WORD_INDEX = 3;
// BaseSBold.maxCollInBold(); sBOLD._checkCollHealth() permits withdrawals only
// while calcFragments().collInBold <= this owner-configured threshold.
const SBOLD_MAX_COLL_IN_BOLD_SELECTOR = "0xbf2428e6";

export async function fetchSboldSpWithdrawableCapacity(input: Pick<ObserveConfiguredErc4626CapacityInput, "coinId" | "call">): Promise<CapacityProbeResult> {
  const [result, maxCollInBoldResult] = await Promise.all([
    input.call(SBOLD_CALC_FRAGMENTS_SELECTOR),
    input.call(SBOLD_MAX_COLL_IN_BOLD_SELECTOR),
  ]);
  const withdrawableRaw = decodeUint256Word(
    decodeAbiWordAt(result, SBOLD_CALC_FRAGMENTS_LIQUID_BOLD_WORD_INDEX),
  );
  if (withdrawableRaw == null) {
    return probeFailure("sbold-sp-withdrawable-unavailable", `sBOLD calcFragments() Stability-Pool-withdrawable probe failed for ${input.coinId}`);
  }
  const collInBoldRaw = decodeUint256Word(
    decodeAbiWordAt(result, SBOLD_CALC_FRAGMENTS_COLL_IN_BOLD_WORD_INDEX),
  );
  const maxCollInBoldRaw = decodeUint256Word(decodeAbiWordAt(maxCollInBoldResult, 0));
  const collateralHealthGate =
    collInBoldRaw == null || maxCollInBoldRaw == null
      ? "unreadable"
      : collInBoldRaw <= maxCollInBoldRaw
        ? "open"
        : "restricted";
  return {
    capacityRaw: withdrawableRaw,
    warnings: collateralHealthGate === "unreadable"
      ? [reserveInfoWarning(
          "sbold-collateral-health-unavailable",
          `sBOLD collateral-health gate could not be read for ${input.coinId}`,
        )]
      : [],
    route: {
      ...routeForSource("sbold-sp-withdrawable"),
      capacityKind: collateralHealthGate === "open" ? "live-direct" : "documented-bound",
    },
    diagnostics: { collateralHealthGate },
    telemetry: { sboldSpWithdrawableRaw: withdrawableRaw.toString() },
  };
}
