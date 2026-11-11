import { pinnedBlockPlan } from "./evm-observation-plan";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { MATERIAL_UNKNOWN_EXPOSURE_PCT } from "@shared/types/live-reserve-adapter-policy";
import { createAdapterIoLimiter } from "./concurrency";
import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { encodeAddressCallData } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildCoverageShortfallWarnings,
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  makeOnchainCallers,
  probeOptionalRedemptionRateBps,
  requireOnchainInput,
  reserveInfoWarning,
} from "./helpers";
import {
  adaptBranchBalanceReserves,
  fetchBranchBalances,
  fetchBranchPriceMap,
  readBranchBalanceParams,
} from "./branch-balances";
import { decodeUint256Word } from "./abi-decode";
import { addressFromWord, decodeWords, decodeUintArray } from "./evm-branch-observation";
import { observeHoneyFactoryRedemptionCapacity, type RedemptionCapacityObservation } from "./honey-factory";
import { applyBabelFishAccounting } from "./babelfish";
import type { BranchPriceObservation } from "./branch-balances";
import { hasDegradingWarnings, hasFatalWarnings } from "./validate";

const ADAPTER_KEY = "evm-branch-balances";
const DEFAULT_DEBT_DECIMALS = 18;
export async function fetchEvmBranchBalancesReserves(
  _coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = readBranchBalanceParams(config, ADAPTER_KEY);
  const attemptCtx = { ...ctx, ioLimiter: ctx?.ioLimiter ?? createAdapterIoLimiter(2) };
  const plan = await pinnedBlockPlan({ chain: input.chain, signal, ctx: attemptCtx, ...params });
  ctx = plan.ctx;
  const onchain = makeOnchainCallers(input, {
    signal, ctx, rpcUrl: params.rpcUrl, fallbackRpcUrl: params.fallbackRpcUrl,
  });
  if (params.priceOracle && params.branches.some((branch) =>
    (branch.chain ?? branch.token.chain) !== input.chain || branch.priceUsd != null
  )) {
    throw new Error(`${ADAPTER_KEY}: pinned price oracle requires same-chain branches without fixed prices`);
  }
  const reviewedCensusStartSec = params.census?.kind === "reviewed-roster"
    ? Date.parse(`${params.census.reviewedAt}T00:00:00Z`) / 1000 : null;
  let censusComplete = false;
  if (params.census?.kind === "reviewed-roster") {
    const reviewStartSec = reviewedCensusStartSec!;
    const clockSec = attemptCtx.nowSec ?? Math.floor(Date.now() / 1000);
    const maxAgeSec = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec;
    // Date-only reviews must have elapsed before both the attempt and its
    // pinned observation, and freshness conservatively starts at midnight.
    censusComplete = Number.isFinite(reviewStartSec) &&
      reviewStartSec + 86400 <= Math.min(clockSec, plan.observedBlock.timestamp) &&
      clockSec - reviewStartSec <= maxAgeSec;
  }
  if (params.census?.kind === "onchain-registry") {
    const census = params.census;
    if (params.branches.length > census.maxAssets ||
        params.branches.some((branch) => (branch.chain ?? branch.token.chain) !== input.chain)) {
      throw new Error(`${ADAPTER_KEY}: registry census exceeds its bound or crosses chains`);
    }
    const registryRaw = await onchain.raw(census.contract, census.selector);
    const registryWords = decodeWords(registryRaw, "reserve registry");
    if (registryWords[0] !== 32n || registryWords.length !== params.branches.length + 2) {
      throw new Error(`${ADAPTER_KEY}: reserve registry census length or ABI layout changed`);
    }
    const assets = decodeUintArray(
      registryRaw,
      params.branches.length,
      "reserve registry",
    ).map((address) => addressFromWord(address, "reserve registry asset").toLowerCase());
    const configured = new Set(params.branches.map((branch) =>
      (census.identity === "holder" ? branch.holder : branch.token.address).toLowerCase()));
    if (configured.size !== params.branches.length || new Set(assets).size !== assets.length ||
        assets.some((address) => !configured.has(address))) {
      throw new Error(`${ADAPTER_KEY}: reserve registry drift; reviewed constituents no longer match`);
    }
    censusComplete = true;
  }
  const chainPlans = new Map([[input.chain, plan]]);
  for (const branch of params.branches) {
    const chain = branch.chain ?? input.chain;
    if (!chainPlans.has(chain)) {
      chainPlans.set(chain, await pinnedBlockPlan({
        chain, signal, ctx: { ...attemptCtx, observedBlock: undefined },
      }));
    }
  }
  if (censusComplete && reviewedCensusStartSec !== null) {
    for (const chainPlan of chainPlans.values()) {
      if (reviewedCensusStartSec + 86400 > chainPlan.observedBlock.timestamp) {
        censusComplete = false;
        break;
      }
    }
  }
  const balanceGroups = [...chainPlans].map(([chain, chainPlan]) => {
    const branches = params.branches.filter((branch) => (branch.chain ?? input.chain) === chain);
    return branches.length === 0 ? Promise.resolve([]) : fetchBranchBalances(
      { ...input, chain },
      { ...params, branches, ...(chain !== input.chain ? { rpcUrl: undefined, fallbackRpcUrl: undefined } : {}) },
      signal, chainPlan.ctx,
    );
  });
  const observationDetails = {
    ...(chainPlans.size > 1
      ? { observedBlocks: [...chainPlans.values()].map((entry) => entry.observedBlock) }
      : {}),
    censusScope: params.census?.kind ?? "configured-branches",
    ...(params.census ? { census: params.census } : {}),
    ...(params.priceOracle ? { priceOracle: params.priceOracle } : {}),
  };
  const debtSelector = params.debtSelector;
  const debtDecimals = params.debtDecimals ?? DEFAULT_DEBT_DECIMALS;
  const redemptionCapacityParams = params.redemptionCapacity;

  const [balances, redemptionFeeBps, debtRaw, redemptionCapacity] = await Promise.all([
    Promise.all(balanceGroups).then((groups) => groups.flat()),
    probeOptionalRedemptionRateBps(
      input,
      params.redemptionRateProbe,
      signal,
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    ),
    debtSelector
      ? onchain.raw(params.debtContract ?? params.branches[0].holder, debtSelector).then(decodeUint256Word)
      : Promise.resolve(null),
    redemptionCapacityParams?.kind === "honey-factory-vaults"
      ? observeHoneyFactoryRedemptionCapacity(
          input,
          redemptionCapacityParams,
          signal,
          ctx,
          params.rpcUrl,
          params.fallbackRpcUrl,
        )
      : Promise.resolve<RedemptionCapacityObservation>({ warnings: [] }),
  ]);

  // A configured liability read is mandatory, not optional telemetry: do not
  // publish collateral alone when the reserve/supply reconciliation is missing.
  if (debtSelector && debtRaw == null) {
    throw new Error(`${ADAPTER_KEY}: configured liability read unavailable or malformed; cannot reconcile reserves`);
  }

  // Honey custody composition: a custody-mode vault's idle balance is not the
  // backing. The factory-owned net vault shares (shares minus collected fees)
  // converted to underlying assets are the vault's claim, so branch balances
  // whose holder is a custody vault (or its custody wallet) are replaced by
  // the net-share conversion observed in the same multicall round.
  if (redemptionCapacityParams?.kind === "honey-factory-vaults") {
    const custodyBackingByHolder = redemptionCapacity.custodyBackingByHolder;
    if (custodyBackingByHolder == null) {
      throw new Error(
        `${ADAPTER_KEY}: HoneyFactory vault state unavailable; cannot derive custody-mode branch composition: ${
          redemptionCapacity.errorMessage ?? "unknown failure"
        }`,
      );
    }
    for (const entry of balances) {
      const chain = entry.branch.chain ?? input.chain;
      const custodyBacking = custodyBackingByHolder.get(
        `${chain}:${entry.branch.holder.toLowerCase()}`,
      );
      if (custodyBacking != null) {
        entry.balanceRaw = custodyBacking;
      }
    }
  }

  const priceMapWarnings: LiveReserveWarning[] = [];
  const priceObservations = new Map<string, BranchPriceObservation>();
  const priceMap = params.priceOracle
    ? new Map((await Promise.all(balances.map(async ({ branch, balanceRaw }) => {
        if (balanceRaw == null || balanceRaw === 0n) return null;
        const oracle = params.priceOracle!;
        const raw = await onchain.uint256(
          oracle.contract, encodeAddressCallData(oracle.selector, branch.token.address),
        );
        if (raw != null && raw > 0n) {
          priceObservations.set(branch.name, {
            sourceKind: "pinned-oracle",
            sourceLookup: `${input.chain}:${oracle.contract}:${oracle.selector}:${branch.token.address}`,
            quoteTimestamp: plan.observedBlock.timestamp,
            quoteConfidence: null,
          });
        }
        return raw != null && raw > 0n
          ? [branch.name, decimalNumberFromBigInt(raw, oracle.decimals)] as const
          : null;
      }))).filter((entry): entry is readonly [string, number] => entry != null))
    : await fetchBranchPriceMap(balances, signal, priceMapWarnings, ctx, priceObservations);

  const baseMetadata = {
    observedBlock: plan.observedBlock,
    ...(redemptionFeeBps != null
      ? buildRedemptionSnapshotMetadata({
          feeBps: redemptionFeeBps,
          freshnessKind: "same-run-onchain",
        })
      : {}),
    ...(redemptionCapacity.metadata ?? {}),
  };
  const commonWarnings = [...priceMapWarnings, ...redemptionCapacity.warnings];

  const totalDebtUsd = debtRaw != null ? decimalNumberFromBigInt(debtRaw, debtDecimals) : undefined;
  const result = adaptBranchBalanceReserves({
    adapterKey: ADAPTER_KEY,
    balances,
    priceMap,
    priceObservations,
    censusComplete,
    liabilityUsd: totalDebtUsd,
    details: observationDetails,
    metadata: { ...baseMetadata, ...(totalDebtUsd != null ? { totalDebtUsd } : {}) },
  });
  applyBabelFishAccounting({ coinId: _coin.id, debtSelector, debtRaw, debtDecimals, balances, censusComplete, result, totalDebtUsd });
  // Unknown or circular claims cannot become a full collateralization numerator.
  if (totalDebtUsd != null && totalDebtUsd > 0 && censusComplete && result.metadata?.valuationComplete === true) {
    const details = result.metadata.details as { knownReserveValueUsd: number; selfReferentialValueUsd?: number };
    const selfReferentialValueUsd = details.selfReferentialValueUsd ?? 0;
    const measuredBookUsd = details.knownReserveValueUsd + selfReferentialValueUsd;
    // Material circular claims make an external-only ratio a misleading
    // solvency statistic; withhold it (self-referential-reserve already degrades).
    if (measuredBookUsd > 0 && (selfReferentialValueUsd / measuredBookUsd) * 100 > MATERIAL_UNKNOWN_EXPOSURE_PCT) {
      result.metadata.ratioWithheldReason = "self-referential-claims";
    } else {
      const ratio = details.knownReserveValueUsd / totalDebtUsd;
      result.metadata.collateralizationRatio = ratio;
      commonWarnings.push(...buildCoverageShortfallWarnings({
        code: "undercollateralized",
        message: (pct) => `${ADAPTER_KEY} collateralization ratio ${pct}% below the coverage threshold (collateral ${details.knownReserveValueUsd.toFixed(2)} USD vs debt ${totalDebtUsd.toFixed(2)} USD)`,
        coverageRatio: ratio,
      }));
    }
  }
  // Only independently complete custody composition can separate these
  // operational conditions from reserve admission. Other defects stay degraded.
  if (
    censusComplete && result.metadata?.valuationComplete === true
    && !hasDegradingWarnings(result.warnings) && !hasFatalWarnings(result.warnings)
    && commonWarnings.every((warning) => warning.effect === "info"
      || warning.code === "redemption-capacity-non-stable-assets-skipped"
      || warning.code === "honey-redemption-paused")
  ) {
    for (let index = 0; index < commonWarnings.length; index++) {
      const warning = commonWarnings[index];
      if (warning.code === "redemption-capacity-non-stable-assets-skipped" || warning.code === "honey-redemption-paused") {
        commonWarnings[index] = reserveInfoWarning(warning.code, warning.message);
      }
    }
  }
  return commonWarnings.length > 0
    ? { ...result, warnings: [...(result.warnings ?? []), ...commonWarnings] }
    : result;
}
