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

  it("uses server warnings as a degradation floor", () => {
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
    expect(health.state).toBe("degraded");
  });

  it("classifies producer updatedAt instead of backend status or browser fetch time", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const health = deriveDataHealth({
      label: "Depeg Events",
      dataUpdatedAt: now - 30_000,
      staleTime: 15 * 60_000,
      hasData: true,
      meta: {
        updatedAt: Math.floor((now - 5 * 60 * 60_000) / 1000),
        ageSeconds: 18000,
        status: "fresh",
      },
    });
    expect(health.state).toBe("stale");
    expect(health.ageMs).toBeGreaterThanOrEqual(18_000_000);
    expect(health.dataUpdatedAt).toBe((Math.floor((now - 5 * 60 * 60_000) / 1000)) * 1000);
  });

  it("does not use backend freshness status as a second clock", () => {
    const now = Date.parse("2026-08-29T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);

    const health = deriveDataHealth({
      label: "Prices",
      dataUpdatedAt: now,
      staleTime: 15 * 60_000,
      hasData: true,
      meta: {
        updatedAt: (now - 60_000) / 1000,
        ageSeconds: 13 * 15 * 60,
        status: "stale",
      },
    });

    expect(health.state).toBe("fresh");
    expect(health.ageMs).toBe(60_000);
  });

  it("reclassifies hydrated data as time passes without a refetch", () => {
    const now = Date.parse("2026-08-29T12:00:00.000Z");
    const updatedAt = now - 8 * 15 * 60_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const input = {
      label: "Prices",
      dataUpdatedAt: now,
      staleTime: 15 * 60_000,
      hasData: true,
      meta: {
        updatedAt: updatedAt / 1000,
        ageSeconds: 0,
        status: "fresh" as const,
      },
    };

    expect(deriveDataHealth(input).state).toBe("fresh");
    nowSpy.mockReturnValue(now + 1);
    expect(deriveDataHealth(input).state).toBe("degraded");
  });

  it("uses exact fresh, degraded, and stale threshold boundaries", () => {
    const now = Date.parse("2026-08-29T12:00:00.000Z");
    const staleTime = 15 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const stateAtAge = (ageMs: number) => deriveDataHealth({
      label: "Prices",
      dataUpdatedAt: now - ageMs,
      staleTime,
      hasData: true,
    }).state;

    expect(stateAtAge(8 * staleTime)).toBe("fresh");
    expect(stateAtAge(8 * staleTime + 1)).toBe("degraded");
    expect(stateAtAge(12 * staleTime)).toBe("degraded");
    expect(stateAtAge(12 * staleTime + 1)).toBe("stale");
  });

  it("clamps slight producer clock skew to zero age", () => {
    const now = Date.parse("2026-08-29T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);

    const health = deriveDataHealth({
      label: "Chains",
      dataUpdatedAt: now,
      staleTime: 15 * 60_000,
      hasData: true,
      meta: {
        updatedAt: (now + 5_000) / 1000,
        ageSeconds: 0,
        status: "fresh",
      },
    });

    expect(health.state).toBe("fresh");
    expect(health.ageMs).toBe(0);
  });

  it("uses a degraded dependency as a floor without overriding stale producer age", () => {
    const now = Date.parse("2026-08-29T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const buildHealth = (ageMs: number) => deriveDataHealth({
      label: "Chains",
      dataUpdatedAt: now,
      staleTime: 15 * 60_000,
      hasData: true,
      meta: {
        updatedAt: (now - ageMs) / 1000,
        ageSeconds: 0,
        status: "fresh" as const,
        dependencies: {
          reportCards: { status: "stale" as const, ageSeconds: 0 },
        },
      },
    });

    expect(buildHealth(60_000).state).toBe("degraded");
    expect(buildHealth(13 * 15 * 60_000).state).toBe("stale");
  });

  it("preserves warning-only degraded state without inventing an age", () => {
    const health = deriveDataHealth({
      label: "Daily Digest",
      dataUpdatedAt: 0,
      staleTime: 24 * 60 * 60_000,
      hasData: true,
      meta: {
        status: "degraded",
        warning: '110 - "Response is degraded"',
      },
    });

    expect(health).toMatchObject({
      state: "degraded",
      dataUpdatedAt: 0,
      ageMs: null,
      meta: {
        status: "degraded",
        warning: '110 - "Response is degraded"',
      },
    });
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
