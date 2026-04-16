import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  requireJsonInput,
  reserveDegradedWarning,
  slicesFromValues,
  unverifiedFreshnessMetadata,
} from "./helpers";

interface BtcfiMarketRow {
  token_handler_id: number;
  deposit_value?: string;
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
  let unknownValue = 0;
  let total = 0;

  for (const row of market) {
    const handler = handlerMap.get(row.token_handler_id);
    if (!handler || handler.isStable) continue;
    const value = Number(row.deposit_value ?? "0");
    if (!Number.isFinite(value) || value <= 0) continue;

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
    name: symbol,
    value,
    risk,
  }));

  if (unknownValue > 0) {
    sliceInputs.push({
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

  return {
    slices,
    metadata: {
      handlerCount: handlers.length,
      ...(unknownValue > 0 ? { unknownExposurePct: (unknownValue / total) * 100 } : {}),
      ...unverifiedFreshnessMetadata(
        "protocol-market-and-handler-apis",
        "btcfi market and handler payloads do not expose a trustworthy source timestamp",
      ),
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
