import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonAdapterInput,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  reserveDegradedWarning,
  slicesFromValues,
  strictAmountParser,
  verifiedFreshnessMetadata,
} from "./helpers";

const ADAPTER_KEY = "bridge-transparency";

/** Absolute USD tolerance for reconciliation of disclosed components to assets.
 *  Bridge rounds headline totals to cents: pathUSD's components can sum $0.32
 *  above its published reserves. Liability coverage is checked separately;
 *  genuine asset drift beyond $1 remains degraded. */
const COMPONENT_SUM_TOLERANCE_USD = 1;

interface BridgeReserveComponent {
  type?: string;
  amount?: string | number;
}

export interface BridgeTransparencyPayload {
  last_updated?: string;
  total_onchain_amount?: string | number;
  total_reserve_amount?: string | number;
  reserves?: BridgeReserveComponent[];
  collateralization_ratio?: string | number;
}

interface BridgeComponentConfig {
  sourceKey: string;
  name: string;
  risk: ReserveSlice["risk"];
  assetClass: ReserveSlice["assetClass"];
  issuerOrObligor: string;
}

/** Bridge discloses exactly two reserve components: cash at approved bank
 *  counterparties (segregated, bankruptcy-remote accounts) and Treasury
 *  exposure. Both are asset classes rather than bare symbols, so their tier is
 *  stated here from the corpus convention every other adapter follows — U.S.
 *  Treasury bills and custodied bank cash are published `very-low`, which is
 *  also the reviewed tier of the curated Bridge baskets. A hardcoded `low` here
 *  silently scored both coins 25 points under their curated coverage.
 *  Unknown components are published as high-risk unmapped slices with a
 *  degraded warning, never dropped. */
const BRIDGE_COMPONENT_CONFIG: Record<string, BridgeComponentConfig> = {
  cash: {
    sourceKey: "bridge-transparency:cash",
    name: "Cash",
    risk: "very-low",
    assetClass: "cash",
    issuerOrObligor: "Bridge-approved bank counterparties",
  },
  treasury: {
    sourceKey: "bridge-transparency:treasury",
    name: "Treasury",
    risk: "very-low",
    assetClass: "treasury-bill",
    issuerOrObligor: "United States Treasury",
  },
};

/** CASH's dashboard combines direct Treasury exposure and government MMFs;
 *  it does not disclose instrument, fund-counterparty, or provider weights. */
const CASH_COMPONENT_CONFIG: Record<string, BridgeComponentConfig> = {
  cash: {
    sourceKey: "bridge-transparency:cash",
    name: "Cash and deposit accounts in the BBI Reserve",
    risk: "very-low",
    assetClass: "bank-deposit",
    issuerOrObligor: "Depository institutions holding the Bridge Building Inc Reserve (institutions undisclosed)",
  },
  treasury: {
    sourceKey: "bridge-transparency:treasury",
    name: "U.S. Treasury and government money-market fund exposure",
    risk: "very-low",
    assetClass: "other",
    issuerOrObligor: "United States Treasury underlying exposure; government money-market fund counterparties undisclosed",
  },
};

const parseStrictAmount = strictAmountParser(ADAPTER_KEY);

export function adaptBridgeTransparency(payload: BridgeTransparencyPayload, slug: string): AdapterResult {
  if (!Array.isArray(payload.reserves) || payload.reserves.length === 0) {
    throw new Error(`${ADAPTER_KEY} payload missing reserves`);
  }

  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.last_updated);
  if (sourceTimestamp == null) {
    throw new Error(`${ADAPTER_KEY} payload has an unreadable last_updated`);
  }

  const reservesUsd = parseStrictAmount(payload.total_reserve_amount, "total_reserve_amount");
  if (!(reservesUsd > 0)) {
    throw new Error(`${ADAPTER_KEY} payload has invalid total_reserve_amount`);
  }

  const liabilitiesUsd = parseStrictAmount(payload.total_onchain_amount, "total_onchain_amount");
  if (!(liabilitiesUsd > 0)) {
    throw new Error(`${ADAPTER_KEY} payload has invalid total_onchain_amount`);
  }

  const warnings: LiveReserveWarning[] = [];
  const componentTotals = new Map<string, number>();
  for (const [index, component] of payload.reserves.entries()) {
    if (component == null || typeof component !== "object") {
      throw new Error(`${ADAPTER_KEY} reserves entry ${index} is not an object`);
    }
    if (typeof component.type !== "string" || component.type.trim() === "") {
      throw new Error(`${ADAPTER_KEY} reserves entry ${index} has no type`);
    }
    const amount = parseStrictAmount(component.amount, `reserves entry ${index} amount`);
    if (amount < 0) {
      throw new Error(`${ADAPTER_KEY} reserves entry ${index} has a negative amount`);
    }
    const normalizedType = component.type.trim().toLowerCase();
    componentTotals.set(normalizedType, (componentTotals.get(normalizedType) ?? 0) + amount);
  }

  const sliceInputs: Array<{
    value: number;
    sourceKey?: string;
    name: string;
    risk: ReserveSlice["risk"];
    assetClass?: ReserveSlice["assetClass"];
    issuerOrObligor?: string;
  }> = [];
  const componentConfig = slug === "cash" ? CASH_COMPONENT_CONFIG : BRIDGE_COMPONENT_CONFIG;
  for (const [type, amount] of componentTotals) {
    if (amount <= 0) continue;
    const config = Object.prototype.hasOwnProperty.call(componentConfig, type) ? componentConfig[type] : undefined;
    if (!config) {
      warnings.push(reserveDegradedWarning(
        "unknown-component",
        `Unmapped ${ADAPTER_KEY} reserve component: ${type} ($${amount.toFixed(2)})`,
      ));
      sliceInputs.push({ name: `${type} (unmapped)`, value: amount, risk: "high" });
      continue;
    }
    sliceInputs.push({
      sourceKey: config.sourceKey,
      name: config.name,
      value: amount,
      risk: config.risk,
      assetClass: config.assetClass,
      issuerOrObligor: config.issuerOrObligor,
    });
  }

  if (sliceInputs.length === 0) {
    throw new Error(`${ADAPTER_KEY} payload contained no positive reserve component amounts`);
  }

  const componentSumUsd = sliceInputs.reduce((sum, slice) => sum + slice.value, 0);
  const driftVsReservesUsd = componentSumUsd - reservesUsd;
  const driftVsLiabilitiesUsd = componentSumUsd - liabilitiesUsd;
  if (Math.abs(driftVsReservesUsd) > COMPONENT_SUM_TOLERANCE_USD) {
    warnings.push(reserveDegradedWarning(
      "bridge-component-sum-drift",
      `Reserve components sum to $${componentSumUsd.toFixed(2)}, a $${driftVsReservesUsd.toFixed(2)} drift `
      + `from published reserve assets ($${reservesUsd.toFixed(2)}), beyond `
      + `the $${COMPONENT_SUM_TOLERANCE_USD.toFixed(0)} rounding tolerance`,
    ));
  }

  const collateralizationRatio = reservesUsd / liabilitiesUsd;
  if (liabilitiesUsd - reservesUsd > COMPONENT_SUM_TOLERANCE_USD) {
    warnings.push(reserveDegradedWarning(
      "reserve-undercollateralized",
      `${ADAPTER_KEY} reserves cover ${(collateralizationRatio * 100).toFixed(6)}% of the on-chain liability`,
    ));
  }

  const details: Record<string, unknown> = {
    lastUpdated: payload.last_updated,
    slug,
    componentSumUsd,
    driftVsReservesUsd,
    driftVsLiabilitiesUsd,
  };
  if (payload.collateralization_ratio != null) {
    details.reportedCollateralizationRatio = parseStrictAmount(payload.collateralization_ratio, "collateralization_ratio");
  }

  return {
    slices: slicesFromValues(sliceInputs),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      totalReserveUsd: reservesUsd,
      supplyUsd: liabilitiesUsd,
      collateralizationRatio,
      details,
    },
  };
}

export async function fetchBridgeTransparencyReserves(
  _coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams("bridge-transparency", config.params);
  const input = requireJsonInputFromConfig(config, ADAPTER_KEY);
  const pathSegment = new URL(input.url).pathname.replace(/\/+$/, "").split("/").pop();
  if (pathSegment !== params.slug) {
    throw new Error(
      `${ADAPTER_KEY} configured URL slug "${pathSegment ?? ""}" does not match params.slug "${params.slug}"`,
    );
  }
  const payload = await fetchJsonAdapterInput<BridgeTransparencyPayload>(config, ADAPTER_KEY, signal, 12_000, ctx);
  return adaptBridgeTransparency(payload, params.slug);
}
