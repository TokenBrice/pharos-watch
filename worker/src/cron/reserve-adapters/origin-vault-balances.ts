import { z } from "zod";
import { ReserveBoundedFactSchema, OriginCollateralLiquidityObservationSchema } from "@shared/types/reserve-bounded-facts";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { fetchJsonWithRetry } from "./request";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import { DECIMALS_SELECTOR, encodeAddress, encodeBalanceOfCallData, TOTAL_VALUE_SELECTOR } from "../../lib/evm-selectors";
import { buildCoverageShortfallWarnings, decimalNumberFromBigInt, slicesFromValues, validateDecimals } from "./slice-math";
import { buildRedemptionSnapshotMetadata } from "./redemption";
import { makeOnchainCallers } from "./onchain";
import { notApplicableFreshnessMetadata } from "./freshness";
import { requireOnchainInput } from "./input-guards";
import { pinnedBlockPlan } from "./evm-observation-plan";

const CHECK_BALANCE_SELECTOR = "0x5f515226";

interface OriginVaultAssetConfig {
  address: string;
  decimals: number;
  name: ReserveSlice["name"];
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

interface OriginVaultBalancesParams {
  vaultAddress: string;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  assets: OriginVaultAssetConfig[];
}

interface OriginVaultAssetState {
  sourceKey?: string;
  value: number;
  idleValue: number;
  idleRaw: string;
  name: ReserveSlice["name"];
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

function readParams(config: LiveReservesConfig): OriginVaultBalancesParams {
  return parseLiveReserveAdapterParams("origin-vault-balances", config.params);
}

export async function fetchOriginVaultBalancesReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "origin-vault-balances");
  const params = readParams(config);
  const coinDeployment = coin.contracts?.find((entry) => entry.chain === input.chain);
  if (!coinDeployment) {
    throw new Error(`origin-vault-balances has no reviewed ${input.chain} deployment for ${coin.id}`);
  }
  const timeoutMs = 12_000;
  const plan = await pinnedBlockPlan({ chain: input.chain, signal, ctx, rpcUrl: params.rpcUrl, fallbackRpcUrl: params.fallbackRpcUrl, timeoutMs });
  ctx = plan.ctx;
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs,
  });
  const values: OriginVaultAssetState[] = await Promise.all(params.assets.map(async (asset) => {
    const [raw, idleRaw] = await Promise.all([
      onchain.uint256(params.vaultAddress, `${CHECK_BALANCE_SELECTOR}${encodeAddress(asset.address)}`),
      onchain.uint256(asset.address, encodeBalanceOfCallData(params.vaultAddress)),
    ]);
    if (raw == null) {
      throw new Error(`origin-vault-balances checkBalance failed for ${asset.name}`);
    }
    if (idleRaw == null) {
      throw new Error(`origin-vault-balances idle balance probe failed for ${asset.name}`);
    }
    return {
      sourceKey: `origin-vault-balances:${asset.address.toLowerCase()}`,
      value: decimalNumberFromBigInt(raw, asset.decimals),
      idleValue: decimalNumberFromBigInt(idleRaw, asset.decimals),
      idleRaw: idleRaw.toString(),
      name: asset.name,
      risk: asset.risk,
      ...(asset.coinId ? { coinId: asset.coinId } : {}),
      ...(asset.depType ? { depType: asset.depType } : {}),
    };
  }));

  // `totalValue()` is denominated in the coin's own unit, and the vault contract exposes no
  // ERC-20 `decimals()` of its own (verified live against the reviewed OUSD vault), so the
  // published scale comes from reading the tracked deployment's `decimals()` at the pinned
  // block and requiring it to match the reviewed deployment instead of assuming a scale.
  const [totalValueRaw, totalValueDecimalsRaw] = await Promise.all([
    onchain.uint256(params.vaultAddress, TOTAL_VALUE_SELECTOR),
    onchain.uint256(coinDeployment.address, DECIMALS_SELECTOR),
  ]);
  if (totalValueRaw == null || totalValueRaw <= 0n) {
    throw new Error("origin-vault-balances totalValue probe failed");
  }
  if (totalValueDecimalsRaw == null) {
    throw new Error(`origin-vault-balances decimals() probe failed for ${coin.id}`);
  }
  const totalValueDecimals = validateDecimals(totalValueDecimalsRaw, `origin-vault-balances ${coin.id} decimals()`);
  if (totalValueDecimals !== coinDeployment.decimals) {
    throw new Error(
      `origin-vault-balances ${coin.id} totalValue scale drifted (decimals() ${totalValueDecimals}, reviewed ${coinDeployment.decimals})`,
    );
  }

  const totalReserveUsd = values.reduce((sum, value) => sum + value.value, 0);
  if (totalReserveUsd <= 0) {
    throw new Error("origin-vault-balances produced zero reserve value");
  }
  const totalValueUsd = decimalNumberFromBigInt(totalValueRaw, totalValueDecimals);
  const immediateRedeemableUsd = values.reduce((sum, value) => sum + value.idleValue, 0);
  const assetCoverageRatio = totalReserveUsd / totalValueUsd;
  const unknownValue = Math.max(0, totalValueUsd - totalReserveUsd);
  const warnings = buildCoverageShortfallWarnings({
    code: "origin-vault-coverage-gap",
    message: (pct) => `Origin vault asset probes cover ${pct}% of totalValue()`,
    coverageRatio: assetCoverageRatio,
  });

  const slices = slicesFromValues([
    ...values,
    { sourceKey: "origin-vault-balances:unknown", name: "Unmapped Origin vault exposure", value: unknownValue, risk: "high" },
  ]);
  for (const slice of slices) {
    const value = values.find((entry) => entry.sourceKey === slice.sourceKey);
    if (!value || value.coinId !== "usdc-circle" || value.value <= 0) continue;
    if (value.idleValue > value.value) {
      warnings.push({ code: "origin-idle-fraction-invalid", message: "Idle native balance exceeds the same-pin held balance; bounded fact rejected", severity: "info", effect: "info" });
      continue;
    }
    const pin = plan.observedBlock;
    slice.boundedFacts = [ReserveBoundedFactSchema.parse({
      factKey: `idle-native:${slice.sourceKey}`,
      kind: "currently-liquid-fraction",
      scope: { kind: "exposure", exposureKey: slice.sourceKey },
      asOfSec: pin.timestamp,
      publisher: "Origin vault onchain balances",
      sourceUrls: [`https://etherscan.io/address/${params.vaultAddress}`],
      assertion: "Same-block idle USDC balance divided by total vault USDC checkBalance; not stressed cash realization",
      contentDigest: domainDigest("origin-vault-idle-fraction.v1", { pin, sourceKey: slice.sourceKey, idleRaw: value.idleRaw, totalHeld: value.value }),
      provenance: { kind: "producer-observation", observer: "origin-vault-balances", sourceId: "origin-vault-check-balance", sourceGenerationId: `${pin.chain}:${pin.number}`, observedAtSec: pin.timestamp, maxAgeSec: V9_CANDIDATE_POLICY_V1.policy.semantic.backing.reserve.boundedFacts.currentLiquidFractionMaxAgeSec, confidence: "high" },
      assetId: value.coinId, unit: "USDC", chain: pin.chain,
      currentlyWithdrawable: value.idleValue, totalHeld: value.value, snapshotAtSec: pin.timestamp,
      availabilityMeaning: "currently-withdrawable-native-asset",
    })];
  }
  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      observedBlock: plan.observedBlock,
      boundedFactsGeneration: {
        sourceGenerationId: `${plan.observedBlock.chain}:${plan.observedBlock.number}`,
        observedAtSec: plan.observedBlock.timestamp,
        maxAgeSec: V9_CANDIDATE_POLICY_V1.policy.semantic.backing.reserve.boundedFacts.currentLiquidFractionMaxAgeSec,
      },
      ...notApplicableFreshnessMetadata(),
      details: {
        proofKind: "origin-vault-check-balance",
        vaultAddress: params.vaultAddress,
        totalValueDecimals,
      },
      totalReserveUsd,
      totalValueUsd,
      assetCoverageRatio,
      unknownExposurePct: unknownValue / Math.max(totalReserveUsd, totalValueUsd) * 100,
      totalValueRaw: totalValueRaw.toString(),
      idleVaultBalances: values.map((value) => ({
        name: value.name,
        value: value.idleValue,
        raw: value.idleRaw,
        ...(value.coinId ? { coinId: value.coinId } : {}),
      })),
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: immediateRedeemableUsd,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        ...(config.display?.url ? { sourceUrls: [config.display.url] } : {}),
      }),
    },
  };
}

/** Cross-chain API figures remain diagnostic until their denominator is reconciled to the vault pin. */
export async function fetchOriginOusdCollateralLiquidityObservation(signal: AbortSignal, ctx?: AdapterContext) {
  const sourceUrl = "https://api.originprotocol.com/api/v2/1:OUSD/collaterals";
  const timestampUrl = "https://api.originprotocol.com/cache/last-updated?key=collaterals-1%3AOUSD";
  const timestampSchema = z.object({ key: z.literal("collaterals-1:OUSD"), lastUpdated: z.string().datetime() });
  const before = timestampSchema.parse(await fetchJsonWithRetry<unknown>(timestampUrl, signal, 12000, ctx));
  const payload = await fetchJsonWithRetry<unknown>(sourceUrl, signal, 12000, ctx);
  // A second uncached timestamp prevents joining amounts across a cache refresh.
  const after = timestampSchema.parse(await fetchJsonWithRetry<unknown>(timestampUrl, signal, 12000, ctx ? { ...ctx, requestCache: new Map() } : undefined));
  if (before.lastUpdated !== after.lastUpdated) throw new Error("Origin collateral snapshot changed during read");
  const entries = z.array(z.object({ id: z.string().min(1), amount: z.number().finite().nonnegative(), liquidAmount: z.number().finite().nonnegative() }).passthrough()).min(1).parse(payload);
  const asOfSec = Math.floor(Date.parse(before.lastUpdated) / 1000);
  if (asOfSec > Math.floor(Date.now() / 1000)) throw new Error("Origin collateral timestamp is future");
  return OriginCollateralLiquidityObservationSchema.parse({
    asOfSec, sourceUrls: [sourceUrl, timestampUrl],
    contentDigest: domainDigest("origin-ousd-api-liquidity.v1", { payload, timestamp: before }),
    admission: "diagnostic-unreconciled",
    positions: entries.map((entry) => ({ positionId: entry.id, totalHeld: entry.amount, currentlyWithdrawable: entry.liquidAmount })),
  });
}
