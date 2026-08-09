import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { encodeBalanceOfCallData } from "../../lib/evm-selectors";
import { parsePositiveNumber } from "../../lib/number-utils";
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
  summarizeSourceTimestamps,
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

// The Sky PSM group ("stablecoins") aggregates USDC + USDT + USDP without a
// per-stable breakdown in the Block Analitica groups API response. We emit
// the PSM slice without a `coinId` attribution (rather than hardcoding one)
// and surface the composition note in metadata.details.
const SKY_PSM_COMPOSITION_NOTE =
  "Sky PSM pool aggregates USDC, USDT, USDP without per-stable breakdown from the module-groups API";
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

const MODULE_MAP: Record<string, ModuleSpec> = {
  stablecoins: { name: "Stablecoins (PSM)", risk: "very-low" },
  spark: { name: "Spark (lending)", risk: "low" },
  grove: { name: "Grove (RWA)", risk: "low" },
  obex: { name: "Obex", risk: "medium" },
  core: { name: "Core (crypto vaults)", risk: "medium" },
  staked: { name: "Staking Engine", risk: "high" },
  "legacy-rwa": { name: "Legacy RWA", risk: "low" },
};

const KNOWN_GROUPS = new Set(Object.keys(MODULE_MAP));

function parseNumericString(raw: string): number {
  return parsePositiveNumber(raw) ?? 0;
}

function hasMalformedDebt(raw: string): boolean {
  if (raw.trim() === "") return true;
  const debt = Number(raw);
  return !Number.isFinite(debt) || debt < 0;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function adaptSkyModules(groups: SkyGroupResult[]): AdapterResult["slices"] {
  const knownValues: Array<{
    value: number;
    name: string;
    risk: "very-low" | "low" | "medium" | "high" | "very-high";
    coinId?: string;
  }> = [];

  let unknownDebtTotal = 0;

  for (const g of groups) {
    const debt = parseNumericString(g.debt);
    if (debt <= 0) continue;

    const spec = MODULE_MAP[g.group];
    if (spec) {
      knownValues.push({ value: debt, ...spec });
    } else {
      unknownDebtTotal += debt;
    }
  }

  if (unknownDebtTotal > 0) {
    knownValues.push({ value: unknownDebtTotal, name: "Other modules", risk: "high" });
  }

  return slicesFromValues(knownValues);
}

export function resolveSkyImmediateRedeemableUsd(groups: SkyGroupResult[]): number {
  const stableGroup = groups.find((g) => g.group === "stablecoins");
  if (!stableGroup) return 0;
  return parseNumericString(stableGroup.collateral);
}

export function listUnknownGroups(groups: SkyGroupResult[]): string[] {
  return groups.filter((g) => !KNOWN_GROUPS.has(g.group)).map((g) => g.group);
}

export function resolveSkyTimestampSummary(groups: SkyGroupResult[]) {
  return summarizeSourceTimestamps(
    groups.filter((group) => parseNumericString(group.debt) > 0).map((group) => group.datetime),
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

    const [gemRaw, pocketRaw] = await Promise.all([
      onchain.raw(SKY_LITE_PSM_ADDRESS, GEM_SELECTOR),
      onchain.raw(SKY_LITE_PSM_ADDRESS, POCKET_SELECTOR),
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
    return {
      capacityUsd: decimalNumberFromBigInt(balanceRaw, SKY_LITE_PSM_USDC_DECIMALS),
      capacityRaw: balanceRaw.toString(),
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
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const payload = await fetchJsonAdapterInput<BlockAnaliticaGroupsResponse>(config, "sky-makercore", signal, 15_000, ctx);

  const groups = payload.results;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error("sky-makercore: groups results array is empty or missing");
  }

  const slices = adaptSkyModules(groups);
  if (slices.length === 0) {
    throw new Error("sky-makercore: all module debt values are zero or invalid");
  }

  const totalCollateralUsd = groups.reduce((sum, g) => sum + parseNumericString(g.collateral), 0);
  const immediateRedeemableUsd = resolveSkyImmediateRedeemableUsd(groups);

  const timestampSummary = resolveSkyTimestampSummary(groups);

  const totalDebt = groups.reduce((sum, g) => sum + parseNumericString(g.debt), 0);
  const unknownDebt = groups
    .filter((g) => !KNOWN_GROUPS.has(g.group))
    .reduce((sum, g) => sum + parseNumericString(g.debt), 0);
  const unknownExposurePct = totalDebt > 0 ? (unknownDebt / totalDebt) * 100 : 0;
  const unknownGroups = groups.filter((group) => !KNOWN_GROUPS.has(group.group));
  const unknown = listUnknownGroups(unknownGroups.filter((group) => parseNumericString(group.debt) > 0));
  const warnings: LiveReserveWarning[] = unknown.map((group) =>
    reserveInfoWarning("unknown-asset", `Sky module bucketed into other: ${group}`),
  );
  for (const group of groups.filter((group) => hasMalformedDebt(group.debt))) {
    const knownGroup = KNOWN_GROUPS.has(group.group);
    warnings.push(
      reserveDegradedWarning(
        knownGroup ? "malformed-debt" : "unknown-asset",
        `Sky module has malformed debt and cannot be classified: ${group.group}`,
      ),
    );
  }
  if (timestampSummary && timestampSummary.sourceTimestampSpreadSec > SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC) {
    warnings.push(
      reserveDegradedWarning(
        "source-timestamp-spread",
        `Sky module source timestamps span ${timestampSummary.sourceTimestampSpreadSec}s`,
      ),
    );
  }

  const litePsmCapacity = await fetchSkyLitePsmUsdcCapacity(signal, ctx);
  const redemptionMetadata = litePsmCapacity
    ? buildRedemptionSnapshotMetadata({
        capacityUsd: litePsmCapacity.capacityUsd,
        capacityKind: "live-direct" as const,
        freshnessKind: "same-run-onchain" as const,
        routeStatus: "open",
        routeStatusSource: "onchain",
        routeStatusReason: "Sky LitePSM USDC pocket balance is readable on-chain",
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
      skyStablecoinsModuleCollateralUsd: immediateRedeemableUsd,
      ...(litePsmCapacity ? { immediateRedeemableUsd: litePsmCapacity.capacityUsd } : {}),
      ...(timestampSummary != null ? { snapshotDate: timestampSummary.sourceTimestamp } : {}),
      ...(timestampSummary
        ? {
            ...verifiedFreshnessMetadata(timestampSummary.sourceTimestamp),
            latestGroupTimestamp: timestampSummary.latestSourceTimestamp,
            sourceTimestampSpreadSec: timestampSummary.sourceTimestampSpreadSec,
            sourceTimestampCount: timestampSummary.timestampCount,
          }
        : unverifiedFreshnessMetadata(
            "module-groups-api",
            "Sky groups payload did not expose a trustworthy snapshot timestamp",
          )),
      unknownExposurePct,
      details: {
        psmComposition: SKY_PSM_COMPOSITION_NOTE,
        ...(litePsmCapacity ? {} : { litePsmCapacity: "unavailable" }),
      },
      ...redemptionMetadata,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
