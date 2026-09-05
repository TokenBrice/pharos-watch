import { decodeAbiParameters } from "viem/utils";
import type { StablecoinMeta } from "@shared/types/core";
import type {
  LiveReserveSnapshotMetadata,
  LiveReservesConfig,
  LiveReserveWarning,
} from "@shared/types/live-reserves";
import {
  DECIMALS_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeBalanceOfCallData,
} from "../../lib/evm-selectors";
import { rethrowIfAborted } from "../../lib/abort";
import { toErrorMessage } from "@shared/lib/error-utils";
import type { AdapterContext, AdapterResult } from "./types";
import { executeEvmObservationPlan, rawObservation } from "./evm-observation-plan";
import { ERC4626_ASSET_SELECTOR, ERC4626_TOTAL_ASSETS_SELECTOR } from "./erc4626";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchErc20Balance,
  fetchOnchainMulticall3,
  fetchOnchainRateBps,
  makeOnchainCallers,
  type OnchainMulticall3Call,
  type OnchainCallers,
  probeOptionalRedemptionRateBps,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
  valueUsdFromBigIntPrice,
} from "./helpers";
import { redactUrlSecrets } from "./warnings";
import {
  adaptBranchBalanceReserves,
  fetchBranchPriceMap,
  readBranchBalanceParams,
  type BranchConfig,
  type BranchBalanceEntry,
  type BranchBalanceParams,
} from "./branch-balances";
import {
  decodeAddressWord,
  decodeBoolWord,
  decodeUint8Word,
} from "./abi-decode";

const ADAPTER_KEY = "liquity-v2-branches";
const DEFAULT_DEBT_SELECTOR = "0x45507998"; // getBoldDebt()
const DEFAULT_SHUTDOWN_SELECTOR = "0x06ff8dfb"; // hasBeenShutDown()
const DEFAULT_DEBT_DECIMALS = 18;
const BRANCH_PRICE_SELECTOR = "0x0fdb11cf"; // fetchPrice()
const BRANCH_REDEMPTION_RATE_SELECTOR = "0xc52861f2"; // getRedemptionRateWithDecay()
const DEFAULT_MECHANISM_PRICE_SELECTOR = "0x4ea15f37"; // getUnbackedPortionPriceAndRedeemability()
const DEFAULT_MAX_SUPPLY_DEBT_DIVERGENCE_PCT = 0.5;
const BRANCH_REDEMPTION_RATE_DECIMALS = 18;

interface LiquityV2BranchDebt {
  entry: BranchBalanceEntry;
  debtRaw: bigint | null;
  shutDown: boolean | null;
  redemptionFeeBps: number | null;
}

interface LiquityV2BranchSnapshot {
  balances: BranchBalanceEntry[];
  debts: LiquityV2BranchDebt[];
  redemptionFeeBps: number | null;
}

interface LiquityV2BranchParams extends BranchBalanceParams {
  debtSelector?: string;
  debtDecimals?: number;
  shutdownSelector?: string;
  mechanismMetrics?: {
    supplyTokenAddress: string;
    branchPriceSelector?: string;
    stabilityPoolDepositsSelector: string;
    maxSupplyDebtDivergencePct?: number;
    branches: Array<{
      name: string;
      troveManagerAddress: string;
      stabilityPoolAddress: string;
    }>;
  };
}

interface LiquityV2MechanismMetricResult {
  metadata: Pick<
    LiveReserveSnapshotMetadata,
    "totalReserveUsd" | "collateralizationRatio" | "liquidationCapacityRatio" | "details"
  >;
  warnings: LiveReserveWarning[];
  branchRedeemability: ReadonlyMap<string, boolean> | null;
}

function readParams(config: LiveReservesConfig): LiquityV2BranchParams {
  return readBranchBalanceParams(config, ADAPTER_KEY) as LiquityV2BranchParams;
}

function sumBranchDebtUsd(
  debts: LiquityV2BranchDebt[],
  debtDecimals: number,
): number {
  return debts.reduce((sum, entry) => (
    entry.debtRaw != null && entry.debtRaw > 0n
      ? sum + decimalNumberFromBigInt(entry.debtRaw, debtDecimals)
      : sum
  ), 0);
}

function computeErc4626AssetsFromShares(
  sharesRaw: bigint,
  totalAssetsRaw: bigint,
  totalSupplyRaw: bigint,
): bigint {
  if (sharesRaw <= 0n || totalAssetsRaw <= 0n || totalSupplyRaw <= 0n) return 0n;
  return (sharesRaw * totalAssetsRaw) / totalSupplyRaw;
}

function rateBpsFromRaw(raw: bigint | null, decimals: number): number | null {
  if (raw == null) return null;
  const scale = 10n ** BigInt(decimals);
  return Number((raw * 10_000n + scale / 2n) / scale);
}

async function fetchLiquityV2Batch(
  input: ReturnType<typeof requireOnchainInput>,
  params: LiquityV2BranchParams,
  calls: readonly OnchainMulticall3Call[],
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<Map<string, `0x${string}` | null> | null> {
  const results = await fetchOnchainMulticall3({
    calls,
    chain: input.chain,
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs: 12_000,
  });
  if (!results) return null;
  return new Map(
    results.map((result) => [result.label, result.success ? result.returnData : null]),
  );
}

async function tryAdaptErc4626ShareEntry(
  onchain: OnchainCallers,
  entry: BranchBalanceEntry,
): Promise<BranchBalanceEntry> {
  if (entry.balanceRaw == null || entry.balanceRaw <= 0n) return entry;

  const assetRaw = await onchain.raw(entry.branch.token.address, ERC4626_ASSET_SELECTOR);
  const assetAddress = decodeAddressWord(assetRaw);
  if (!assetAddress) return entry;

  const [totalAssetsRaw, totalSupplyRaw, decimalsRaw] = await Promise.all([
    onchain.uint256(entry.branch.token.address, ERC4626_TOTAL_ASSETS_SELECTOR),
    onchain.uint256(entry.branch.token.address, TOTAL_SUPPLY_SELECTOR),
    onchain.raw(assetAddress, DECIMALS_SELECTOR),
  ]);
  if (totalAssetsRaw == null || totalSupplyRaw == null || totalSupplyRaw <= 0n) {
    return entry;
  }

  const assetBalanceRaw = computeErc4626AssetsFromShares(entry.balanceRaw, totalAssetsRaw, totalSupplyRaw);
  const assetDecimals = decodeUint8Word(decimalsRaw) ?? entry.branch.token.decimals;
  return {
    ...entry,
    balanceRaw: assetBalanceRaw,
    branch: {
      ...entry.branch,
      token: {
        ...entry.branch.token,
        address: assetAddress,
        decimals: assetDecimals,
      },
    },
  };
}

async function fetchLiquityV2BranchState(
  input: ReturnType<typeof requireOnchainInput>,
  params: LiquityV2BranchParams,
  debtSelector: string,
  shutdownSelector: string,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  onchain: OnchainCallers,
): Promise<LiquityV2BranchSnapshot> {
  const calls: OnchainMulticall3Call[] = [];
  for (const [index, branch] of params.branches.entries()) {
    calls.push(
      {
        label: `branch:balance:${index}`,
        contract: branch.token.address,
        data: encodeBalanceOfCallData(branch.holder),
        allowFailure: true,
      },
      {
        label: `branch:debt:${index}`,
        contract: branch.holder,
        data: debtSelector,
        allowFailure: true,
      },
      {
        label: `branch:shutdown:${index}`,
        contract: branch.holder,
        data: shutdownSelector,
        allowFailure: true,
      },
    );
    if (!params.redemptionRateProbe) {
      calls.push({
        label: `branch:fee:${index}`,
        contract: branch.holder,
        data: BRANCH_REDEMPTION_RATE_SELECTOR,
        allowFailure: true,
      });
    }
  }
  if (params.redemptionRateProbe?.decimals != null) {
    calls.push({
      label: "branch:fee:global",
      contract: params.redemptionRateProbe.contract,
      data: params.redemptionRateProbe.selector,
      allowFailure: true,
    });
  }

  const rawByLabel = await fetchLiquityV2Batch(input, params, calls, signal, ctx);
  if (rawByLabel) {
    const balances = params.branches.map((branch, index) => ({
      branch,
      balanceRaw: decodeRequiredOptionalUint256(rawByLabel.get(`branch:balance:${index}`)),
    }));
    const debts = balances.map((entry, index) => ({
      entry,
      debtRaw: decodeRequiredOptionalUint256(rawByLabel.get(`branch:debt:${index}`)),
      shutDown: decodeBoolWord(rawByLabel.get(`branch:shutdown:${index}`)),
      redemptionFeeBps: params.redemptionRateProbe
        ? null
        : rateBpsFromRaw(
            decodeRequiredOptionalUint256(rawByLabel.get(`branch:fee:${index}`)),
            BRANCH_REDEMPTION_RATE_DECIMALS,
          ),
    }));
    const redemptionFeeBps = params.redemptionRateProbe?.decimals != null
      ? rateBpsFromRaw(
          decodeRequiredOptionalUint256(rawByLabel.get("branch:fee:global")),
          params.redemptionRateProbe.decimals,
        )
      : null;
    return { balances, debts, redemptionFeeBps };
  }

  const [balances, redemptionFeeBps] = await Promise.all([
    Promise.all(params.branches.map(async (branch) => ({
      branch,
      balanceRaw: await fetchErc20Balance(
        input,
        branch.token.address,
        branch.holder,
        signal,
        ctx,
        params.rpcUrl,
        params.fallbackRpcUrl,
      ),
    }))),
    probeOptionalRedemptionRateBps(
      input,
      params.redemptionRateProbe,
      signal,
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    ),
  ]);
  const debts = await Promise.all(balances.map(async (entry) => {
    const [debtRaw, shutDownRaw, branchRedemptionFeeBps] = await Promise.all([
      onchain.uint256(entry.branch.holder, debtSelector),
      onchain.raw(entry.branch.holder, shutdownSelector),
      params.redemptionRateProbe
        ? Promise.resolve(null)
        : probeBranchRedemptionFeeBps(input, entry.branch, signal, ctx, params),
    ]);
    return {
      entry,
      debtRaw,
      shutDown: decodeBoolWord(shutDownRaw),
      redemptionFeeBps: branchRedemptionFeeBps,
    };
  }));
  return { balances, debts, redemptionFeeBps };
}

function decodeRequiredOptionalUint256(raw: `0x${string}` | null | undefined): bigint | null {
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  return BigInt(raw);
}

async function adaptErc4626ShareEntries(
  input: ReturnType<typeof requireOnchainInput>,
  params: LiquityV2BranchParams,
  entries: BranchBalanceEntry[],
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  onchain: OnchainCallers,
): Promise<BranchBalanceEntry[]> {
  const positiveEntries = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.balanceRaw != null && entry.balanceRaw > 0n);
  if (positiveEntries.length === 0) return entries;

  const assetCalls = positiveEntries.map(({ entry, index }) => ({
    label: `branch:asset:${index}`,
    contract: entry.branch.token.address,
    data: ERC4626_ASSET_SELECTOR,
    allowFailure: true,
  }));
  const assetRawByLabel = await fetchLiquityV2Batch(input, params, assetCalls, signal, ctx);
  if (!assetRawByLabel) {
    return Promise.all(entries.map((entry) => tryAdaptErc4626ShareEntry(onchain, entry)));
  }

  const probedEntries = positiveEntries
    .map(({ entry, index }) => ({
      entry,
      index,
      assetAddress: decodeAddressWord(assetRawByLabel.get(`branch:asset:${index}`)),
    }))
    .filter(
      (entry): entry is typeof entry & { assetAddress: `0x${string}` } => entry.assetAddress != null,
    );
  if (probedEntries.length === 0) return entries;

  const metadataCalls = probedEntries.flatMap(({ entry, index, assetAddress }) => [
    {
      label: `branch:total-assets:${index}`,
      contract: entry.branch.token.address,
      data: ERC4626_TOTAL_ASSETS_SELECTOR,
      allowFailure: true,
    },
    {
      label: `branch:total-supply:${index}`,
      contract: entry.branch.token.address,
      data: TOTAL_SUPPLY_SELECTOR,
      allowFailure: true,
    },
    {
      label: `branch:asset-decimals:${index}`,
      contract: assetAddress,
      data: DECIMALS_SELECTOR,
      allowFailure: true,
    },
  ]);
  const metadataRawByLabel = await fetchLiquityV2Batch(input, params, metadataCalls, signal, ctx);
  if (!metadataRawByLabel) {
    const adapted = await Promise.all(probedEntries.map(({ entry }) => tryAdaptErc4626ShareEntry(onchain, entry)));
    const adaptedByIndex = new Map(probedEntries.map(({ index }, offset) => [index, adapted[offset]]));
    return entries.map((entry, index) => adaptedByIndex.get(index) ?? entry);
  }

  const probedByIndex = new Map(probedEntries.map((entry) => [entry.index, entry]));
  return entries.map((entry, index) => {
    const probed = probedByIndex.get(index);
    if (!probed || entry.balanceRaw == null) return entry;
    const totalAssetsRaw = decodeRequiredOptionalUint256(
      metadataRawByLabel.get(`branch:total-assets:${index}`),
    );
    const totalSupplyRaw = decodeRequiredOptionalUint256(
      metadataRawByLabel.get(`branch:total-supply:${index}`),
    );
    if (totalAssetsRaw == null || totalSupplyRaw == null || totalSupplyRaw <= 0n) return entry;
    return {
      ...entry,
      balanceRaw: computeErc4626AssetsFromShares(entry.balanceRaw, totalAssetsRaw, totalSupplyRaw),
      branch: {
        ...entry.branch,
        token: {
          ...entry.branch.token,
          address: probed.assetAddress,
          decimals: decodeUint8Word(
            metadataRawByLabel.get(`branch:asset-decimals:${index}`),
          ) ?? entry.branch.token.decimals,
        },
      },
    };
  });
}

async function fetchBranchProtocolPriceMap(
  input: ReturnType<typeof requireOnchainInput>,
  params: LiquityV2BranchParams,
  onchain: OnchainCallers,
  balances: BranchBalanceEntry[],
  existingPriceMap: Map<string, number>,
  warnings: LiveReserveWarning[],
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<Map<string, number>> {
  const missingPricedBranches = balances.filter(
    ({ branch, balanceRaw }) => balanceRaw != null
      && balanceRaw > 0n
      && branch.priceUsd == null
      && !existingPriceMap.has(branch.name),
  );
  if (missingPricedBranches.length === 0) return new Map();

  const protocolPriceMap = new Map<string, number>();
  const calls = missingPricedBranches.map(({ branch }, index) => ({
    label: `branch:protocol-price:${index}`,
    contract: branch.holder,
    data: BRANCH_PRICE_SELECTOR,
    allowFailure: true,
  }));
  const rawByLabel = await fetchLiquityV2Batch(input, params, calls, signal, ctx);
  await Promise.all(missingPricedBranches.map(async ({ branch }, index) => {
    const priceRaw = rawByLabel
      ? decodeRequiredOptionalUint256(rawByLabel.get(`branch:protocol-price:${index}`))
      : await onchain.uint256(branch.holder, BRANCH_PRICE_SELECTOR);
    if (priceRaw == null || priceRaw <= 0n) return;
    const priceUsd = decimalNumberFromBigInt(priceRaw, 18);
    if (Number.isFinite(priceUsd) && priceUsd > 0) {
      protocolPriceMap.set(branch.name, priceUsd);
    }
  }));

  if (protocolPriceMap.size > 0) {
    warnings.push(reserveInfoWarning(
      "branch-protocol-price-fallback",
      `Used branch oracle price fallback for: ${[...protocolPriceMap.keys()].join(", ")}`,
    ));
  }
  return protocolPriceMap;
}

async function probeBranchRedemptionFeeBps(
  input: ReturnType<typeof requireOnchainInput>,
  branch: BranchConfig,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  params: LiquityV2BranchParams,
): Promise<number | null> {
  return fetchOnchainRateBps(
    input,
    { contract: branch.holder, selector: BRANCH_REDEMPTION_RATE_SELECTOR },
    signal,
    ctx,
    params.rpcUrl,
    params.fallbackRpcUrl,
  );
}

function chooseSnapshotRedemptionFeeBps(
  explicitFeeBps: number | null,
  debts: LiquityV2BranchDebt[],
): number | null {
  if (explicitFeeBps != null) return explicitFeeBps;
  const readableFees = debts
    .map((entry) => entry.redemptionFeeBps)
    .filter((fee): fee is number => fee != null);
  if (readableFees.length === 0) return null;
  return Math.max(...readableFees);
}

function decodeMechanismBranchPrice(
  raw: `0x${string}` | undefined,
  branchName: string,
): { priceRaw: bigint; redeemable: boolean } {
  if (!raw) throw new Error(`missing protocol-price result for ${branchName}`);
  try {
    const [, priceRaw, redeemable] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "bool" }],
      raw,
    ) as readonly [bigint, bigint, boolean];
    if (priceRaw <= 0n) {
      throw new Error(`protocol price is ${priceRaw.toString()} with redeemable=${redeemable}`);
    }
    return { priceRaw, redeemable };
  } catch (error) {
    throw new Error(
      `invalid protocol-price result for ${branchName}: ${toErrorMessage(error)}`,
    );
  }
}

function decodeRequiredUint256(
  raw: `0x${string}` | undefined,
  label: string,
): bigint {
  const value = decodeRequiredOptionalUint256(raw);
  if (value == null) throw new Error(`missing or invalid ${label} result`);
  if (value < 0n) throw new Error(`${label} result is negative`);
  return value;
}

async function fetchLiquityV2MechanismMetrics(
  input: ReturnType<typeof requireOnchainInput>,
  params: LiquityV2BranchParams,
  snapshot: LiquityV2BranchSnapshot,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<LiquityV2MechanismMetricResult | null> {
  const config = params.mechanismMetrics;
  if (!config) return null;
  let branchRedeemability: ReadonlyMap<string, boolean> | null = null;

  const calls: OnchainMulticall3Call[] = [
    {
      label: "mechanism:total-supply",
      contract: config.supplyTokenAddress,
      data: TOTAL_SUPPLY_SELECTOR,
      allowFailure: true,
    },
  ];
  for (const branch of config.branches) {
    calls.push(
      {
        label: `mechanism:price:${branch.name}`,
        contract: branch.troveManagerAddress,
        data: config.branchPriceSelector ?? DEFAULT_MECHANISM_PRICE_SELECTOR,
        allowFailure: true,
      },
      {
        label: `mechanism:stability-pool:${branch.name}`,
        contract: branch.stabilityPoolAddress,
        data: config.stabilityPoolDepositsSelector,
        allowFailure: true,
      },
    );
  }

  try {
    const observation = await executeEvmObservationPlan({
      adapterKey: "liquity-v2-branches:mechanism-metrics",
      fields: calls.map((entry) => rawObservation({
        label: entry.label,
        contract: entry.contract,
        data: entry.data,
        allowFailure: entry.allowFailure,
        optional: true,
      })),
      read: (planCalls) => fetchOnchainMulticall3({
        calls: planCalls,
        chain: input.chain,
        signal,
        ctx,
        rpcUrl: params.rpcUrl,
        fallbackRpcUrl: params.fallbackRpcUrl,
        timeoutMs: 12_000,
      }),
    });
    const byLabel = observation.rawByLabel;

    const branchPrices = new Map<string, { priceRaw: bigint; redeemable: boolean }>();
    for (const binding of config.branches) {
      branchPrices.set(
        binding.name,
        decodeMechanismBranchPrice(
          byLabel.get(`mechanism:price:${binding.name}`),
          binding.name,
        ),
      );
    }
    branchRedeemability = new Map(
      [...branchPrices].map(([name, state]) => [name, state.redeemable]),
    );

    const totalSupplyRaw = decodeRequiredUint256(
      byLabel.get("mechanism:total-supply"),
      "total supply",
    );
    if (totalSupplyRaw <= 0n) throw new Error("total supply is zero");

    const balancesByName = new Map(snapshot.balances.map((entry) => [entry.branch.name, entry]));
    const debtsByName = new Map(snapshot.debts.map((entry) => [entry.entry.branch.name, entry]));
    let totalCollateralUsd = 0;
    let totalDebtRaw = 0n;
    let totalStabilityPoolDepositsRaw = 0n;
    let branchCappedDepositsRaw = 0n;
    const branchDetails: Array<Record<string, unknown>> = [];

    for (const binding of config.branches) {
      const balance = balancesByName.get(binding.name);
      const debt = debtsByName.get(binding.name);
      if (!balance || !debt || debt.debtRaw == null) {
        throw new Error(`missing reserve/debt state for ${binding.name}`);
      }
      const { priceRaw, redeemable } = branchPrices.get(binding.name)!;
      const stabilityPoolDepositsRaw = decodeRequiredUint256(
        byLabel.get(`mechanism:stability-pool:${binding.name}`),
        `Stability Pool deposits for ${binding.name}`,
      );
      const priceUsd = decimalNumberFromBigInt(priceRaw, 18);
      const collateralUsd = valueUsdFromBigIntPrice(
        balance.balanceRaw ?? 0n,
        balance.branch.token.decimals,
        priceUsd,
      );
      if (!Number.isFinite(collateralUsd) || collateralUsd < 0) {
        throw new Error(`invalid protocol-priced collateral value for ${binding.name}`);
      }

      totalCollateralUsd += collateralUsd;
      totalDebtRaw += debt.debtRaw;
      totalStabilityPoolDepositsRaw += stabilityPoolDepositsRaw;
      branchCappedDepositsRaw += stabilityPoolDepositsRaw < debt.debtRaw
        ? stabilityPoolDepositsRaw
        : debt.debtRaw;
      branchDetails.push({
        name: binding.name,
        troveManagerAddress: binding.troveManagerAddress,
        stabilityPoolAddress: binding.stabilityPoolAddress,
        collateralRaw: (balance.balanceRaw ?? 0n).toString(),
        debtRaw: debt.debtRaw.toString(),
        stabilityPoolDepositsRaw: stabilityPoolDepositsRaw.toString(),
        priceRaw: priceRaw.toString(),
        priceUsd,
        redeemable,
      });
    }

    if (totalDebtRaw <= 0n) throw new Error("aggregate branch debt is zero");
    const totalDebtUsd = decimalNumberFromBigInt(totalDebtRaw, params.debtDecimals ?? DEFAULT_DEBT_DECIMALS);
    const totalSupply = decimalNumberFromBigInt(totalSupplyRaw, params.debtDecimals ?? DEFAULT_DEBT_DECIMALS);
    const totalStabilityPoolDeposits = decimalNumberFromBigInt(
      totalStabilityPoolDepositsRaw,
      params.debtDecimals ?? DEFAULT_DEBT_DECIMALS,
    );
    const branchCappedDeposits = decimalNumberFromBigInt(
      branchCappedDepositsRaw,
      params.debtDecimals ?? DEFAULT_DEBT_DECIMALS,
    );
    if (totalDebtUsd <= 0 || totalSupply <= 0) {
      throw new Error("aggregate branch debt or token supply is not positive");
    }

    const supplyDebtDivergencePct = Math.abs(totalDebtUsd - totalSupply) / totalSupply * 100;
    const maxSupplyDebtDivergencePct =
      config.maxSupplyDebtDivergencePct ?? DEFAULT_MAX_SUPPLY_DEBT_DIVERGENCE_PCT;
    if (supplyDebtDivergencePct > maxSupplyDebtDivergencePct) {
      throw new Error(
        `branch debt diverges ${supplyDebtDivergencePct.toFixed(4)}% from token supply ` +
          `(max ${maxSupplyDebtDivergencePct}%)`,
      );
    }

    const collateralizationRatio = totalCollateralUsd / totalDebtUsd;
    const liquidationCapacityRatio = totalStabilityPoolDeposits / totalSupply;
    const branchCappedLiquidationCapacityRatio = branchCappedDeposits / totalDebtUsd;
    const warnings: LiveReserveWarning[] = [];
    if (collateralizationRatio < 1) {
      warnings.push(reserveDegradedWarning(
        "liquity-v2-undercollateralized",
        `Liquity V2 protocol-priced collateralization ratio ${collateralizationRatio.toFixed(4)} is below 1.0`,
      ));
    }

    return {
      metadata: {
        totalReserveUsd: totalCollateralUsd,
        collateralizationRatio,
        liquidationCapacityRatio,
        details: {
          mechanismMetrics: {
            proofKind: "liquity-v2-protocol-priced-system-state",
            totalSupplyRaw: totalSupplyRaw.toString(),
            totalDebtRaw: totalDebtRaw.toString(),
            totalStabilityPoolDepositsRaw: totalStabilityPoolDepositsRaw.toString(),
            supplyDebtDivergencePct,
            branchCappedLiquidationCapacityRatio,
            branches: branchDetails,
          },
        },
      },
      warnings,
      branchRedeemability,
    };
  } catch (error) {
    rethrowIfAborted(error, signal);
    const detail = redactUrlSecrets(toErrorMessage(error));
    return {
      metadata: {},
      warnings: [
        reserveInfoWarning(
          "liquity-v2-mechanism-metrics-unavailable",
          `Live collateralization/backstop metrics omitted: ${detail}`,
        ),
        ...(branchRedeemability == null
          ? [reserveDegradedWarning(
              "liquity-v2-redeemability-unavailable",
              `Live redemption capacity omitted because branch redeemability was unreadable: ${detail}`,
            )]
          : []),
      ],
      branchRedeemability,
    };
  }
}

export function buildLiquityV2RedemptionMetadata(
  snapshot: LiquityV2BranchSnapshot,
  debtDecimals = DEFAULT_DEBT_DECIMALS,
  sourceUrls: string[] = [
    "https://docs.liquity.org/v2-faq/redemptions-and-delegation",
    "https://docs.liquity.org/v2-faq/technical-resources",
  ],
  branchRedeemability?: ReadonlyMap<string, boolean> | null,
): NonNullable<AdapterResult["metadata"]> {
  const totalDebtUsd = sumBranchDebtUsd(snapshot.debts, debtDecimals);
  if (totalDebtUsd <= 0) {
    throw new Error(`${ADAPTER_KEY} active-pool debt reads returned zero capacity`);
  }

  const branchDebt = snapshot.debts.map((entry) => ({
    name: entry.entry.branch.name,
    debtRaw: entry.debtRaw?.toString() ?? null,
    shutDown: entry.shutDown,
    redemptionFeeBps: entry.redemptionFeeBps,
    ...(branchRedeemability !== undefined
      ? { redeemable: branchRedeemability?.get(entry.entry.branch.name) ?? null }
      : {}),
  }));
  const unreadableRedeemabilityBranches = branchRedeemability !== undefined
    ? snapshot.debts
        .filter((entry) => branchRedeemability?.has(entry.entry.branch.name) !== true)
        .map((entry) => entry.entry.branch.name)
    : [];
  if (unreadableRedeemabilityBranches.length > 0) {
    return {
      totalDebtUsd,
      details: {
        proofKind: "liquity-v2-active-pool-debt",
        branchDebt,
        unreadableRedeemabilityBranches,
        redemptionCapacityUnratedReason:
          `Could not verify branch redeemability for: ${unreadableRedeemabilityBranches.join(", ")}`,
      },
    };
  }

  const nonRedeemableBranches = branchRedeemability
    ? snapshot.debts
        .filter((entry) => branchRedeemability.get(entry.entry.branch.name) === false)
        .map((entry) => entry.entry.branch.name)
    : [];
  const capacityUsd = sumBranchDebtUsd(
    branchRedeemability
      ? snapshot.debts.filter((entry) => branchRedeemability.get(entry.entry.branch.name) === true)
      : snapshot.debts,
    debtDecimals,
  );

  const shutdownBranches = snapshot.debts
    .filter((entry) => entry.shutDown === true)
    .map((entry) => entry.entry.branch.name);
  const unreadableShutdownBranches = snapshot.debts
    .filter((entry) => entry.shutDown == null)
    .map((entry) => entry.entry.branch.name);
  const routeStatus = shutdownBranches.length > 0 || nonRedeemableBranches.length > 0
    ? "degraded"
    : unreadableShutdownBranches.length > 0
      ? "unknown"
      : "open";
  const routeStatusReasons = [
    ...(shutdownBranches.length > 0
      ? [`Collateral branch shutdown/sunset detected for: ${shutdownBranches.join(", ")}`]
      : []),
    ...(nonRedeemableBranches.length > 0
      ? [`Protocol redemption disabled for: ${nonRedeemableBranches.join(", ")}`]
      : []),
    ...(unreadableShutdownBranches.length > 0
      ? [`Could not verify branch shutdown status for: ${unreadableShutdownBranches.join(", ")}`]
      : []),
  ];
  const routeStatusReason = routeStatusReasons.length > 0 ? routeStatusReasons.join("; ") : undefined;

  return {
    totalDebtUsd,
    immediateRedeemableUsd: capacityUsd,
    ...buildRedemptionSnapshotMetadata({
      capacityUsd,
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      routeStatus,
      routeStatusSource: "onchain",
      ...(routeStatusReason ? { routeStatusReason } : {}),
      holderEligibility: "any-holder",
      settlementDelaySec: 0,
      sourceUrls,
      feeBps: snapshot.redemptionFeeBps,
    }),
    details: {
      proofKind: "liquity-v2-active-pool-debt",
      branchDebt,
      ...(unreadableShutdownBranches.length > 0 ? { unreadableShutdownBranches } : {}),
      ...(nonRedeemableBranches.length > 0 ? { nonRedeemableBranches } : {}),
    },
  };
}

export function buildLiquityV2Warnings(
  snapshot: LiquityV2BranchSnapshot,
): LiveReserveWarning[] {
  const unreadableShutdownBranches = snapshot.debts
    .filter((entry) => entry.shutDown == null)
    .map((entry) => entry.entry.branch.name);
  if (unreadableShutdownBranches.length === 0) return [];
  return [
    reserveDegradedWarning(
      "redemption-route-status-unreadable",
      `Could not verify branch shutdown status for: ${unreadableShutdownBranches.join(", ")}`,
    ),
  ];
}

export async function fetchLiquityV2BranchReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = readParams(config);
  const debtSelector = params.debtSelector ?? DEFAULT_DEBT_SELECTOR;
  const shutdownSelector = params.shutdownSelector ?? DEFAULT_SHUTDOWN_SELECTOR;
  const debtDecimals = params.debtDecimals ?? DEFAULT_DEBT_DECIMALS;
  const timeoutMs = 12_000;
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs,
  });

  const branchState = await fetchLiquityV2BranchState(
    input,
    params,
    debtSelector,
    shutdownSelector,
    signal,
    ctx,
    onchain,
  );
  const balances = await adaptErc4626ShareEntries(
    input,
    params,
    branchState.balances,
    signal,
    ctx,
    onchain,
  );
  const debts = branchState.debts.map((debt, index) => ({
    ...debt,
    entry: balances[index] ?? debt.entry,
  }));

  const unreadableDebtBranches = debts
    .filter((entry) => entry.debtRaw == null)
    .map((entry) => entry.entry.branch.name);
  if (unreadableDebtBranches.length > 0) {
    throw new Error(`${ADAPTER_KEY} could not read active-pool debt for: ${unreadableDebtBranches.join(", ")}`);
  }

  const snapshot = {
    balances,
    debts,
    redemptionFeeBps: chooseSnapshotRedemptionFeeBps(branchState.redemptionFeeBps, debts),
  };
  const priceMapWarnings: LiveReserveWarning[] = [];
  const [priceMap, mechanismMetrics] = await Promise.all([
    fetchBranchPriceMap(balances, signal, priceMapWarnings, ctx),
    fetchLiquityV2MechanismMetrics(input, params, snapshot, signal, ctx),
  ]);
  const protocolPriceMap = await fetchBranchProtocolPriceMap(
    input,
    params,
    onchain,
    balances,
    priceMap,
    priceMapWarnings,
    signal,
    ctx,
  );
  for (const [name, price] of protocolPriceMap) {
    if (!priceMap.has(name)) {
      priceMap.set(name, price);
    }
  }
  const redemptionMetadata = buildLiquityV2RedemptionMetadata(
    snapshot,
    debtDecimals,
    params.sourceUrls,
    params.mechanismMetrics ? mechanismMetrics?.branchRedeemability ?? null : undefined,
  );
  const result = adaptBranchBalanceReserves({
    adapterKey: ADAPTER_KEY,
    balances,
    priceMap,
    metadata: {
      ...redemptionMetadata,
      ...(mechanismMetrics?.metadata ?? {}),
      details: {
        ...(redemptionMetadata.details ?? {}),
        ...(mechanismMetrics?.metadata.details ?? {}),
      },
    },
  });
  const warnings = [
    ...buildLiquityV2Warnings(snapshot),
    ...priceMapWarnings,
    ...(mechanismMetrics?.warnings ?? []),
  ];
  return warnings.length > 0
    ? { ...result, warnings: [...(result.warnings ?? []), ...warnings] }
    : result;
}
