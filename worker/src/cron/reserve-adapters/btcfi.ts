import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  requireJsonInput,
  reserveDegradedWarning,
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

export function adaptBtcfi(market: BtcfiMarketRow[], handlers: BtcfiHandlerRow[]): AdapterResult {
  const handlerMap = new Map(handlers.map((handler) => [handler.id, handler]));
  const btcSymbols = new Set(["BTC", "WBTC", "BTCB", "CBBTC", "SOLVBTC", "LBTC", "TBTC"]);
  const unexpectedSymbols = new Set<string>();
  let unexpectedValue = 0;

  const total = market.reduce((acc, row) => {
    const handler = handlerMap.get(row.token_handler_id);
    if (!handler || handler.isStable) return acc;
    const value = Number(row.deposit_value ?? "0");
    if (!Number.isFinite(value) || value <= 0) return acc;
    if (!btcSymbols.has(handler.symbol.toUpperCase())) {
      unexpectedSymbols.add(handler.symbol);
      unexpectedValue += value;
      return acc + value;
    }
    return acc + value;
  }, 0);

  if (total <= 0) return { slices: [] };

  const mappedPct = ((total - unexpectedValue) / total) * 100;
  const slices: ReserveSlice[] = [];
  if (mappedPct > 0) {
    slices.push({
      name: "BTC / WBTC / BTCB / cbBTC",
      pct: mappedPct,
      risk: "medium",
    });
  }
  if (unexpectedValue > 0) {
    slices.push({
      name: "Other BTC wrappers / unmapped handlers",
      pct: (unexpectedValue / total) * 100,
      risk: "high",
    });
  }

  const warnings: LiveReserveWarning[] = Array.from(unexpectedSymbols).map((symbol) => reserveDegradedWarning(
    "unknown-btc-wrapper",
    `btcfi handler bucketed into other BTC wrappers: ${symbol}`,
  ));

  return {
    slices,
    metadata: {
      handlerCount: handlers.length,
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
