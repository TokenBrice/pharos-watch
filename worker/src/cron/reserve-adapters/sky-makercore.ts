import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { encodeBalanceOfCallData } from "../../lib/evm-selectors";
import { parseFiniteNumber } from "./strict-amount";
import { rethrowIfAborted } from "../../lib/abort";
import { getPublicRpcUrl, getSecondaryFallbackRpcUrl } from "../../lib/public-rpc-registry";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchJsonAdapterInput,
  makeOnchainCallers,
  reserveDegradedWarning,
  reserveInfoWarning,
  SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC,
  slicesFromValues,
  summarizeSourceTimestampsRequiringCoverage,
  verifiedFreshnessMetadata,
  unverifiedFreshnessMetadata,
} from "./helpers";

// ---------------------------------------------------------------------------
// Block Analitica groups API response
// ---------------------------------------------------------------------------

export interface SkyGroupResult {
  group: string;
  group_name: string;
  debt: string;
  collateral: string;
  datetime: string;
}

interface BlockAnaliticaGroupsResponse {
  count: number;
  results: SkyGroupResult[];
}

// ---------------------------------------------------------------------------
// Module → slice mapping
// ---------------------------------------------------------------------------

interface ModuleSpec {
  name: string;
  risk: "very-low" | "low" | "medium" | "high" | "very-high";
  coinId?: string;
}

const SKY_MODULE_SOURCE_KEY_PREFIX = "sky-makercore:module";
const SKY_OTHER_MODULE_SOURCE_KEY = `${SKY_MODULE_SOURCE_KEY_PREFIX}:other-modules`;
const SKY_LITE_PSM_USDC_SOURCE_KEY = "sky-makercore:lite-psm:usdc";
const SKY_PSM_RESIDUAL_SOURCE_KEY = "sky-makercore:module:stablecoins-residual";
const SKY_UNKNOWN_MODULE_OBLIGOR = "Sky unknown module";
// Absolute percentage points: cross-endpoint timing and group-feed rounding band.
const SKY_PSM_RECONCILIATION_TOLERANCE_PCT = 0.25;

function skyModuleSourceKey(group: string): string {
  return `${SKY_MODULE_SOURCE_KEY_PREFIX}:${group}`;
}
// [audit S-099] These stay module-level constants rather than adapter params on purpose:
// they are the canonical Sky LitePSM mainnet contracts, and fetchSkyLitePsmUsdcCapacity
// verifies them on-chain each run via gem()/pocket() (returns null capacity on any mismatch),
// so a stale/wrong address fails safe — config-plumbing them would add a schema + threading
// for zero real flexibility and nonzero risk on this pricing-adjacent path. (RPC URLs were
// the config-worthy half and were moved to the public RPC registry.)
const SKY_LITE_PSM_ADDRESS = "0xf6e72db5454dd049d0788e411b06cfaf16853042";
const SKY_LITE_PSM_USDC_POCKET = "0x37305b1cd40574e4c5ce33f8e8306be057fd7341";
const SKY_LITE_PSM_USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SKY_LITE_PSM_RPC_URL = getPublicRpcUrl("ethereum");
const SKY_LITE_PSM_FALLBACK_RPC_URL = getSecondaryFallbackRpcUrl("ethereum");
const SKY_LITE_PSM_USDC_DECIMALS = 6;
const SKY_LITE_PSM_DOC_URL = "https://developers.sky.money/quick-start/guides/lite-psm/";
const SKY_LITE_PSM_SOURCE_URL = "https://github.com/makerdao/dss-lite-psm";
const GEM_SELECTOR = "0x7bd2bea7"; // gem()
const POCKET_SELECTOR = "0xcccef9e2"; // pocket()
const TIN_SELECTOR = "0x568d4b6f"; // tin()
const TOUT_SELECTOR = "0xfae036d5"; // tout()
const HALTED_SWAP_FEE = (1n << 256n) - 1n;

const MODULE_MAP: Record<string, ModuleSpec> = {
  stablecoins: { name: "Stablecoins (PSM)", risk: "very-low" },
  spark: { name: "Spark (lending)", risk: "low" },
  grove: { name: "Grove (RWA)", risk: "low" },
  obex: { name: "Obex", risk: "medium" },
  // Governance-funded Sky Stars/allocators (like Obex): Osero deploys USDS
  // through its allocator vault, and Keel is the Solana-native allocator. Their
  // ultimate holdings are allocator-strategy exposure rather than a single
  // tracked stablecoin, so they map to a medium allocator risk with no coinId.
  osero: { name: "Osero", risk: "medium" },
  keel: { name: "Keel", risk: "medium" },
  core: { name: "Core (crypto vaults)", risk: "medium" },
  staked: { name: "Staking Engine", risk: "high" },
  "legacy-rwa": { name: "Legacy RWA", risk: "low" },
};

const KNOWN_GROUPS = new Set(Object.keys(MODULE_MAP));

interface ParsedSkyGroup extends SkyGroupResult {
  debtValue: number;
}

function parseSkyGroupDebts(groups: SkyGroupResult[]): ParsedSkyGroup[] {
  return groups.map((group) => ({
    ...group,
    debtValue: parseFiniteNumber(group.debt, {
      label: `sky-makercore: ${group.group}.debt`,
      min: 0,
    }),
  }));
}

function parseSkyCollateral(group: SkyGroupResult): number {
  const value = typeof group.collateral === "string" && group.collateral.trim()
    ? Number(group.collateral)
    : NaN;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`sky-makercore: missing or invalid ${group.group}.collateral`);
  }
  return value;
}


// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------
function reconcileSkyPsm(groups: ParsedSkyGroup[], measuredUsdcUsd: number | null) {
  const totalDebt = groups.reduce((sum, group) => sum + group.debtValue, 0);
  const groupDebt = groups.filter((group) => group.group === "stablecoins")
    .reduce((sum, group) => sum + group.debtValue, 0);
  const excessUsd = measuredUsdcUsd == null ? 0 : Math.max(0, measuredUsdcUsd - groupDebt);
  const excessShare = totalDebt > 0 ? excessUsd / totalDebt : 0;
  const blocked = excessShare * 100 > SKY_PSM_RECONCILIATION_TOLERANCE_PCT;
  return {
    totalDebt,
    excessUsd,
    excessShare,
    blocked,
    attributedUsd: measuredUsdcUsd == null || blocked ? null : Math.min(measuredUsdcUsd, groupDebt),
  };
}


export function adaptSkyModules(
  groups: SkyGroupResult[],
  measuredUsdcUsd: number | null = null,
): AdapterResult["slices"] {
  return adaptParsedSkyModules(parseSkyGroupDebts(groups), measuredUsdcUsd);
}

function adaptParsedSkyModules(
  groups: ParsedSkyGroup[],
  measuredUsdcUsd: number | null,
): AdapterResult["slices"] {
  const knownValues: Array<{
    value: number;
    sourceKey: string;
    name: string;
    risk: "very-low" | "low" | "medium" | "high" | "very-high";
    coinId?: string;
    depType?: "collateral";
    assetClass?: "other" | "stablecoin";
    issuerOrObligor?: string;
  }> = [];

  let unknownDebtTotal = 0;
  const reconciliation = reconcileSkyPsm(groups, measuredUsdcUsd);
  const attributedUsd = reconciliation.attributedUsd;

  for (const g of groups) {
    const debt = g.debtValue;
    if (debt <= 0) continue;

    const spec = MODULE_MAP[g.group];
    if (g.group === "stablecoins" && attributedUsd != null) {
      if (attributedUsd > 0) {
        knownValues.push({
          value: attributedUsd,
          sourceKey: SKY_LITE_PSM_USDC_SOURCE_KEY,
          name: "USDC (Sky LitePSM)",
          risk: "low",
          coinId: "usdc-circle",
          depType: "collateral",
          assetClass: "stablecoin",
          issuerOrObligor: "Circle",
        });
      }
      const residualUsd = Math.max(0, debt - attributedUsd);
      if (residualUsd > 0) {
        knownValues.push({
          value: residualUsd,
          sourceKey: SKY_PSM_RESIDUAL_SOURCE_KEY,
          name: "Unattributed stablecoins (PSM)",
          risk: "very-low",
          assetClass: "stablecoin",
          issuerOrObligor: "Sky PSM contracts and external stablecoin issuers",
        });
      }
      continue;
    }
    if (spec) {
      knownValues.push(g.group === "stablecoins"
        ? {
            value: debt,
            sourceKey: SKY_PSM_RESIDUAL_SOURCE_KEY,
            name: "Unattributed stablecoins (PSM)",
            risk: "very-low",
            assetClass: "stablecoin",
            issuerOrObligor: "Sky PSM contracts and external stablecoin issuers",
          }
        : { value: debt, sourceKey: skyModuleSourceKey(g.group), ...spec });
    } else {
      unknownDebtTotal += debt;
    }
  }

  if (unknownDebtTotal > 0) {
    knownValues.push({
      value: unknownDebtTotal,
      sourceKey: SKY_OTHER_MODULE_SOURCE_KEY,
      name: "Other modules",
      risk: "high",
      assetClass: "other",
      issuerOrObligor: SKY_UNKNOWN_MODULE_OBLIGOR,
    });
  }

  if (attributedUsd == null) return slicesFromValues(knownValues);
  // Preserve the group-debt denominator and exact residual instead of rounding
  // a small remainder into the largest constituent.
  return knownValues
    .map(({ value, ...slice }) => ({ ...slice, pct: (value / reconciliation.totalDebt) * 100 }))
    .sort((a, b) => b.pct - a.pct);
}

export function resolveSkyImmediateRedeemableUsd(groups: SkyGroupResult[]): number {
  const stableGroup = groups.find((g) => g.group === "stablecoins");
  if (!stableGroup) return 0;
  return parseSkyCollateral(stableGroup);
}

export function listUnknownGroups(groups: SkyGroupResult[]): string[] {
  return groups.filter((g) => !KNOWN_GROUPS.has(g.group)).map((g) => g.group);
}

export function resolveSkyTimestampSummary(groups: SkyGroupResult[]) {
  return resolveParsedSkyTimestampSummary(parseSkyGroupDebts(groups));
}

function resolveParsedSkyTimestampSummary(groups: ParsedSkyGroup[]) {
  // Reviewed Block Analitica `datetime` samples omit a zone (including microseconds).
  // Preserve their prior Worker-UTC interpretation explicitly; this is an assumed
  // UTC source policy, not a claim that the publisher supplies timezone evidence.
  return summarizeSourceTimestampsRequiringCoverage(
    groups.filter((group) => group.debtValue > 0).map((group) => group.datetime),
    "assumed-utc",
  );
}

function decodeAddressResult(raw: string | null): string | null {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  const address = `0x${raw.slice(-40)}`.toLowerCase();
  return /^0x0{40}$/.test(address) ? null : address;
}

async function fetchSkyLitePsmUsdcCapacity(
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<{
  capacityUsd: number;
  capacityRaw: string;
  routeObserved: boolean;
  routeStatus: "open" | "paused" | "unknown";
} | null> {
  try {
    const onchain = makeOnchainCallers(
      {
        chain: "ethereum",
        rpcMode: "public-rpc" as const,
      },
      {
        signal,
        ctx,
        rpcUrl: SKY_LITE_PSM_RPC_URL,
        fallbackRpcUrl: SKY_LITE_PSM_FALLBACK_RPC_URL,
        timeoutMs: 12_000,
      },
    );

    const [gemRaw, pocketRaw, tin, tout] = await Promise.all([
      onchain.raw(SKY_LITE_PSM_ADDRESS, GEM_SELECTOR),
      onchain.raw(SKY_LITE_PSM_ADDRESS, POCKET_SELECTOR),
      onchain.uint256(SKY_LITE_PSM_ADDRESS, TIN_SELECTOR),
      onchain.uint256(SKY_LITE_PSM_ADDRESS, TOUT_SELECTOR),
    ]);
    const gem = decodeAddressResult(gemRaw);
    const pocket = decodeAddressResult(pocketRaw);
    if (gem !== SKY_LITE_PSM_USDC_ADDRESS || pocket !== SKY_LITE_PSM_USDC_POCKET) {
      return null;
    }

    const balanceRaw = await onchain.uint256(
      SKY_LITE_PSM_USDC_ADDRESS,
      encodeBalanceOfCallData(SKY_LITE_PSM_USDC_POCKET),
    );
    if (balanceRaw == null) return null;
    const routeObserved = tin != null && tout != null;
    return {
      capacityUsd: decimalNumberFromBigInt(balanceRaw, SKY_LITE_PSM_USDC_DECIMALS),
      capacityRaw: balanceRaw.toString(),
      routeObserved,
      routeStatus: !routeObserved
        ? "unknown"
        : tin === HALTED_SWAP_FEE || tout === HALTED_SWAP_FEE
          ? "paused"
          : "open",
    };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Adapter entry point
// ---------------------------------------------------------------------------

export async function fetchSkyMakercoreReserves(
  _coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const payload = await fetchJsonAdapterInput<BlockAnaliticaGroupsResponse>(config, "sky-makercore", signal, 15_000, ctx);

  if (!Array.isArray(payload.results) || payload.results.length === 0) {
    throw new Error("sky-makercore: groups results array is empty or missing");
  }
  // An incomplete debt census cannot support any normalized shared-book mix.
  // Fail the attempt before on-chain attribution and retain the last good book.
  const groups = parseSkyGroupDebts(payload.results);

  const litePsmCapacity = await fetchSkyLitePsmUsdcCapacity(signal, ctx);
  const psmReconciliation = reconcileSkyPsm(groups, litePsmCapacity?.capacityUsd ?? null);
  const slices = adaptParsedSkyModules(groups, litePsmCapacity?.capacityUsd ?? null);
  if (slices.length === 0) {
    throw new Error("sky-makercore: all module debt values are zero or invalid");
  }

  const totalCollateralUsd = groups.reduce((sum, g) => sum + parseSkyCollateral(g), 0);
  const immediateRedeemableUsd = resolveSkyImmediateRedeemableUsd(groups);

  const timestampSummary = resolveParsedSkyTimestampSummary(groups);
  const sourceTimestamp = timestampSummary.sourceTimestamp;
  const hasCompleteTimestamps = sourceTimestamp != null && timestampSummary.untimestampedCount === 0;

  const totalDebt = psmReconciliation.totalDebt;
  const unknownDebt = groups
    .filter((g) => !KNOWN_GROUPS.has(g.group))
    .reduce((sum, g) => sum + g.debtValue, 0);
  const unknownExposurePct = totalDebt > 0 ? (unknownDebt / totalDebt) * 100 : 0;
  const unknownGroups = groups.filter((group) => !KNOWN_GROUPS.has(group.group));
  const unknown = listUnknownGroups(unknownGroups.filter((group) => group.debtValue > 0));
  const warnings: LiveReserveWarning[] = unknown.map((group) =>
    reserveInfoWarning("unknown-asset", `Sky module bucketed into other: ${group}`),
  );
  if (!litePsmCapacity) {
    warnings.push(reserveInfoWarning(
      "litepsm-attribution-unavailable",
      "Sky LitePSM canonical identity or pocket balance could not be verified; the PSM group remains unlinked",
    ));
  } else if (psmReconciliation.blocked) {
    warnings.push(reserveInfoWarning(
      "litepsm-reconciliation-excess",
      "Sky LitePSM measured USDC exceeds group debt beyond the 0.25 percentage-point timing/rounding band; the PSM group remains unlinked",
    ));
  }
  if (!hasCompleteTimestamps) {
    warnings.push(reserveDegradedWarning(
      "source-timestamp-coverage-incomplete",
      "Sky positive-debt modules do not all expose parseable source timestamps",
    ));
  }
  if (timestampSummary.sourceTimestampSpreadSec != null && timestampSummary.sourceTimestampSpreadSec > SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC) {
    warnings.push(
      reserveDegradedWarning(
        "source-timestamp-spread",
        `Sky module source timestamps span ${timestampSummary.sourceTimestampSpreadSec}s`,
      ),
    );
  }

  const redemptionMetadata = litePsmCapacity
    ? buildRedemptionSnapshotMetadata({
        capacityUsd: litePsmCapacity.capacityUsd,
        capacityKind: "live-direct" as const,
        freshnessKind: "same-run-onchain" as const,
        routeStatus: litePsmCapacity.routeStatus,
        ...(litePsmCapacity.routeObserved
          ? { routeStatusSource: "onchain" as const, routeObserved: true as const }
          : { routeStatusSource: "static-config" as const }),
        routeStatusReason: !litePsmCapacity.routeObserved
          ? "Sky LitePSM route fee probes were unavailable"
          : litePsmCapacity.routeStatus === "paused"
            ? "Sky LitePSM tin() or tout() reported the halted sentinel"
            : "Sky LitePSM tin() and tout() were readable and enabled on-chain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        sourceUrls: [SKY_LITE_PSM_DOC_URL, SKY_LITE_PSM_SOURCE_URL],
        litePsmAddress: SKY_LITE_PSM_ADDRESS,
        litePsmPocket: SKY_LITE_PSM_USDC_POCKET,
        litePsmGem: SKY_LITE_PSM_USDC_ADDRESS,
        litePsmUsdcBalanceRaw: litePsmCapacity.capacityRaw,
      })
    : {};

  return {
    slices,
    metadata: {
      tokenCount: groups.length,
      totalCollateralUsd: Math.round(totalCollateralUsd),
      totalReserveUsd: Math.round(totalCollateralUsd),
      totalLiabilitiesUsd: Math.round(totalDebt),
      balanceSheetScope: "shared-sky-maker",
      sharedBookAssetIds: ["dai-makerdao", "usds-sky"],
      ...(litePsmCapacity
        ? {
            sharedBookMeasuredHoldings: { "usdc-circle": litePsmCapacity.capacityUsd },
            reconciliationExcessUsd: psmReconciliation.excessUsd,
            reconciliationExcessShare: psmReconciliation.excessShare,
            ...(psmReconciliation.blocked ? { reconciliationIssue: "litepsm-reconciliation-excess" } : {}),
          }
        : {}),
      ...(totalDebt > 0 ? { collateralizationRatio: totalCollateralUsd / totalDebt } : {}),
      skyStablecoinsModuleCollateralUsd: immediateRedeemableUsd,
      ...(hasCompleteTimestamps ? { snapshotDate: sourceTimestamp } : {}),
      ...(hasCompleteTimestamps
        ? {
            ...verifiedFreshnessMetadata(sourceTimestamp),
            latestGroupTimestamp: timestampSummary.latestSourceTimestamp,
            sourceTimestampSpreadSec: timestampSummary.sourceTimestampSpreadSec,
            sourceTimestampCount: timestampSummary.timestampCount,
          }
        : unverifiedFreshnessMetadata(
            "module-groups-api",
            "Sky positive-debt modules do not all expose trustworthy snapshot timestamps",
          )),
      unknownExposurePct,
      details: {
        ...(litePsmCapacity ? {} : { litePsmCapacity: "unavailable" }),
      },
      ...redemptionMetadata,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
