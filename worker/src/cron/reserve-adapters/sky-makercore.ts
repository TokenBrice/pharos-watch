import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  requireJsonInputFromConfig,
  reserveDegradedWarning,
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
  depType?: "mechanism";
}

// The Sky PSM group ("stablecoins") aggregates USDC + USDT + USDP without a
// per-stable breakdown in the Block Analitica groups API response. We emit
// the PSM slice without a `coinId` attribution (rather than hardcoding one)
// and surface the composition note in metadata.details.
const SKY_PSM_COMPOSITION_NOTE = "Sky PSM pool aggregates USDC, USDT, USDP without per-stable breakdown from the module-groups API";

const MODULE_MAP: Record<string, ModuleSpec> = {
  stablecoins: { name: "Stablecoins (PSM)", risk: "very-low", depType: "mechanism" },
  spark:       { name: "Spark (lending)", risk: "low" },
  grove:       { name: "Grove (RWA)", risk: "low" },
  obex:        { name: "Obex", risk: "medium" },
  core:        { name: "Core (crypto vaults)", risk: "medium" },
  staked:      { name: "Staking Engine", risk: "high" },
  "legacy-rwa":{ name: "Legacy RWA", risk: "low" },
};

const KNOWN_GROUPS = new Set(Object.keys(MODULE_MAP));

function parseNumericString(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
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
    depType?: "mechanism";
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
    groups
      .filter((group) => parseNumericString(group.debt) > 0)
      .map((group) => group.datetime),
  );
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
  const primaryInput = requireJsonInputFromConfig(config, "sky-makercore");
  const payload = await fetchJsonWithRetry<BlockAnaliticaGroupsResponse>(
    primaryInput.url,
    signal,
    15_000,
    ctx,
  );

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

  const unknown = listUnknownGroups(groups);
  const warnings: LiveReserveWarning[] = unknown.map((group) =>
    reserveDegradedWarning("unknown-asset", `Sky module bucketed into other: ${group}`),
  );
  if (
    timestampSummary
    && timestampSummary.sourceTimestampSpreadSec > SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC
  ) {
    warnings.push(reserveDegradedWarning(
      "source-timestamp-spread",
      `Sky module source timestamps span ${timestampSummary.sourceTimestampSpreadSec}s`,
    ));
  }

  const totalDebt = groups.reduce((sum, g) => sum + parseNumericString(g.debt), 0);
  const unknownDebt = groups.filter((g) => !KNOWN_GROUPS.has(g.group)).reduce((sum, g) => sum + parseNumericString(g.debt), 0);

  return {
    slices,
    metadata: {
      tokenCount: groups.length,
      totalCollateralUsd: Math.round(totalCollateralUsd),
      immediateRedeemableUsd,
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
      unknownExposurePct: totalDebt > 0 ? (unknownDebt / totalDebt) * 100 : 0,
      details: { psmComposition: SKY_PSM_COMPOSITION_NOTE },
      redemption: {
        capacityUsd: immediateRedeemableUsd,
        capacityKind: "live-proxy-validated" as const,
        freshnessKind: timestampSummary != null ? "verified-source-timestamp" as const : "unverified" as const,
        ...(timestampSummary != null ? { sourceTimestamp: timestampSummary.sourceTimestamp } : {}),
        routeStatus: "open" as const,
        holderEligibility: "any-holder",
        sourceUrls: [primaryInput.url],
      },
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
