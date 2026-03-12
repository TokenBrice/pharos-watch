import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";

const getReserveAdapterMock = vi.fn();
const shouldAttemptFetchMock = vi.fn();
const recordOutcomeSafeMock = vi.fn();

vi.mock("../reserve-adapters/index", () => ({
  getReserveAdapter: getReserveAdapterMock,
}));

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: shouldAttemptFetchMock,
  recordOutcomeSafe: recordOutcomeSafeMock,
}));

describe("syncLiveReserves", () => {
  const configuredCoinCount = TRACKED_STABLECOINS.filter((coin) => coin.liveReservesConfig).length;
  const sharedSourceInvocationCount = TRACKED_STABLECOINS
    .filter((coin) => coin.liveReservesConfig)
    .reduce((keys, coin) => {
      const config = coin.liveReservesConfig!;
      const primary = config.inputs.primary;
      if (primary.kind !== "http-json" && primary.kind !== "http-html") {
        keys.add(`coin:${coin.id}`);
        return keys;
      }

      keys.add(JSON.stringify({
        adapter: config.adapter,
        version: config.version,
        semantics: config.semantics,
        inputs: {
          primary,
          fallbacks: config.inputs.fallbacks ?? null,
        },
        params: config.params ?? null,
      }));
      return keys;
    }, new Set<string>())
    .size;

  beforeEach(() => {
    vi.clearAllMocks();
    shouldAttemptFetchMock.mockResolvedValue(true);
    recordOutcomeSafeMock.mockResolvedValue(undefined);
  });

  it("persists reserve snapshot + sync state and returns ok on a clean run", async () => {
    getReserveAdapterMock.mockReturnValue(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});

    expect(result?.status).toBe("ok");
    expect(result?.itemCount).toBe(configuredCoinCount);
    expect(db.getHistory().some((entry) => entry.sql.includes("reserve_composition"))).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("reserve_sync_state"))).toBe(true);
    expect(recordOutcomeSafeMock).toHaveBeenCalledWith(db, "live-reserves:infinifi", true);
    expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(configuredCoinCount);
  });

  it("reuses identical shared HTTP reserve sources within a run", async () => {
    const adapterFn = vi.fn(async () => ({
      slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
    }));
    getReserveAdapterMock.mockReturnValue(adapterFn);

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    await syncLiveReserves(db, new AbortController().signal, {});

    expect(adapterFn).toHaveBeenCalledTimes(sharedSourceInvocationCount);
    expect(sharedSourceInvocationCount).toBeLessThan(configuredCoinCount);
  });

  it("returns degraded when the adapter yields warning metadata", async () => {
    getReserveAdapterMock.mockReturnValue(
      async () => ({
        slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
        warnings: [{ code: "unknown-position", message: "Unmapped reserve position: new-farm", severity: "warning" as const }],
      }),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});

    expect(result?.status).toBe("degraded");
    expect(result?.metadata).toContain(`"warningCount":${configuredCoinCount}`);
  });

  it("records a skipped sync state when the circuit is open", async () => {
    shouldAttemptFetchMock.mockResolvedValue(false);
    getReserveAdapterMock.mockReturnValue(async () => {
      throw new Error("adapter should not run when circuit is open");
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});

    expect(result?.status).toBe("error");
    expect(result?.itemCount).toBe(0);
    expect(db.getHistory().some((entry) => entry.sql.includes("reserve_sync_state"))).toBe(true);
    expect(recordOutcomeSafeMock).not.toHaveBeenCalled();
  });
});
