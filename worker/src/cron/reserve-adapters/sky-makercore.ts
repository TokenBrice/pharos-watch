import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  getAdapterTimeout,
  requireJsonInputFromConfig,
  reserveDegradedWarning,
  slicesFromValues,
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

const MODULE_MAP: Record<string, ModuleSpec> = {
  stablecoins: { name: "Stablecoins (PSM)", risk: "very-low", coinId: "usdc-circle", depType: "mechanism" },
  spark:       { name: "Spark (lending)", risk: "low" },
  grove:       { name: "Grove (RWA)", risk: "low" },
  obex:        { name: "Obex", risk: "medium" },
  core:        { name: "Core (crypto vaults)", risk: "medium" },
  staked:      { name: "Staking Engine", risk: "high" },
  "legacy-rwa":{ name: "Legacy RWA", risk: "low" },
};

const KNOWN_GROUPS = new Set(Object.keys(MODULE_MAP));

function parseDebt(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parseCollateral(raw: string): number {
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
    const debt = parseDebt(g.debt);
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
  return parseCollateral(stableGroup.collateral);
}

export function listUnknownGroups(groups: SkyGroupResult[]): string[] {
  return groups.filter((g) => !KNOWN_GROUPS.has(g.group)).map((g) => g.group);
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
    getAdapterTimeout(config, 15_000),
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

  const totalCollateralUsd = groups.reduce((sum, g) => sum + parseCollateral(g.collateral), 0);
  const immediateRedeemableUsd = resolveSkyImmediateRedeemableUsd(groups);

  // Snapshot timestamp from the first result's datetime field
  const datetimeStr = groups[0].datetime;
  const snapshotEpoch = datetimeStr ? Math.floor(new Date(datetimeStr + "Z").getTime() / 1000) : 0;

  const unknown = listUnknownGroups(groups);
  const warnings: LiveReserveWarning[] = unknown.map((group) =>
    reserveDegradedWarning("unknown-asset", `Sky module bucketed into other: ${group}`),
  );

  const totalDebt = groups.reduce((sum, g) => sum + parseDebt(g.debt), 0);
  const unknownDebt = groups.filter((g) => !KNOWN_GROUPS.has(g.group)).reduce((sum, g) => sum + parseDebt(g.debt), 0);

  return {
    slices,
    metadata: {
      tokenCount: groups.length,
      totalCollateralUsd: Math.round(totalCollateralUsd),
      immediateRedeemableUsd,
      snapshotDate: snapshotEpoch,
      ...(snapshotEpoch > 0
        ? verifiedFreshnessMetadata(snapshotEpoch)
        : unverifiedFreshnessMetadata(
            "module-groups-api",
            "Sky groups payload did not expose a trustworthy snapshot timestamp",
          )),
      unknownExposurePct: totalDebt > 0 ? (unknownDebt / totalDebt) * 100 : 0,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
