import { z } from "zod";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import { fetchJsonWithRetry, verifiedFreshnessMetadata } from "./helpers";
import { requireJsonInput } from "./input-guards";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "./validate";

export const MIDAS_MTBILL_TRANSPARENCY_URL = "https://api-prod.midas.app/api/transparency?token=mTBILL";
const MILLION = 1_000_000;
const ReportSchema = z.object({
  updatedAt: z.string().datetime(),
  reports: z.object({
    main_positions: z.object({
      pv_usd: z.record(z.string(), z.number().finite().nonnegative()),
      delta_usd: z.record(z.string(), z.number().finite().nonnegative()),
    }),
    assets_by_protocol: z.object({
      assets: z.object({ wallet: z.number().finite().positive(), total: z.number().finite().positive() }).strict(),
      equity: z.object({ wallet: z.number().finite().positive(), total: z.number().finite().positive() }).strict(),
      protocol_type: z.object({ wallet: z.literal("custody"), total: z.null() }).strict(),
    }),
    assets_by_protocol_chain: z.object({ equity: z.object({
      "('wallet', 'ethereum')": z.number().finite().positive(),
      "('total', '')": z.number().finite().positive(),
    }).strict() }),
    asset_values: z.object({ pv_usd: z.object({ ethereum: z.number().finite().positive(), total: z.number().finite().positive() }).strict() }),
  }),
});
const HOLDINGS = [
  { tuple: "('USTB', 'CASH', 'wallet', 'ethereum', 'USTB')", sourceKey: "midas-mtbill:ustb", name: "Superstate Short Duration US Government Securities Fund (USTB)", coinId: "ustb-superstate" },
  { tuple: "('BUIDL', 'CASH', 'wallet', 'ethereum', 'BUIDL')", sourceKey: "midas-mtbill:buidl", name: "BlackRock USD Institutional Digital Liquidity Fund (BUIDL)", coinId: "buidl-blackrock" },
] as const;

export function adaptMidasMtbillTransparency(payload: unknown, nowSec: number, maxAgeSec = 259_200): AdapterResult {
  const { reports, updatedAt } = ReportSchema.parse(payload);
  const sourceTimestamp = Math.floor(Date.parse(updatedAt) / 1000);
  if (sourceTimestamp > nowSec + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC || nowSec - sourceTimestamp > maxAgeSec) {
    throw new Error("midas-mtbill: stale or future portfolio timestamp");
  }
  const { pv_usd: positions, delta_usd: deltas } = reports.main_positions;
  if (Object.keys(positions).length !== HOLDINGS.length || Object.keys(deltas).length !== HOLDINGS.length
    || HOLDINGS.some(({ tuple }) => positions[tuple] == null || positions[tuple] <= 0 || positions[tuple] !== deltas[tuple])) {
    throw new Error("midas-mtbill: unreviewed, missing or leveraged position scope");
  }
  const totalMillions = reports.assets_by_protocol.equity.total;
  // Assets must equal equity: the reviewed mTBILL source is an unleveraged
  // wallet portfolio, unlike other Midas products with borrowed offsets.
  const exactTotals = [
    reports.assets_by_protocol.assets.total, reports.assets_by_protocol.assets.wallet,
    reports.assets_by_protocol.equity.wallet, reports.assets_by_protocol_chain.equity["('total', '')"],
  ];
  if (exactTotals.some((value) => Math.abs(value - totalMillions) * MILLION > 0.01)) {
    throw new Error("midas-mtbill: assets and equity do not reconcile");
  }
  const roundedTotals = [reports.assets_by_protocol_chain.equity["('wallet', 'ethereum')"], ...Object.values(reports.asset_values.pv_usd)];
  if (roundedTotals.some((value) => Math.abs(value - totalMillions) * MILLION > 1_000)) {
    throw new Error("midas-mtbill: chain totals do not reconcile");
  }
  const totalReserveUsd = totalMillions * MILLION;
  const namedTotalUsd = HOLDINGS.reduce((sum, holding) => sum + positions[holding.tuple] * MILLION, 0);
  const residualUsd = totalReserveUsd - namedTotalUsd;
  if (!Number.isFinite(totalReserveUsd) || !Number.isFinite(residualUsd) || residualUsd < 0) {
    throw new Error("midas-mtbill: named positions exceed total equity");
  }
  // The issuer's main-position table has a $100k display cutoff and $1k
  // precision. Retain the entire difference as unknown, never distribute it
  // into USTB/BUIDL or infer that a labelled wallet contains only one asset.
  return {
    slices: [
      ...HOLDINGS.map((holding) => ({
        sourceKey: holding.sourceKey, name: holding.name,
        pct: positions[holding.tuple] * MILLION / totalReserveUsd * 100,
        risk: "low" as const, coinId: holding.coinId, depType: "collateral" as const,
      })),
      ...(residualUsd > 0 ? [{ sourceKey: "midas-mtbill:unclassified-residual", name: "Unclassified portfolio residual and position rounding", pct: residualUsd / totalReserveUsd * 100, risk: "high" as const }] : []),
    ],
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp), totalReserveUsd,
      unknownExposurePct: residualUsd / totalReserveUsd * 100,
      details: {
        sourceUrl: MIDAS_MTBILL_TRANSPARENCY_URL,
        compositionEvidence: "issuer-reported-portfolio",
        portfolioScope: "mTBILL unleveraged Ethereum wallet portfolio",
        portfolioUpdatedAt: updatedAt,
        sourceAmountUnit: "USD millions", positionPrecisionUsd: 1_000,
        mainPositionDisplayCutoffUsd: 100_000,
        residualUsd,
        residualDescription: "Unclassified smaller positions plus display rounding; no asset or custody identity inferred",
      },
    },
  };
}

export async function fetchMidasMtbillReserves(
  coin: StablecoinMeta, config: LiveReservesConfig, signal: AbortSignal, ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "midas-mtbill");
  if (coin.id !== "mtbill-midas" || input.url !== MIDAS_MTBILL_TRANSPARENCY_URL) {
    throw new Error("midas-mtbill: unreviewed token or source scope");
  }
  return adaptMidasMtbillTransparency(
    await fetchJsonWithRetry(input.url, signal, 12_000, ctx),
    ctx?.nowSec ?? Math.floor(Date.now() / 1000), config.scoring?.maxSourceAgeSec,
  );
}
