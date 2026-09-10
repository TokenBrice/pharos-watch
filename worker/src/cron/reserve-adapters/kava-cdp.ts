import { z } from "zod";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import {
  buildUnknownExposureWarning,
  fetchJsonWithRetry,
  notApplicableFreshnessMetadata,
  parseBoundedDecimals,
  requireJsonInput,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromValues,
  valueUsdFromBigIntPrice,
} from "./helpers";
import {
  KavaBlockSchema,
  parseFinitePositiveDecimal,
  validateKavaBlockHeader,
  type KavaBlockPayload,
} from "../../lib/kava-lcd";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "kava-cdp";
const KAVA_USDX_MARKET_ID = "usdx:usd";

// USDX is Kava-native: 6 decimals on both the bank supply (10,001,377.482335
// observed 2026-09-09) and the CDP principal ledger.
const USDX_DENOM = "usdx";
const USDX_DECIMALS = 6;

const KAVA_CDP_PROOF_KIND = "kava-cdp-module-totals";

const KavaAmountSchema = z.object({
  denom: z.string(),
  amount: z.string(),
});

const KavaCdpTotalsSchema = z.object({
  total_collateral: z.array(
    z.object({
      collateral_type: z.string(),
      amount: KavaAmountSchema,
    }),
  ),
});

const KavaCdpPrincipalSchema = z.object({
  total_principal: z.array(
    z.object({
      collateral_type: z.string(),
      amount: KavaAmountSchema,
    }),
  ),
});

const KavaCdpParamsSchema = z.object({
  params: z.object({
    collateral_params: z.array(
      z.object({
        denom: z.string(),
        type: z.string(),
        spot_market_id: z.string(),
        conversion_factor: z.string(),
        liquidation_ratio: z.string(),
      }),
    ),
  }),
});

const KavaPricefeedPricesSchema = z.object({
  prices: z.array(
    z.object({
      market_id: z.string(),
      price: z.string(),
    }),
  ),
});

const KavaBankSupplySchema = z.object({
  amount: KavaAmountSchema,
});

export interface KavaCdpTotalsPayload {
  total_collateral: Array<{ collateral_type: string; amount: { denom: string; amount: string } }>;
}

export interface KavaCdpPrincipalPayload {
  total_principal: Array<{ collateral_type: string; amount: { denom: string; amount: string } }>;
}

export interface KavaCdpParamsPayload {
  params: {
    collateral_params: Array<{
      denom: string;
      type: string;
      spot_market_id: string;
      conversion_factor: string;
      liquidation_ratio: string;
    }>;
  };
}

export interface KavaPricefeedPricesPayload {
  prices: Array<{ market_id: string; price: string }>;
}

export interface KavaBankSupplyPayload {
  amount: { denom: string; amount: string };
}

export type { KavaBlockPayload } from "../../lib/kava-lcd";

// Reviewed per-denom slice identity for every collateral denom the Kava CDP
// module has ever admitted (2026-08-28 CDP inventory refresh). Risk tiers match
// the shared canonical reserve-asset taxonomy: stablecoins low, wrapped BTC/XRP
// medium, volatile native assets high, governance tokens very-high.
const COLLATERAL_DENOM_SLICE_META: Record<string, { name: string; risk: ReserveSlice["risk"] }> = {
  bnb: { name: "BNB", risk: "high" },
  btcb: { name: "BTCB", risk: "medium" },
  hbtc: { name: "HBTC", risk: "medium" },
  xrpb: { name: "XRPB", risk: "medium" },
  busd: { name: "BUSD", risk: "low" },
  "erc20/tether/usdt": { name: "USDT", risk: "low" },
  ukava: { name: "KAVA", risk: "high" },
  hard: { name: "HARD", risk: "very-high" },
  swp: { name: "SWP", risk: "very-high" },
};

export interface KavaCdpState {
  collateral: KavaCdpTotalsPayload;
  principal: KavaCdpPrincipalPayload;
  params: KavaCdpParamsPayload;
  prices: KavaPricefeedPricesPayload;
  supply: KavaBankSupplyPayload;
  block: KavaBlockPayload;
  /** Attempt start time (Unix seconds) used to age-check the pinned block. */
  nowSec: number;
}

function parseAmountUnits(raw: string, label: string): bigint {
  try {
    const value = BigInt(raw);
    if (value < 0n) throw new Error("negative");
    return value;
  } catch {
    throw new Error(`${ADAPTER_KEY}: ${label} amount is not a non-negative integer string: ${raw.slice(0, 32)}`);
  }
}

interface CollateralParam {
  denom: string;
  spotMarketId: string;
  decimals: number;
}

interface PricedCollateralDenom {
  denom: string;
  name: string;
  risk: ReserveSlice["risk"];
  valueUsd: number;
}

export function adaptKavaCdpState(state: KavaCdpState): AdapterResult {
  const warnings: LiveReserveWarning[] = [];

  // ── Block pinning (freshness anchor) ─────────────────────────────────────
  const { header } = state.block.block;
  const blockPin = validateKavaBlockHeader(header, state.nowSec);
  if (blockPin == null) {
    throw new Error(`${ADAPTER_KEY}: latest block identity or freshness validation failed`);
  }
  const { blockHeight } = blockPin;

  // ── Price map (one entry per live pricefeed market) ──────────────────────
  const priceMap = new Map<string, number>();
  for (const market of state.prices.prices) {
    const price = parseFinitePositiveDecimal(market.price);
    if (price != null) priceMap.set(market.market_id, price);
  }
  const usdxPrice = priceMap.get(KAVA_USDX_MARKET_ID);
  if (usdxPrice == null) {
    throw new Error(`${ADAPTER_KEY}: USDX liability price market ${KAVA_USDX_MARKET_ID} is missing from the pricefeed`);
  }

  // ── Collateral params (spot market + denom decimals per type) ────────────
  const paramsByType = new Map<string, CollateralParam>();
  for (const row of state.params.params.collateral_params) {
    if (paramsByType.has(row.type)) {
      throw new Error(`${ADAPTER_KEY}: duplicate collateral param row for type ${row.type}`);
    }
    const decimals = parseBoundedDecimals(Number(row.conversion_factor));
    if (decimals == null) {
      throw new Error(`${ADAPTER_KEY}: collateral type ${row.type} has an invalid conversion_factor`);
    }
    paramsByType.set(row.type, { denom: row.denom, spotMarketId: row.spot_market_id, decimals });
  }

  // ── Principal (USDX debt per collateral type) ────────────────────────────
  const principalTokensByType = new Map<string, number>();
  let principalTokens = 0;
  for (const row of state.principal.total_principal) {
    if (row.amount.denom !== USDX_DENOM) {
      throw new Error(`${ADAPTER_KEY}: principal row for ${row.collateral_type} is denominated in ${row.amount.denom}, expected ${USDX_DENOM}`);
    }
    const tokens = Number(parseAmountUnits(row.amount.amount, `principal(${row.collateral_type})`)) / 10 ** USDX_DECIMALS;
    if (!Number.isFinite(tokens)) {
      throw new Error(`${ADAPTER_KEY}: principal for ${row.collateral_type} overflows the number range`);
    }
    principalTokensByType.set(row.collateral_type, tokens);
    principalTokens += tokens;
  }

  // ── Collateral valuation ─────────────────────────────────────────────────
  const pricedByDenom = new Map<string, PricedCollateralDenom>();
  const unpricedTypes: string[] = [];
  let unpricedPrincipalTokens = 0;
  const collateralTypes = new Set<string>();

  for (const row of state.collateral.total_collateral) {
    collateralTypes.add(row.collateral_type);
    const param = paramsByType.get(row.collateral_type);
    if (param == null) {
      unpricedTypes.push(row.collateral_type);
      unpricedPrincipalTokens += principalTokensByType.get(row.collateral_type) ?? 0;
      continue;
    }
    const rawAmount = parseAmountUnits(row.amount.amount, `collateral(${row.collateral_type})`);
    if (rawAmount === 0n) continue;
    const price = priceMap.get(param.spotMarketId);
    const valueUsd = price == null ? Number.NaN : valueUsdFromBigIntPrice(rawAmount, param.decimals, price);
    if (!Number.isFinite(valueUsd) || valueUsd <= 0) {
      unpricedTypes.push(row.collateral_type);
      unpricedPrincipalTokens += principalTokensByType.get(row.collateral_type) ?? 0;
      continue;
    }
    const existing = pricedByDenom.get(param.denom);
    if (existing) {
      existing.valueUsd += valueUsd;
    } else {
      const meta = COLLATERAL_DENOM_SLICE_META[param.denom];
      if (!meta) {
        warnings.push(reserveInfoWarning(
          "unreviewed-collateral-denom",
          `${ADAPTER_KEY}: collateral denom ${param.denom} has no reviewed slice metadata; published with conservative risk`,
        ));
      }
      pricedByDenom.set(param.denom, {
        denom: param.denom,
        name: meta?.name ?? param.denom.split("/").pop()!.toUpperCase(),
        risk: meta?.risk ?? "high",
        valueUsd,
      });
    }
  }

  // A collateral type present in the totals but missing from the CDP params is
  // a data anomaly: surface it rather than silently dropping its backing.
  const missingParamTypes = [...collateralTypes].filter((type) => !paramsByType.has(type));
  for (const type of missingParamTypes) {
    warnings.push(reserveDegradedWarning(
      "missing-collateral-param",
      `${ADAPTER_KEY}: collateral type ${type} has no row in /kava/cdp/v1beta1/params`,
    ));
  }
  const orphanPrincipalTypes = [...principalTokensByType.keys()].filter((type) => !collateralTypes.has(type));
  for (const type of orphanPrincipalTypes) {
    warnings.push(reserveDegradedWarning(
      "missing-collateral-total",
      `${ADAPTER_KEY}: principal row for ${type} has no matching collateral total`,
    ));
  }

  const totalCollateralUsd = [...pricedByDenom.values()].reduce((sum, row) => sum + row.valueUsd, 0);
  if (!(totalCollateralUsd > 0)) {
    throw new Error(`${ADAPTER_KEY}: no priced collateral value could be measured`);
  }

  // ── Unknown exposure from unpriced collateral types ──────────────────────
  // Without a live pricefeed market the USD value of that collateral cannot be
  // measured, so the unknown share is quantified as the share of USDX
  // principal (debt) those types back - the only precise per-type weight the
  // CDP ledger exposes.
  const unknownExposurePct = principalTokens > 0
    ? (unpricedPrincipalTokens / principalTokens) * 100
    : 0;
  if (unpricedTypes.length > 0) {
    warnings.push(buildUnknownExposureWarning({ adapterKey: "kava-cdp", code: "unpriced-collateral-type",
    message:
      `${ADAPTER_KEY}: collateral type(s) ${unpricedTypes.sort().join(", ")} have no live pricefeed market and back ${unknownExposurePct.toFixed(2)}% of USDX principal; their composition is unmeasured`,
    unknownExposurePct, }));
  }

  // ── Supply and ratios ────────────────────────────────────────────────────
  const supplyRow = state.supply.amount;
  if (supplyRow.denom !== USDX_DENOM) {
    throw new Error(`${ADAPTER_KEY}: bank supply row is denominated in ${supplyRow.denom}, expected ${USDX_DENOM}`);
  }
  const supplyTokens = Number(parseAmountUnits(supplyRow.amount, "supply")) / 10 ** USDX_DECIMALS;
  if (!Number.isFinite(supplyTokens) || supplyTokens <= 0) {
    throw new Error(`${ADAPTER_KEY}: bank supply is not a finite positive token count`);
  }

  // USDX trades below par (0.66 observed), so the liability is valued at the
  // live pricefeed price rather than assumed to be one dollar per USDX.
  const totalLiabilitiesUsd = principalTokens * usdxPrice;
  const collateralizationRatio = totalLiabilitiesUsd > 0 ? totalCollateralUsd / totalLiabilitiesUsd : undefined;
  if (collateralizationRatio != null && collateralizationRatio < 1) {
    warnings.push(reserveDegradedWarning(
      "reserve-undercollateralized",
      `${ADAPTER_KEY}: CDP collateral covers ${(collateralizationRatio * 100).toFixed(2)}% of market-valued USDX principal`,
    ));
  }

  const slices = slicesFromValues(
    [...pricedByDenom.values()].map((row) => ({
      sourceKey: `${ADAPTER_KEY}:${row.denom}`,
      name: row.name,
      value: row.valueUsd,
      risk: row.risk,
    })),
  );

  const details = {
    proofKind: KAVA_CDP_PROOF_KIND,
    chainId: header.chain_id,
    blockHeight,
    blockTimeIso: header.time,
    usdxPriceUsd: usdxPrice,
    principalUsdxTokens: principalTokens,
    collateralTypes: [...collateralTypes].sort().map((type) => {
      const param = paramsByType.get(type);
      return {
        type,
        denom: param?.denom ?? null,
        marketId: param?.spotMarketId ?? null,
        priced: param != null && priceMap.has(param.spotMarketId),
      };
    }),
  };

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata(details),
      totalReserveUsd: totalCollateralUsd,
      totalLiabilitiesUsd,
      supplyTokens,
      supplyUsd: supplyTokens * usdxPrice,
      ...(collateralizationRatio !== undefined ? { collateralizationRatio } : {}),
      ...(unpricedTypes.length > 0 && unknownExposurePct > 0 ? { unknownExposurePct } : {}),
    },
  };
}

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, label: string): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new Error(`${ADAPTER_KEY}: ${label} response failed schema validation`);
  }
  return result.data;
}

export async function fetchKavaCdpReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, ADAPTER_KEY);
  const lcdBase = new URL(input.url).origin;
  const nowSec = ctx?.nowSec ?? Math.floor(Date.now() / 1_000);

  // Sequential reads keep the attempt inside the orchestrator's shared
  // connection budget; every fetch runs through the adapter I/O limiter.
  const collateral = parsePayload(
    KavaCdpTotalsSchema,
    await fetchJsonWithRetry<unknown>(input.url, signal, 12_000, ctx),
    "totalCollateral",
  );
  const principal = parsePayload(
    KavaCdpPrincipalSchema,
    await fetchJsonWithRetry<unknown>(`${lcdBase}/kava/cdp/v1beta1/totalPrincipal`, signal, 12_000, ctx),
    "totalPrincipal",
  );
  const params = parsePayload(
    KavaCdpParamsSchema,
    await fetchJsonWithRetry<unknown>(`${lcdBase}/kava/cdp/v1beta1/params`, signal, 12_000, ctx),
    "cdp params",
  );
  const prices = parsePayload(
    KavaPricefeedPricesSchema,
    await fetchJsonWithRetry<unknown>(`${lcdBase}/kava/pricefeed/v1beta1/prices`, signal, 12_000, ctx),
    "pricefeed prices",
  );
  const supply = parsePayload(
    KavaBankSupplySchema,
    await fetchJsonWithRetry<unknown>(`${lcdBase}/cosmos/bank/v1beta1/supply/by_denom?denom=${USDX_DENOM}`, signal, 12_000, ctx),
    "bank supply",
  );
  const block = parsePayload(
    KavaBlockSchema,
    await fetchJsonWithRetry<unknown>(`${lcdBase}/cosmos/base/tendermint/v1beta1/blocks/latest`, signal, 12_000, ctx),
    "latest block",
  );

  return adaptKavaCdpState({ collateral, principal, params, prices, supply, block, nowSec });
}
