import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterResult } from "./types";
import { fetchJsonWithRetry, getAdapterTimeout, requireJsonInput } from "./helpers";

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

export function adaptBtcfi(market: BtcfiMarketRow[], handlers: BtcfiHandlerRow[]): ReserveSlice[] {
  const handlerMap = new Map(handlers.map((handler) => [handler.id, handler]));
  const btcSymbols = new Set(["BTC", "WBTC", "BTCB", "CBBTC", "SOLVBTC", "LBTC", "TBTC"]);
  const unexpectedSymbols = new Set<string>();

  const total = market.reduce((acc, row) => {
    const handler = handlerMap.get(row.token_handler_id);
    if (!handler || handler.isStable) return acc;
    const value = Number(row.deposit_value ?? "0");
    if (!Number.isFinite(value) || value <= 0) return acc;
    if (!btcSymbols.has(handler.symbol.toUpperCase())) {
      unexpectedSymbols.add(handler.symbol);
      return acc;
    }
    return acc + value;
  }, 0);

  if (total <= 0) return [];
  if (unexpectedSymbols.size > 0) {
    throw new Error(`btcfi adapter found non-BTC handler(s): ${Array.from(unexpectedSymbols).join(", ")}`);
  }

  return [{ name: "BTC / WBTC / BTCB / cbBTC", pct: 100, risk: "medium" }];
}

export async function fetchBtcfiReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "btcfi");
  const params = readParams(config);
  const timeout = getAdapterTimeout(config, 12_000);
  const [market, handlers] = await Promise.all([
    fetchJsonWithRetry<BtcfiMarketRow[]>(input.url, signal, timeout),
    fetchJsonWithRetry<BtcfiHandlerRow[]>(params.handlersUrl, signal, timeout),
  ]);

  return {
    slices: adaptBtcfi(market, handlers),
  };
}
