import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  notApplicableFreshnessMetadata,
  requireJsonInput,
  reserveDegradedWarning,
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

export function adaptBtcfi(market: BtcfiMarketRow[], handlers: BtcfiHandlerRow[]): AdapterResult {
  const handlerMap = new Map(handlers.map((handler) => [handler.id, handler]));
  const symbolValues = new Map<string, { value: number; risk: ReserveSlice["risk"] }>();
  const unknownSymbols = new Set<string>();
  const unknownHandlerIds = new Set<number>();
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
    // The market endpoint can lead the supported-handler registry (handler 5
    // in the September 2026 payload). Keep that positive collateral in both
    // the denominator and the explicit unknown bucket until the source
    // publishes a handler identity; dropping it would overstate known shares.
    if (!handler) {
      unknownHandlerIds.add(row.token_handler_id);
      unknownValue += value;
      total += value;
      continue;
    }

    const normalized = handler.symbol.trim().toUpperCase();
    const canonicalRisk = getCanonicalReserveAssetRisk(normalized);
    total += value;

    if (canonicalRisk == null) {
      unknownSymbols.add(handler.symbol);
      unknownValue += value;
      continue;
    }

    const existing = symbolValues.get(normalized);
    if (existing) {
      existing.value += value;
    } else {
      symbolValues.set(normalized, { value, risk: canonicalRisk });
    }
  }

  if (total <= 0) return { slices: [] };

  const sliceInputs = Array.from(symbolValues.entries()).map(([symbol, { value, risk }]) => ({
    sourceKey: `btcfi:${symbol.toLowerCase()}`,
    name: symbol,
    value,
    risk,
  }));

  if (unknownValue > 0) {
    sliceInputs.push({
      sourceKey: "btcfi:unknown",
      name: UNMAPPED_BTC_SLICE_NAME,
      value: unknownValue,
      risk: "high",
    });
  }

  const slices = slicesFromValues(sliceInputs);

  const warnings: LiveReserveWarning[] = Array.from(unknownSymbols).map((symbol) => reserveDegradedWarning(
    "unknown-btc-wrapper",
    `btcfi handler bucketed into unmapped BTC variants: ${symbol}`,
  ));
  warnings.push(...Array.from(unknownHandlerIds).map((handlerId) => reserveDegradedWarning(
    "unknown-handler",
    `btcfi market row references unknown handler id: ${handlerId}`,
  )));

  return {
    slices,
    metadata: {
      handlerCount: handlers.length,
      ...(unknownValue > 0 ? { unknownExposurePct: (unknownValue / total) * 100 } : {}),
      ...notApplicableFreshnessMetadata({
        freshnessSource: "protocol-market-and-handler-apis",
        freshnessReason: "btcfi market and handler payloads represent latest-state protocol API aggregation",
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
