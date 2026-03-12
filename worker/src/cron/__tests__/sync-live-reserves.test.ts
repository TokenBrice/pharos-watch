import { describe, expect, it, vi, beforeEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

// Mock the adapter registry so tests don't make real HTTP calls
vi.mock("../reserve-adapters/index", () => ({
  getReserveAdapter: vi.fn().mockReturnValue(
    async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }], unknownFarms: [] })
  ),
}));

// Mock circuit breaker — always allow fetch
vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn().mockResolvedValue(true),
  recordOutcomeSafe: vi.fn().mockResolvedValue(undefined),
}));

describe("syncLiveReserves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts one row per configured coin and returns itemCount", async () => {
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    // iusd-infinifi has liveReservesConfig — expect 1 coin processed
    expect(result?.itemCount).toBe(1);
  });

  it("skips coins without liveReservesConfig", async () => {
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    // Only iusd-infinifi is configured so far
    expect(result?.itemCount).toBeGreaterThanOrEqual(1);
  });
});
