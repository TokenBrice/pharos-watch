import { describe, expect, it } from "vitest";
import {
  ACTIVE_IDS,
  ACTIVE_META_BY_ID,
  ACTIVE_STABLECOINS,
  FROZEN_IDS,
  PRE_LAUNCH_STABLECOINS,
  READABLE_IDS,
  TRACKED_STABLECOINS,
} from "../stablecoins/registry";
import {
  WORKER_ACTIVE_IDS,
  WORKER_ACTIVE_LIVE_RESERVE_CIRCUIT_SOURCES,
  WORKER_ACTIVE_META_BY_ID,
  WORKER_FROZEN_IDS,
  WORKER_PRE_LAUNCH_STABLECOINS,
  WORKER_READABLE_IDS,
  WORKER_TRACKED_META_BY_ID,
} from "../stablecoins/worker-runtime-registry";

describe("Worker runtime stablecoin registry", () => {
  it("preserves every configured feed's complete reserve adapter inputs", () => {
    for (const coin of TRACKED_STABLECOINS) {
      const projected = WORKER_TRACKED_META_BY_ID.get(coin.id);
      expect(projected, coin.id).toBeDefined();
      expect(projected?.liveReservesConfig, coin.id).toEqual(coin.liveReservesConfig);
      // Underlying assets without a live feed still participate in branch peg checks.
      expect(projected?.flags.yieldBearing, coin.id).toEqual(coin.flags.yieldBearing);
      if (!coin.liveReservesConfig) continue;
      for (const field of ["flags", "reserves", "reserveReview"] as const) {
        expect(projected?.[field], `${coin.id}.${field}`).toEqual(coin[field]);
      }
    }
  });

  it("preserves replay-sidecar identity, dependency, peg-history, and documentation inputs", () => {
    expect([...WORKER_TRACKED_META_BY_ID.keys()]).toEqual(TRACKED_STABLECOINS.map((coin) => coin.id));
    for (const coin of TRACKED_STABLECOINS) {
      const projected = WORKER_TRACKED_META_BY_ID.get(coin.id)!;
      for (const field of ["id", "name", "symbol", "geckoId", "variantOf", "pegReferenceId", "protocolSlug", "launchDate"] as const) {
        expect(projected[field], `${coin.id}.${field}`).toEqual(coin[field]);
      }
      expect(projected.pegScoreCoverage?.startDate, coin.id).toEqual(coin.pegScoreCoverage?.startDate);
      expect(projected.proofOfReserves, coin.id).toEqual(coin.proofOfReserves ? {
        url: coin.proofOfReserves.url, provider: coin.proofOfReserves.provider,
      } : undefined);
      expect(projected.links, coin.id).toEqual(coin.links
        ?.filter(({ label }) => ["Docs", "Proof of Reserve", "Transparency", "Website"].includes(label))
        .map(({ label, url }) => ({ label, url })));
      expect(projected.reserves?.map(({ pct, risk, coinId }) => ({ pct, risk, coinId })), coin.id).toEqual(
        coin.reserves?.map(({ pct, risk, coinId }) => ({ pct, risk, coinId })),
      );
      expect(projected.dependencies, coin.id).toEqual(
        coin.dependencies?.map(({ id, weight }) => ({ id, weight })),
      );
      expect(projected.contracts, coin.id).toEqual(coin.contracts?.map(({ kind, chain, address, decimals, amountEncoding }) => ({
        ...(kind != null ? { kind } : {}), chain, address, decimals,
        ...(amountEncoding != null ? { amountEncoding } : {}),
      })));
    }
  });

  it("preserves active, pre-launch, frozen, readable, and live-reserve circuit membership", () => {
    expect(WORKER_ACTIVE_IDS).toEqual(ACTIVE_IDS);
    expect([...WORKER_ACTIVE_META_BY_ID.keys()]).toEqual([...ACTIVE_META_BY_ID.keys()]);
    expect(WORKER_PRE_LAUNCH_STABLECOINS.map((coin) => coin.id)).toEqual(
      PRE_LAUNCH_STABLECOINS.map((coin) => coin.id),
    );
    expect(WORKER_FROZEN_IDS).toEqual(FROZEN_IDS);
    expect(WORKER_READABLE_IDS).toEqual(READABLE_IDS);
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
