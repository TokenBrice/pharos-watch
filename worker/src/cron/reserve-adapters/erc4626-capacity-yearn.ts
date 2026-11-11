import { encodeAddress } from "../../lib/evm-selectors";
import { decodeAbiWordAt, decodeStrictAddressArrayWord, decodeUint256Word } from "./abi-decode";
import { fetchOnchainMulticall3 } from "./helpers";
import { multicallResultOrNull } from "./erc4626";
import { probeFailure, type CapacityProbeResult, type ObserveConfiguredErc4626CapacityInput } from "./erc4626-capacity-observation";

type OnchainProbeInput = Pick<ObserveConfiguredErc4626CapacityInput, "coinId" | "contractAddress" | "signal" | "ctx" | "rpcMode" | "chain" | "rpcUrl" | "fallbackRpcUrl" | "timeoutMs">;

const YEARN_V3_TOTAL_IDLE_SELECTOR = "0x9aa7df94";
const YEARN_V3_GET_DEFAULT_QUEUE_SELECTOR = "0xa9bbf1cc";
const YEARN_V3_STRATEGIES_SELECTOR = "0x39ebf823";
// TokenizedStrategy.maxWithdraw(owner) returns convertToAssets(maxRedeem(owner))
// verbatim (ERC-4626; Yearn v3 strategies implement it as a one-liner), so the
// per-strategy loose-funds read collapses to a single call and the whole Yearn
// probe fits in two Multicall3 waves instead of up to 30 sequential RPCs.
const YEARN_V3_MAX_WITHDRAW_SELECTOR = "0xce96cb77";
const MAX_YEARN_V3_QUEUE_LENGTH = 10;
export async function fetchYearnV3WithdrawableCapacity(input: OnchainProbeInput & { settlementDelaySec?: number }): Promise<CapacityProbeResult> {
  // Wave 1: the strategy list. Wave 2 depends on the decoded queue, so the
  // two waves are the lower bound; both ride the shared Multicall3 limiter.
  const listResults = await fetchOnchainMulticall3({
    calls: [
      { label: "yearn-total-idle", contract: input.contractAddress, data: YEARN_V3_TOTAL_IDLE_SELECTOR },
      { label: "yearn-default-queue", contract: input.contractAddress, data: YEARN_V3_GET_DEFAULT_QUEUE_SELECTOR },
    ],
    signal: input.signal,
    ctx: input.ctx,
    chain: input.chain,
    rpcUrl: input.rpcUrl,
    fallbackRpcUrl: input.fallbackRpcUrl,
    timeoutMs: input.timeoutMs,
  });
  const totalIdleResult = multicallResultOrNull(listResults, "yearn-total-idle");
  const defaultQueueResult = multicallResultOrNull(listResults, "yearn-default-queue");
  if (!totalIdleResult || !defaultQueueResult) {
    return probeFailure("yearn-v3-withdrawable-unavailable", `Yearn V3 withdrawable-capacity probes failed for ${input.coinId}`);
  }

  const defaultQueue = decodeStrictAddressArrayWord(defaultQueueResult, {
    maxItems: MAX_YEARN_V3_QUEUE_LENGTH,
  });
  const totalIdleRaw = decodeUint256Word(decodeAbiWordAt(totalIdleResult, 0));
  if (totalIdleRaw == null) {
    return probeFailure("yearn-v3-total-idle-malformed", `Yearn V3 totalIdle() could not be decoded for ${input.coinId}`);
  }
  if (defaultQueue == null) {
    return probeFailure("yearn-v3-default-queue-malformed", `Yearn V3 default withdrawal queue could not be decoded for ${input.coinId}`);
  }

  // Wave 2: per-strategy debt and loose-funds reads in one pinned batch.
  const strategyCalls = defaultQueue.flatMap((strategyAddress, index) => [
    {
      label: `yearn-strategy-${index}-params`,
      contract: input.contractAddress,
      data: `${YEARN_V3_STRATEGIES_SELECTOR}${encodeAddress(strategyAddress)}`,
    },
    {
      label: `yearn-strategy-${index}-max-withdraw`,
      contract: strategyAddress,
      data: `${YEARN_V3_MAX_WITHDRAW_SELECTOR}${encodeAddress(input.contractAddress)}`,
    },
  ]);
  const strategyResults = strategyCalls.length > 0
    ? await fetchOnchainMulticall3({
        calls: strategyCalls,
        signal: input.signal,
        ctx: input.ctx,
        chain: input.chain,
        rpcUrl: input.rpcUrl,
        fallbackRpcUrl: input.fallbackRpcUrl,
        timeoutMs: input.timeoutMs,
      })
    : [];

  let withdrawableRaw = totalIdleRaw;
  for (const [index, strategyAddress] of defaultQueue.entries()) {
    const currentDebtRaw = decodeUint256Word(decodeAbiWordAt(
      multicallResultOrNull(strategyResults, `yearn-strategy-${index}-params`),
      2,
    ));
    if (currentDebtRaw == null) {
      return probeFailure("yearn-v3-strategy-debt-unavailable", `Yearn V3 strategy debt could not be decoded for ${input.coinId} strategy ${strategyAddress}`);
    }
    if (currentDebtRaw === 0n) continue;

    const strategyWithdrawableRaw = decodeUint256Word(
      multicallResultOrNull(strategyResults, `yearn-strategy-${index}-max-withdraw`),
    );
    if (strategyWithdrawableRaw == null) {
      return probeFailure("yearn-v3-strategy-max-withdraw-unavailable", `Yearn V3 strategy maxWithdraw() failed for ${input.coinId} strategy ${strategyAddress}`);
    }
    if (strategyWithdrawableRaw === 0n) continue;

    withdrawableRaw += strategyWithdrawableRaw > currentDebtRaw ? currentDebtRaw : strategyWithdrawableRaw;
  }

  const settlementDelaySec = input.settlementDelaySec ?? 0;
  return {
    capacityRaw: withdrawableRaw,
    warnings: [],
    route: {
      freshnessKind: "same-run-onchain",
      settlementDelaySec,
      ...(settlementDelaySec > 0 ? { capacityKind: "documented-bound" as const } : {}),
    },
    telemetry: { yearnV3WithdrawableRaw: withdrawableRaw.toString() },
  };
}
