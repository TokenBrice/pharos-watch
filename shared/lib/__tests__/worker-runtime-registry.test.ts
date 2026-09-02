import { describe, expect, it } from "vitest";
import {
  ACTIVE_IDS,
  ACTIVE_META_BY_ID,
  ACTIVE_STABLECOINS,
  FROZEN_IDS,
  PRE_LAUNCH_STABLECOINS,
  TRACKED_STABLECOINS,
} from "../stablecoins/registry";
import {
  WORKER_ACTIVE_IDS,
  WORKER_ACTIVE_LIVE_RESERVE_CIRCUIT_SOURCES,
  WORKER_ACTIVE_META_BY_ID,
  WORKER_FROZEN_IDS,
  WORKER_PRE_LAUNCH_STABLECOINS,
  WORKER_TRACKED_STABLECOINS,
} from "../stablecoins/worker-runtime-registry";

describe("Worker runtime stablecoin registry", () => {
  it("preserves the canonical contract identity projection", () => {
    expect(WORKER_TRACKED_STABLECOINS).toEqual(
      TRACKED_STABLECOINS.map((coin) => ({
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        pegCurrency: coin.flags.pegCurrency,
        ...(coin.status != null ? { status: coin.status } : {}),
        ...(coin.contracts != null ? { contracts: coin.contracts } : {}),
        ...(coin.tradedContracts != null ? { tradedContracts: coin.tradedContracts } : {}),
        ...((coin.status == null || coin.status === "active") && coin.liveReservesConfig != null
          ? {
              liveReserveCircuitSource:
                `live-reserves:${coin.liveReservesConfig.breakerScope ?? coin.liveReservesConfig.adapter}`,
            }
          : {}),
      })),
    );
  });

  it("preserves active, pre-launch, frozen, and live-reserve circuit membership", () => {
    expect(WORKER_ACTIVE_IDS).toEqual(ACTIVE_IDS);
    expect([...WORKER_ACTIVE_META_BY_ID.keys()]).toEqual([...ACTIVE_META_BY_ID.keys()]);
    expect(WORKER_PRE_LAUNCH_STABLECOINS.map((coin) => coin.id)).toEqual(
      PRE_LAUNCH_STABLECOINS.map((coin) => coin.id),
    );
    expect(WORKER_FROZEN_IDS).toEqual(FROZEN_IDS);
    expect(new Set(WORKER_ACTIVE_LIVE_RESERVE_CIRCUIT_SOURCES)).toEqual(
      new Set(
        ACTIVE_STABLECOINS
          .map((coin) => coin.liveReservesConfig)
          .filter((config): config is NonNullable<(typeof ACTIVE_STABLECOINS)[number]["liveReservesConfig"]> =>
            config != null,
          )
          .map((config) => `live-reserves:${config.breakerScope ?? config.adapter}`),
      ),
    );
  });
});
