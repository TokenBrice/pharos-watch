import { z } from "zod";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  requireJsonInput,
  slicesFromValues,
  verifiedFreshnessMetadata,
} from "./helpers";
import { reserveInfoWarning } from "./warnings";

const ADAPTER_KEY = "avant-reserves-api";
const REQUEST_TIMEOUT_MS = 12_000;

/** Internal-consistency tolerances for the issuer's own cross-referenced totals. */
const CATEGORY_TOTAL_REL_TOLERANCE = 1e-4;
const NAV_REL_TOLERANCE = 1e-4;
const LEVERAGE_REL_TOLERANCE = 1e-6;

const AvantEntrySchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  value: z.number().finite(),
  chains: z.array(z.object({ name: z.string().min(1), value: z.number().finite() })),
  isDebt: z.boolean(),
});

const AvantRowSchema = z.object({
  label: z.string().min(1),
  valueUsd: z.number().finite(),
});

const AvantDetailedCategorySchema = z.object({
  category: z.string().min(1),
  totalValue: z.number().finite(),
  grossValue: z.number().finite(),
  entries: z.array(AvantEntrySchema),
});

const AvantBreakdownSchema = z.object({
  updatedAtIso: z.string().min(1),
  rows: z.array(AvantRowSchema),
  detailedData: z.array(AvantDetailedCategorySchema),
});

const AvantTransparencySchema = z.object({
  breakdown: AvantBreakdownSchema,
  location: z.object({
    updatedAtIso: z.string().min(1),
    rows: z.array(AvantRowSchema),
  }),
  leverage: z.object({
    updatedAtIso: z.string().min(1),
    assetsUsd: z.number().finite(),
    liabilitiesUsd: z.number().finite(),
    coveragePercent: z.number().finite(),
  }),
  nav: z.object({
    netNav: z.number().finite(),
    periodEnd: z.string().min(1),
  }),
});

const AvantPayloadSchema = z.object({
  transparency: AvantTransparencySchema,
});

export type AvantPayload = z.output<typeof AvantPayloadSchema>;

interface CategorySliceMeta {
  sourceKey: string;
  name: string;
  risk: ReserveSlice["risk"];
  assetClass: ReserveSlice["assetClass"];
}

// The six source-native breakdown category labels; the "Perpetuals" category
// is net short only, so it never emits a long slice.
const REVIEWED_LABELS = new Set([
  "Stablecoins",
  "Other",
  "ETH & Derivatives",
  "AVAX & Derivatives",
  "BTC & Derivatives",
  "Perpetuals",
]);

// Non-stable strategy categories retain their reviewed gross-long grouping.
// Stablecoin source labels are split below; the issuer feed has no token
// contracts, so names alone never establish a tracked claim.
const SLICE_META: Record<string, CategorySliceMeta> = {
  Other: {
    sourceKey: "avant-reserves-api:other-long",
    name: "Long altcoin, token and derivative positions (gross)",
    risk: "high",
    assetClass: "hedged-crypto",
  },
  "ETH & Derivatives": {
    sourceKey: "avant-reserves-api:other-long",
    name: "Long altcoin, token and derivative positions (gross)",
    risk: "high",
    assetClass: "hedged-crypto",
  },
  "AVAX & Derivatives": {
    sourceKey: "avant-reserves-api:other-long",
    name: "Long altcoin, token and derivative positions (gross)",
    risk: "high",
    assetClass: "hedged-crypto",
  },
  "BTC & Derivatives": {
    sourceKey: "avant-reserves-api:other-long",
    name: "Long altcoin, token and derivative positions (gross)",
    risk: "high",
    assetClass: "hedged-crypto",
  },
};

interface CategoryTotals {
  longUsd: number;
  debtUsd: number;
  netUsd: number;
}

function closeEnough(actual: number, expected: number, tolerance: number, floor = 0.01): boolean {
  return Math.abs(actual - expected) <= Math.max(floor, Math.abs(expected) * tolerance);
}

/**
 * Adapts Avant's avUSD metrics payload into a gross-assets view: slices are
 * gross long positions, while gross debt (including perpetual shorts) is
 * published as grossLongUsd / grossFinancingDebtUsd /
 * grossLeverageCoverageRatio under `details` and never netted into the
 * stablecoin slice. Those are leverage-coverage totals, not assets backing the
 * coin's liabilities, so this adapter publishes no collateralization ratio.
 * Freshness comes from the reserve snapshot `updatedAtIso`/`periodEnd`, not the
 * daily yield refresh clock.
 */
export function adaptAvantReserves(payload: AvantPayload): AdapterResult {
  const { breakdown, location, leverage, nav } = payload.transparency;

  if (breakdown.updatedAtIso !== nav.periodEnd
    || breakdown.updatedAtIso !== location.updatedAtIso
    || breakdown.updatedAtIso !== leverage.updatedAtIso) {
    throw new Error(
      `Avant reserve snapshot timestamps disagree: breakdown ${breakdown.updatedAtIso}, `
      + `location ${location.updatedAtIso}, leverage ${leverage.updatedAtIso}, nav periodEnd ${nav.periodEnd}`,
    );
  }
  if (leverage.assetsUsd <= 0 || leverage.liabilitiesUsd <= 0) {
    throw new Error(`Avant leverage totals are non-positive (${leverage.assetsUsd} / ${leverage.liabilitiesUsd})`);
  }

  const rowsByLabel = new Map(breakdown.rows.map((row) => [row.label, row]));
  const categoryTotals = new Map<string, CategoryTotals>();
  let longSum = 0;
  let debtSum = 0;
  const entries: Array<{ category: string; name: string; valueUsd: number; isDebt: boolean }> = [];

  for (const detail of breakdown.detailedData) {
    if (!REVIEWED_LABELS.has(detail.category)) {
      throw new Error(`Avant breakdown category ${JSON.stringify(detail.category)} is outside the reviewed set`);
    }
    let categoryLong = 0;
    let categoryDebt = 0;
    let signedSum = 0;
    let absoluteSum = 0;
    for (const entry of detail.entries) {
      // The issuer's isDebt flag is authoritative; a debt entry can carry a
      // positive value (e.g. a tiny residual eusde position), so magnitudes
      // are aggregated rather than asserted by sign. The per-category and
      // leverage cross-checks below catch genuine inconsistencies.
      if (entry.isDebt) {
        categoryDebt += Math.abs(entry.value);
      } else {
        categoryLong += entry.value;
      }
      signedSum += entry.value;
      absoluteSum += Math.abs(entry.value);
      entries.push({
        category: detail.category,
        name: entry.name,
        valueUsd: entry.value,
        isDebt: entry.isDebt,
      });
    }
    if (!closeEnough(signedSum, detail.totalValue, CATEGORY_TOTAL_REL_TOLERANCE)) {
      throw new Error(
        `Avant ${detail.category} entry sum ${signedSum} disagrees with category totalValue ${detail.totalValue}`,
      );
    }
    if (!closeEnough(absoluteSum, detail.grossValue, CATEGORY_TOTAL_REL_TOLERANCE)) {
      throw new Error(
        `Avant ${detail.category} absolute entry sum ${absoluteSum} disagrees with category grossValue ${detail.grossValue}`,
      );
    }
    const row = rowsByLabel.get(detail.category);
    if (!row || !closeEnough(detail.totalValue, row.valueUsd, CATEGORY_TOTAL_REL_TOLERANCE)) {
      throw new Error(`Avant ${detail.category} totalValue disagrees with the breakdown row`);
    }
    if (detail.category === "Perpetuals" && categoryLong > 0) {
      throw new Error("Avant Perpetuals category contains unexpected long positions");
    }
    categoryTotals.set(detail.category, {
      longUsd: categoryLong,
      debtUsd: categoryDebt,
      netUsd: detail.totalValue,
    });
    longSum += categoryLong;
    debtSum += categoryDebt;
  }

  if (!closeEnough(longSum, leverage.assetsUsd, LEVERAGE_REL_TOLERANCE)) {
    throw new Error(`Avant gross long sum ${longSum} disagrees with leverage assets ${leverage.assetsUsd}`);
  }
  if (!closeEnough(debtSum, leverage.liabilitiesUsd, LEVERAGE_REL_TOLERANCE)) {
    throw new Error(`Avant gross debt sum ${debtSum} disagrees with leverage liabilities ${leverage.liabilitiesUsd}`);
  }
  const rowsSum = breakdown.rows.reduce((sum, row) => sum + row.valueUsd, 0);
  if (!closeEnough(rowsSum, nav.netNav, NAV_REL_TOLERANCE, 1)) {
    throw new Error(`Avant breakdown row sum ${rowsSum} disagrees with net NAV ${nav.netNav}`);
  }
  for (const row of breakdown.rows) {
    if (!REVIEWED_LABELS.has(row.label)) {
      throw new Error(`Avant breakdown row ${JSON.stringify(row.label)} is outside the reviewed set`);
    }
  }

  const perpShortsUsd = categoryTotals.get("Perpetuals")?.debtUsd ?? 0;
  const bridgesUsd = location.rows.find((row) => row.label === "Bridges")?.valueUsd ?? 0;
  const pendingDeploymentUsd = location.rows.find((row) => row.label === "Pending Deployment")?.valueUsd ?? 0;
  let unknownChainLongUsd = 0;
  let unknownChainDebtUsd = 0;
  for (const detail of breakdown.detailedData) {
    for (const entry of detail.entries) {
      for (const chain of entry.chains) {
        if (chain.name !== "Unknown") continue;
        if (entry.isDebt) unknownChainDebtUsd += Math.abs(chain.value);
        else unknownChainLongUsd += chain.value;
      }
    }
  }

  const warnings = [
    reserveInfoWarning(
      "gross-leverage-disclosed",
      `Gross long positions ($${longSum}) and gross debt ($${debtSum}) `
      + "are published as separate totals; gross-normalized shares are not leveraged net-NAV loss coefficients.",
    ),
  ];
  if (bridgesUsd > 0) {
    warnings.push(
      reserveInfoWarning(
        "bridges-positions-reported",
        `Avant reports $${bridgesUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })} `
        + "in bridge positions whose venue chains are not itemized.",
      ),
    );
  }

  const values: Array<ReserveSlice & { value: number }> = [];
  const stableLongs = new Map<string, { name: string; value: number }>();
  for (const detail of breakdown.detailedData) {
    if (detail.category === "Stablecoins") {
      for (const entry of detail.entries) {
        if (entry.isDebt || entry.value <= 0) continue;
        const key = entry.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "");
        if (!key) throw new Error("Avant stablecoin identity has no usable source key");
        const existing = stableLongs.get(key);
        if (existing && existing.name !== entry.name) {
          throw new Error(`Avant stablecoin source-key collision: ${entry.name}`);
        }
        if (existing) existing.value += entry.value;
        else stableLongs.set(key, { name: entry.name, value: entry.value });
      }
      continue;
    }
    const totals = categoryTotals.get(detail.category)!;
    if (totals.longUsd <= 0) continue;
    const meta = SLICE_META[detail.category];
    if (!meta) throw new Error(`Avant category ${detail.category} has no reviewed slice identity`);
    values.push({ ...meta, pct: 0, value: totals.longUsd });
  }
  for (const [key, entry] of stableLongs) {
    values.push({
      sourceKey: `avant-reserves-api:stablecoin-long:${key}`,
      name: `${entry.name} long positions (gross; identity unverified)`,
      value: entry.value,
      pct: 0,
      risk: "medium",
      assetClass: "stablecoin",
    });
  }
  if (stableLongs.size > 0) {
    warnings.push(reserveInfoWarning(
      "unverified-avant-token-identities",
      "Stablecoin long positions retain measured source identities; token contracts, receipt claims and bridge escrow are undisclosed, so tracked dependencies are withheld.",
    ));
  }

  const sourceTimestamp = Math.floor(Date.parse(breakdown.updatedAtIso) / 1000);
  if (!Number.isFinite(sourceTimestamp)) {
    throw new Error(`Avant reserve updatedAtIso is not a parseable timestamp: ${breakdown.updatedAtIso}`);
  }

  return {
    slices: slicesFromValues(values, null),
    warnings,
    metadata: {
      referenceNavUsd: nav.netNav,
      ...verifiedFreshnessMetadata(sourceTimestamp),
      details: {
        freshnessSource: "avant-reserve-snapshot",
        grossLongUsd: leverage.assetsUsd,
        grossFinancingDebtUsd: leverage.liabilitiesUsd,
        grossLeverageCoverageRatio: leverage.assetsUsd / leverage.liabilitiesUsd,
        navPeriodEnd: nav.periodEnd,
        leverageCoveragePct: leverage.coveragePercent,
        dependencyExposureBasis: "gross-positive-long-share",
        identityResolution: "unverified-source-labels",
        perpShortsUsd,
        bridgesUsd,
        pendingDeploymentUsd,
        unknownChainLongUsd,
        unknownChainDebtUsd,
        categories: Array.from(categoryTotals.entries()).map(([category, totals]) => ({
          category,
          longUsd: totals.longUsd,
          debtUsd: totals.debtUsd,
          netUsd: totals.netUsd,
        })),
        entries,
      },
    },
  };
}

export async function fetchAvantReservesApiReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, ADAPTER_KEY);
  parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const payload = await fetchJsonWithRetry<unknown>(input.url, signal, REQUEST_TIMEOUT_MS, ctx);
  return adaptAvantReserves(AvantPayloadSchema.parse(payload));
}
