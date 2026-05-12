import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import { fetchChainlinkNavCore } from "./chainlink-nav-core";

export {
  adaptChainlinkNavResponse,
  parseOndoPriceData,
  type ChainlinkNavData,
  type ChainlinkNavParams,
} from "./chainlink-nav-core";

export async function fetchChainlinkNavReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  return fetchChainlinkNavCore(coin, config, signal, ctx);
}
