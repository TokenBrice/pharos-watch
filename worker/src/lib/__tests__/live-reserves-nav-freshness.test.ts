import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { isReserveSnapshotStale } from "../live-reserves/store-snapshot-state";

const DAY = 86_400;
const now = 1_800_000_000;

// 2026-09-07 review: business-day NAVs and observed Midas oracle rounds,
// not the broader transport acceptance ceilings, set these scoring budgets.
describe("reviewed NAV source freshness", () => {
  it.each([
    ["usyc-hashnote", 4],
    ["mtbill-midas", 4],
    ["ousg-ondo-finance", 4],
    ["mf-one-midas", 4],
    ["mhyper-midas", 7],
    ["mmev-midas", 5],
    ["mapollo-midas", 4],
    ["iauon-ondo", 4],
  ] as const)("bounds source age without extending fetch liveness for %s", (id, days) => {
    const coin = ACTIVE_STABLECOINS.find((entry) => entry.id === id)!;
    const snapshot = {
      fetchedAt: now - 60,
      metadata: { freshnessMode: "verified" as const, sourceTimestamp: now - days * DAY },
    };
    expect(coin.liveReservesConfig?.scoring?.maxSourceAgeSec).toBe(days * DAY);
    expect(isReserveSnapshotStale(snapshot, coin, now, 2 * DAY)).toBe(false);
    expect(isReserveSnapshotStale(snapshot, coin, now + 1, 2 * DAY)).toBe(true);
    expect(isReserveSnapshotStale({ ...snapshot, fetchedAt: now - 2 * DAY - 1 }, coin, now, 2 * DAY)).toBe(true);
  });

  it("does not broaden an unreviewed NAV feed's default source budget", () => {
    const coin = ACTIVE_STABLECOINS.find((entry) => entry.id === "acrdx-anemoy-apollo")!;
    expect(isReserveSnapshotStale({
      fetchedAt: now - 60,
      metadata: { freshnessMode: "verified", sourceTimestamp: now - 2 * DAY - 1 },
    }, coin, now, 2 * DAY)).toBe(true);
  });
});
