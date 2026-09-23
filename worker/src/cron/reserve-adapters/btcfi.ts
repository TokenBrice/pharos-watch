import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildUnknownExposureWarning,
  computeUnknownExposurePct,
  fetchJsonWithRetry,
  notApplicableFreshnessMetadata,
  requireJsonInput,
  slicesFromValues,
} from "./helpers";

interface BtcfiMarketRow {
  token_handler_id: number;
  deposit_value?: string;
  borrow_value?: string;
}

interface BtcfiHandlerRow {
  id: number;
  symbol: string;
  isStable: boolean;
}

interface BtcfiParams {
  handlersUrl: string;
}

function readParams(config: LiveReservesConfig): BtcfiParams {
  return parseLiveReserveAdapterParams("btcfi", config.params);
}

const UNMAPPED_BTC_SLICE_NAME = "Unmapped BTC variants";

/**
 * Reviewed collateral identities for market rows whose `token_handler_id`
 * the supported-handler registry has not published yet — the market endpoint
 * can lead the registry. A pin is admitted only after verifying the
 * handler's Bifrost (3068) collateral token on-chain, and the registry row
 * always wins once it exists. Current pin:
 *
 * - 5 → "JPYC" (verified 2026-09-22): Bifrost's Unified JPYC ERC-20
 *   0x84122a4a75Bfe65eF455dBA5F6d43D61359ca77e returns symbol "JPYC" with
 *   18 decimals, its totalSupply matches the handler-5 market row's
 *   deposit_amount, and the row's token_price 0.00634833 is the JPYC/USD
 *   rate, not a BTC-variant price.
 *
 * Delete an entry here once `getAvailableBtcfiHandlers` publishes the id.
 */
const REVIEWED_HANDLER_SYMBOL_PINS: Readonly<Record<number, string>> = {
  5: "JPYC",
};

/**
 * Reviewed risk tiers for collateral symbols the canonical reserve-asset
 * taxonomy does not carry. Bifrost's "Unified" bridge representations stack
 * issuer custody on bridge custody, so JPYC collateral sits in the same
 * medium tier as the canonical wrapped-BTC handlers rather than the low
 * tier of a native fiat-cash claim.
 */
const REVIEWED_HANDLER_SYMBOL_RISK: Readonly<Record<string, ReserveSlice["risk"]>> = {
  JPYC: "medium",
};

export function adaptBtcfi(market: BtcfiMarketRow[], handlers: BtcfiHandlerRow[]): AdapterResult {
  const handlerMap = new Map(handlers.map((handler) => [handler.id, handler]));
  const symbolValues = new Map<string, { value: number; risk: ReserveSlice["risk"] }>();
  const unknownSymbols = new Set<string>();
  const unknownHandlerIds = new Set<number>();
  const pinnedHandlerIds = new Set<number>();
  let unknownValue = 0;
  let total = 0;

  for (const row of market) {
    const handler = handlerMap.get(row.token_handler_id);
    if (handler?.isStable) continue;
    const value = typeof row.deposit_value === "string" && row.deposit_value.trim()
      ? Number(row.deposit_value)
      : NaN;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`btcfi missing or invalid deposit_value for handler ${row.token_handler_id}`);
    }
    if (value === 0) continue;
    // The market endpoint can still lead the supported-handler registry:
    // reviewed pins attribute the row's collateral symbol, and any remaining
    // unattributed positive value stays in both the denominator and the
    // explicit unknown bucket so known shares are never overstated.
    const symbol = handler?.symbol ?? REVIEWED_HANDLER_SYMBOL_PINS[row.token_handler_id];
    if (!handler && symbol) pinnedHandlerIds.add(row.token_handler_id);
    if (!symbol) {
      unknownHandlerIds.add(row.token_handler_id);
      unknownValue += value;
      total += value;
      continue;
    }

    const normalized = symbol.trim().toUpperCase();
    const risk = getCanonicalReserveAssetRisk(normalized)
      ?? REVIEWED_HANDLER_SYMBOL_RISK[normalized]
      ?? null;
    total += value;

    if (risk == null) {
      unknownSymbols.add(symbol);
      unknownValue += value;
      continue;
    }

    const existing = symbolValues.get(normalized);
    if (existing) {
      existing.value += value;
    } else {
      symbolValues.set(normalized, { value, risk });
    }
  }

  if (total <= 0) return { slices: [] };

  const sliceInputs = Array.from(symbolValues.entries()).map(([symbol, { value, risk }]) => ({
    sourceKey: `btcfi:${symbol.toLowerCase()}`,
    name: symbol,
    value,
    risk,
  }));

  const unknownExposurePct = computeUnknownExposurePct(unknownValue, total);
  if (unknownValue > 0) {
    sliceInputs.push({
      sourceKey: "btcfi:unknown",
      name: UNMAPPED_BTC_SLICE_NAME,
      value: unknownValue,
      risk: "high",
    });
  }

  const slices = slicesFromValues(sliceInputs);

  // Registry lag on a small handler is informational by itself; the shared
  // material-unknown policy decides whether unattributed exposure degrades
  // the snapshot (same convention as sky-makercore's unknown modules).
  const warnings: LiveReserveWarning[] = unknownExposurePct > 0
    ? [
        ...Array.from(unknownSymbols, (symbol) => buildUnknownExposureWarning({
          code: "unknown-btc-wrapper",
          message: `btcfi handler bucketed into unmapped BTC variants: ${symbol}`,
          unknownExposurePct,
          adapterKey: "btcfi",
        })),
        ...Array.from(unknownHandlerIds, (handlerId) => buildUnknownExposureWarning({
          code: "unknown-handler",
          message: `btcfi market row references unknown handler id: ${handlerId}`,
          unknownExposurePct,
          adapterKey: "btcfi",
        })),
      ]
    : [];

  return {
    slices,
    metadata: {
      handlerCount: handlers.length,
      ...(unknownExposurePct > 0 ? { unknownExposurePct } : {}),
      ...notApplicableFreshnessMetadata({
        freshnessSource: "protocol-market-and-handler-apis",
        freshnessReason: "btcfi market and handler payloads represent latest-state protocol API aggregation",
        ...(pinnedHandlerIds.size > 0
          ? { pinnedHandlerIds: Array.from(pinnedHandlerIds).sort((a, b) => a - b) }
          : {}),
      }),
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function fetchBtcfiReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "btcfi");
  const params = readParams(config);
  const timeout = 12_000;
  const [market, handlers] = await Promise.all([
    fetchJsonWithRetry<BtcfiMarketRow[]>(input.url, signal, timeout, ctx),
    fetchJsonWithRetry<BtcfiHandlerRow[]>(params.handlersUrl, signal, timeout, ctx),
  ]);

  return adaptBtcfi(market, handlers);
}
