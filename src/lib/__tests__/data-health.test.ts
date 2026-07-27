import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiFetchError } from "@/lib/api";
import { deriveDataHealth, mergeHealthStates } from "@/lib/data-health";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deriveDataHealth", () => {
  it("returns fresh when age is within staleTime", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const health = deriveDataHealth({
      label: "Prices",
      dataUpdatedAt: now - 5 * 60_000,
      staleTime: 15 * 60_000,
      hasData: true,
    });
    expect(health.state).toBe("fresh");
  });

  it("returns fresh when age is well within the FRESH ratio (8x)", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const health = deriveDataHealth({
      label: "Liquidity",
      dataUpdatedAt: now - 50 * 60_000,
      staleTime: 30 * 60_000,
      hasData: true,
    });
    expect(health.state).toBe("fresh");
  });

  it("returns degraded when age is between 8x and 12x staleTime", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const health = deriveDataHealth({
      label: "Liquidity",
      dataUpdatedAt: now - 300 * 60_000,
      staleTime: 30 * 60_000,
      hasData: true,
    });
    expect(health.state).toBe("degraded");
  });

  it("returns stale when age exceeds 12x staleTime", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const health = deriveDataHealth({
      label: "Report Cards",
      dataUpdatedAt: now - 400 * 60_000,
      staleTime: 30 * 60_000,
      hasData: true,
    });
    expect(health.state).toBe("stale");
  });

  it("trusts backend status over warning header when status is fresh", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const health = deriveDataHealth({
      label: "Prices",
      dataUpdatedAt: now - 2 * 60_000,
      staleTime: 15 * 60_000,
      hasData: true,
      meta: {
        updatedAt: Math.floor((now - 2 * 60_000) / 1000),
        ageSeconds: 120,
        status: "fresh",
        warning: '110 - "Response is stale"',
      },
    });
    expect(health.state).toBe("fresh");
  });

  it("prefers backend freshness metadata over a fresh browser fetch timestamp", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const health = deriveDataHealth({
      label: "Depeg Events",
      dataUpdatedAt: now - 30_000,
      staleTime: 15 * 60_000,
      hasData: true,
      meta: {
        updatedAt: Math.floor((now - 2 * 60 * 60_000) / 1000),
        ageSeconds: 7200,
        status: "stale",
      },
    });
    expect(health.state).toBe("stale");
    expect(health.ageMs).toBe(7_200_000);
    expect(health.dataUpdatedAt).toBe((Math.floor((now - 2 * 60 * 60_000) / 1000)) * 1000);
  });

  it("returns unavailable on 503 error with no data", () => {
    const health = deriveDataHealth({
      label: "Digests",
      dataUpdatedAt: 0,
      staleTime: 24 * 60 * 60_000,
      error: new ApiFetchError("/api/digest-archive", 503, null),
      hasData: false,
    });
    expect(health.state).toBe("unavailable");
  });

  it("returns error on non-503 error with no data", () => {
    const health = deriveDataHealth({
      label: "Prices",
      dataUpdatedAt: 0,
      staleTime: 15 * 60_000,
      error: new ApiFetchError("/api/stablecoins", 500, null),
      hasData: false,
    });
    expect(health.state).toBe("error");
  });

  it("keeps page usable as degraded when refresh fails but existing data is present", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const health = deriveDataHealth({
      label: "Prices",
      dataUpdatedAt: now - 2 * 60_000,
      staleTime: 15 * 60_000,
      error: new Error("network"),
      hasData: true,
    });
    expect(health.state).toBe("degraded");
  });

  it("surfaces a refresh failure while preserving backend-fresh cached data", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const updatedAtMs = now - 2 * 60_000;
    const health = deriveDataHealth({
      label: "Mint/Burn Flows",
      dataUpdatedAt: updatedAtMs,
      staleTime: 60 * 60_000,
      error: new Error("network"),
      hasData: true,
      meta: {
        updatedAt: Math.floor(updatedAtMs / 1000),
        ageSeconds: 120,
        status: "fresh",
      },
    });
    expect(health.state).toBe("degraded");
    expect(health.message).toBe("Using last successful data while refresh retries.");
    expect(health.dataUpdatedAt).toBe(Math.floor(updatedAtMs / 1000) * 1000);
  });

  it("treats empty successful responses as available when the caller marks hasData true", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const health = deriveDataHealth({
      label: "Depeg Events",
      dataUpdatedAt: now - 30_000,
      staleTime: 15 * 60_000,
      hasData: true,
    });
    expect(health.state).toBe("fresh");
  });
});

describe("mergeHealthStates", () => {
  it("picks highest-priority state and aggregates labels", () => {
    const merged = mergeHealthStates([
      {
        label: "Prices",
        state: "fresh",
        message: "",
        dataUpdatedAt: 10,
        ageMs: 0,
        staleTime: 1,
        meta: null,
      },
      {
        label: "Liquidity",
        state: "stale",
        message: "",
        dataUpdatedAt: 9,
        ageMs: 10,
        staleTime: 1,
        meta: null,
      },
      {
        label: "Report Cards",
        state: "degraded",
        message: "",
        dataUpdatedAt: 8,
        ageMs: 5,
        staleTime: 1,
        meta: null,
      },
    ]);

    expect(merged.state).toBe("stale");
    expect(merged.affectedLabels).toEqual(["Liquidity", "Report Cards"]);
    expect(merged.latestUpdatedAt).toBe(9);
  });

  it("does not label a stale dataset with a fresher healthy dataset timestamp", () => {
    const reportCardsUpdatedAt = new Date("2026-07-27T14:46:53+02:00").getTime();
    const pricesUpdatedAt = new Date("2026-07-27T19:45:13+02:00").getTime();

    const merged = mergeHealthStates([
      {
        label: "Report Cards",
        state: "stale",
        message: "",
        dataUpdatedAt: reportCardsUpdatedAt,
        ageMs: 5 * 60 * 60_000,
        staleTime: 15 * 60_000,
        meta: null,
      },
      {
        label: "Prices",
        state: "fresh",
        message: "",
        dataUpdatedAt: pricesUpdatedAt,
        ageMs: 13 * 60_000,
        staleTime: 15 * 60_000,
        meta: null,
      },
    ]);

    expect(merged.state).toBe("stale");
    expect(merged.affectedLabels).toEqual(["Report Cards"]);
    expect(merged.latestUpdatedAt).toBe(reportCardsUpdatedAt);
  });
});
