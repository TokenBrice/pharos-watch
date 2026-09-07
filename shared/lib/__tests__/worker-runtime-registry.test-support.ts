import type { StablecoinMeta } from "../../types";

/** Expected `coins.worker-runtime.generated.json` row for one full-registry coin. */
export function expectedWorkerRuntimeCoin(coin: StablecoinMeta) {
  return {
    id: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    pegCurrency: coin.flags.pegCurrency,
    governance: coin.flags.governance,
    ...(coin.geckoId != null ? { geckoId: coin.geckoId } : {}),
    ...(coin.flags.navToken === true ? { navToken: true } : {}),
    ...(coin.commodityOunces != null ? { commodityOunces: coin.commodityOunces } : {}),
    ...(coin.status != null ? { status: coin.status } : {}),
    ...(coin.contracts != null ? { contracts: coin.contracts } : {}),
    ...(coin.tradedContracts != null ? { tradedContracts: coin.tradedContracts } : {}),
    ...((coin.status == null || coin.status === "active") && coin.liveReservesConfig != null
      ? {
          liveReserveCircuitSource:
            `live-reserves:${coin.liveReservesConfig.breakerScope ?? coin.liveReservesConfig.adapter}`,
        }
      : {}),
  };
}
