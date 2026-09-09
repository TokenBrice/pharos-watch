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

// Reviewed gross-long bucket identities. The Stablecoins bucket is the long
// leg of the leveraged book; short/borrowed positions never net into it and
// are published as debt totals instead. The three tiny derivative buckets are
// folded into the "other" long slice because their values round below the
// slice precision; per-category amounts stay in metadata.details.
const SLICE_META: Record<string, CategorySliceMeta> = {
  Stablecoins: {
    sourceKey: "avant-reserves-api:stablecoin-long",
    name: "Long stablecoin positions (gross)",
    risk: "medium",
    assetClass: "stablecoin",
  },
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
 * published as totalLiabilitiesUsd / collateralizationRatio and never netted
 * into the stablecoin slice. Freshness comes from the reserve snapshot
 * `updatedAtIso`/`periodEnd`, not the daily yield refresh clock.
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
      "Gross long positions ($1.02bn) and gross debt ($891.97m, including $19.91m perpetual shorts) "
      + "are published as separate totals; debt is never netted into the stablecoin slice.",
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

  const values = Array.from(categoryTotals.entries())
    .filter(([, totals]) => totals.longUsd > 0)
    .map(([category, totals]) => {
      const meta = SLICE_META[category];
      if (!meta) {
        throw new Error(`Avant category ${category} has long positions but no reviewed slice identity`);
      }
      return {
        value: totals.longUsd,
        sourceKey: meta.sourceKey,
        name: meta.name,
        risk: meta.risk,
        assetClass: meta.assetClass,
      };
    });

  const sourceTimestamp = Math.floor(Date.parse(breakdown.updatedAtIso) / 1000);
  if (!Number.isFinite(sourceTimestamp)) {
    throw new Error(`Avant reserve updatedAtIso is not a parseable timestamp: ${breakdown.updatedAtIso}`);
  }

  return {
    slices: slicesFromValues(values, 1),
    warnings,
    metadata: {
      totalAssetsUsd: leverage.assetsUsd,
      totalLiabilitiesUsd: leverage.liabilitiesUsd,
      collateralizationRatio: leverage.assetsUsd / leverage.liabilitiesUsd,
      referenceNavUsd: nav.netNav,
      ...verifiedFreshnessMetadata(sourceTimestamp),
      details: {
        freshnessSource: "avant-reserve-snapshot",
        navPeriodEnd: nav.periodEnd,
        leverageCoveragePct: leverage.coveragePercent,
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
