import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
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
  const params = (config.params ?? {}) as Partial<BtcfiParams>;
  if (!params.handlersUrl) {
    throw new Error("btcfi adapter requires params.handlersUrl");
  }
  return params as BtcfiParams;
}

export function adaptBtcfi(market: BtcfiMarketRow[], handlers: BtcfiHandlerRow[]): ReserveSlice[] {
  const handlerMap = new Map(handlers.map((handler) => [handler.id, handler]));
  const total = market.reduce((acc, row) => {
    const handler = handlerMap.get(row.token_handler_id);
    if (!handler || handler.isStable) return acc;
    const value = Number(row.deposit_value ?? "0");
    return Number.isFinite(value) && value > 0 ? acc + value : acc;
  }, 0);

  if (total <= 0) return [];

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
