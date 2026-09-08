import { describe, expect, it } from "vitest";
import type { ApiMeta } from "@/lib/api";
import { ApiFetchError } from "@/lib/api";
import { deriveDataHealth, mergeHealthStates, type DataHealthInfo } from "@/lib/data-health";

const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const STALE_TIME = 15 * 60_000;

function healthEntry(overrides: Partial<DataHealthInfo> = {}): DataHealthInfo {
  return {
    label: "Prices",
    state: "fresh",
    message: "",
    dataUpdatedAt: NOW,
    ageMs: 0,
    staleTime: STALE_TIME,
    meta: null,
    ...overrides,
  };
}

function meta(overrides: Partial<ApiMeta> = {}): ApiMeta {
  return {
    updatedAt: Math.floor(NOW / 1000),
    ageSeconds: 0,
    status: "fresh",
    ...overrides,
  } as ApiMeta;
}

describe("deriveDataHealth", () => {
  it("uses exact fresh, degraded, and stale threshold boundaries", () => {
    const stateAtAge = (ageMs: number) =>
      deriveDataHealth(
        {
          label: "Prices",
          dataUpdatedAt: NOW - ageMs,
          staleTime: STALE_TIME,
          hasData: true,
        },
        NOW,
      ).state;

    expect(stateAtAge(0)).toBe("fresh");
    expect(stateAtAge(8 * STALE_TIME)).toBe("fresh");
    expect(stateAtAge(8 * STALE_TIME + 1)).toBe("degraded");
    expect(stateAtAge(12 * STALE_TIME)).toBe("degraded");
    expect(stateAtAge(12 * STALE_TIME + 1)).toBe("stale");
  });

  it("uses server warnings as a degradation floor", () => {
    const health = deriveDataHealth(
      {
        label: "Prices",
        dataUpdatedAt: NOW - 2 * 60_000,
        staleTime: STALE_TIME,
        hasData: true,
        meta: meta({
          updatedAt: Math.floor((NOW - 2 * 60_000) / 1000),
          ageSeconds: 120,
          warning: '110 - "Response is stale"',
        }),
      },
      NOW,
    );

    expect(health.state).toBe("degraded");
  });

  it("distinguishes age, source, and refresh degradation reasons", () => {
    const degradedByAge = deriveDataHealth(
      { label: "Prices", dataUpdatedAt: NOW - 9 * STALE_TIME, staleTime: STALE_TIME, hasData: true },
      NOW,
    );
    const degradedByCacheWarning = deriveDataHealth(
      {
        label: "Prices",
        dataUpdatedAt: NOW,
        staleTime: STALE_TIME,
        hasData: true,
        meta: meta({ warning: '110 - "Response is stale"' }),
      },
      NOW,
    );
    const degradedBySource = deriveDataHealth(
      {
        label: "Prices",
        dataUpdatedAt: NOW,
        staleTime: STALE_TIME,
        hasData: true,
        meta: meta({ warning: "upstream provider incomplete" }),
      },
      NOW,
    );
    const degradedByDependency = deriveDataHealth(
      {
        label: "Prices",
        dataUpdatedAt: NOW,
        staleTime: STALE_TIME,
        hasData: true,
        meta: meta({ dependencies: { reportCards: { status: "degraded", ageSeconds: 0 } } }),
      },
      NOW,
    );
    const degradedByAgeAndDependency = deriveDataHealth(
      {
        label: "Prices",
        dataUpdatedAt: NOW - 9 * STALE_TIME,
        staleTime: STALE_TIME,
        hasData: true,
        meta: meta({
          updatedAt: Math.floor((NOW - 9 * STALE_TIME) / 1000),
          dependencies: { reportCards: { status: "degraded", ageSeconds: 0 } },
        }),
      },
      NOW,
    );
    const failedRefresh = deriveDataHealth(
      {
        label: "Prices",
        dataUpdatedAt: NOW,
        staleTime: STALE_TIME,
        hasData: true,
        error: new Error("network"),
      },
      NOW,
    );

    expect(degradedByAge.degradationReason).toBe("age");
    expect(degradedByCacheWarning.degradationReason).toBe("age");
    expect(degradedBySource.degradationReason).toBe("source");
    expect(degradedByDependency.degradationReason).toBe("source");
    expect(degradedByAgeAndDependency.degradationReason).toBe("age");
    expect(failedRefresh.degradationReason).toBe("refresh");
  });

  it("leaves a fresh state without a degradation reason", () => {
    const health = deriveDataHealth(
      { label: "Prices", dataUpdatedAt: NOW, staleTime: STALE_TIME, hasData: true },
      NOW,
    );

    expect(health.state).toBe("fresh");
    expect(health.degradationReason).toBeUndefined();
  });

  it("classifies producer updatedAt instead of backend status or browser fetch time", () => {
    const producerUpdatedAtSec = Math.floor((NOW - 5 * 60 * 60_000) / 1000);
    const health = deriveDataHealth(
      {
        label: "Depeg Events",
        dataUpdatedAt: NOW - 30_000,
        staleTime: STALE_TIME,
        hasData: true,
        meta: meta({ updatedAt: producerUpdatedAtSec, ageSeconds: 18_000 }),
      },
      NOW,
    );

    expect(health.state).toBe("stale");
    expect(health.ageMs).toBe(NOW - producerUpdatedAtSec * 1000);
    expect(health.dataUpdatedAt).toBe(producerUpdatedAtSec * 1000);
  });

  it("does not use backend freshness status as a second clock", () => {
    const health = deriveDataHealth(
      {
        label: "Prices",
        dataUpdatedAt: NOW,
        staleTime: STALE_TIME,
        hasData: true,
        meta: meta({ updatedAt: (NOW - 60_000) / 1000, ageSeconds: 13 * 15 * 60, status: "stale" }),
      },
      NOW,
    );

    expect(health.state).toBe("fresh");
    expect(health.ageMs).toBe(60_000);
  });

  it("reclassifies hydrated data as time passes without a refetch", () => {
    const updatedAt = NOW - 8 * STALE_TIME;
    const input = {
      label: "Prices",
      dataUpdatedAt: NOW,
      staleTime: STALE_TIME,
      hasData: true,
      meta: meta({ updatedAt: updatedAt / 1000 }),
    };

    expect(deriveDataHealth(input, NOW).state).toBe("fresh");
    expect(deriveDataHealth(input, NOW + 1).state).toBe("degraded");
  });

  it("clamps slight producer clock skew to zero age", () => {
    const health = deriveDataHealth(
      {
        label: "Chains",
        dataUpdatedAt: NOW,
        staleTime: STALE_TIME,
        hasData: true,
        meta: meta({ updatedAt: (NOW + 5_000) / 1000 }),
      },
      NOW,
    );

    expect(health.state).toBe("fresh");
    expect(health.ageMs).toBe(0);
  });

  it("uses a degraded dependency as a floor without overriding stale producer age", () => {
    const buildHealth = (ageMs: number) =>
      deriveDataHealth(
        {
          label: "Chains",
          dataUpdatedAt: NOW,
          staleTime: STALE_TIME,
          hasData: true,
          meta: meta({
            updatedAt: (NOW - ageMs) / 1000,
            dependencies: { reportCards: { status: "stale", ageSeconds: 0 } },
          }),
        },
        NOW,
      );

    expect(buildHealth(60_000).state).toBe("degraded");
    expect(buildHealth(13 * STALE_TIME).state).toBe("stale");
  });

  it("preserves warning-only degraded state without inventing an age", () => {
    const health = deriveDataHealth(
      {
        label: "Daily Digest",
        dataUpdatedAt: 0,
        staleTime: 24 * 60 * 60_000,
        hasData: true,
        meta: { status: "degraded", warning: '110 - "Response is degraded"' } as ApiMeta,
      },
      NOW,
    );

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
    const health = deriveDataHealth(
      {
        label: "Digests",
        dataUpdatedAt: 0,
        staleTime: 24 * 60 * 60_000,
        error: new ApiFetchError("/api/digest-archive", 503, null),
        hasData: false,
      },
      NOW,
    );

    expect(health.state).toBe("unavailable");
  });

  it("returns error on non-503 error with no data", () => {
    const health = deriveDataHealth(
      {
        label: "Prices",
        dataUpdatedAt: 0,
        staleTime: STALE_TIME,
        error: new ApiFetchError("/api/stablecoins", 500, null),
        hasData: false,
      },
      NOW,
    );

    expect(health.state).toBe("error");
  });

  it("surfaces a refresh failure while preserving backend-fresh cached data", () => {
    const updatedAtMs = NOW - 2 * 60_000;
    const health = deriveDataHealth(
      {
        label: "Mint/Burn Flows",
        dataUpdatedAt: updatedAtMs,
        staleTime: 60 * 60_000,
        error: new Error("network"),
        hasData: true,
        meta: meta({ updatedAt: Math.floor(updatedAtMs / 1000), ageSeconds: 120 }),
      },
      NOW,
    );

    expect(health.state).toBe("degraded");
    expect(health.message).toBe("Using last successful data while refresh retries.");
    expect(health.dataUpdatedAt).toBe(Math.floor(updatedAtMs / 1000) * 1000);
  });

  it("keeps stale cached data stale when a refresh fails instead of lowering it to degraded", () => {
    const health = deriveDataHealth(
      {
        label: "Prices",
        dataUpdatedAt: NOW - 13 * STALE_TIME,
        staleTime: STALE_TIME,
        error: new Error("network"),
        hasData: true,
      },
      NOW,
    );

    expect(health.state).toBe("stale");
    expect(health.degradationReason).toBe("refresh");
    expect(health.message).toBe("Using last successful data while refresh retries.");
  });
});

describe("mergeHealthStates", () => {
  it("picks highest-priority state and aggregates labels", () => {
    const merged = mergeHealthStates([
      healthEntry({ label: "Prices", state: "fresh", dataUpdatedAt: 10 }),
      healthEntry({ label: "Liquidity", state: "stale", dataUpdatedAt: 9, ageMs: 10 }),
      healthEntry({ label: "Report Cards", state: "degraded", dataUpdatedAt: 8, ageMs: 5 }),
    ]);

    expect(merged.state).toBe("stale");
    expect(merged.affectedLabels).toEqual(["Liquidity", "Report Cards"]);
    expect(merged.latestUpdatedAt).toBe(9);
  });

  it("ranks error above unavailable above stale", () => {
    const stale = healthEntry({ label: "Liquidity", state: "stale", dataUpdatedAt: 30 });
    const unavailable = healthEntry({ label: "Digests", state: "unavailable", dataUpdatedAt: 20 });
    const errored = healthEntry({ label: "Prices", state: "error", dataUpdatedAt: 10 });

    expect(mergeHealthStates([stale, unavailable]).state).toBe("unavailable");
    expect(mergeHealthStates([unavailable, errored]).state).toBe("error");
    expect(mergeHealthStates([errored, stale, unavailable]).state).toBe("error");
    expect(mergeHealthStates([errored, stale, unavailable]).affectedLabels).toEqual([
      "Prices",
      "Liquidity",
      "Digests",
    ]);
  });

  it("reports a fresh aggregate with no labels for empty input", () => {
    expect(mergeHealthStates([])).toEqual({ state: "fresh", affectedLabels: [], latestUpdatedAt: null });
  });

  it("does not label a stale dataset with a fresher healthy dataset timestamp", () => {
    const reportCardsUpdatedAt = Date.parse("2026-07-27T12:46:53.000Z");
    const pricesUpdatedAt = Date.parse("2026-07-27T17:45:13.000Z");

    const merged = mergeHealthStates([
      healthEntry({
        label: "Report Cards",
        state: "stale",
        dataUpdatedAt: reportCardsUpdatedAt,
        ageMs: 5 * 60 * 60_000,
      }),
      healthEntry({ label: "Prices", state: "fresh", dataUpdatedAt: pricesUpdatedAt, ageMs: 13 * 60_000 }),
    ]);

    expect(merged.state).toBe("stale");
    expect(merged.affectedLabels).toEqual(["Report Cards"]);
    expect(merged.latestUpdatedAt).toBe(reportCardsUpdatedAt);
  });

  it("reports no timestamp when every affected entry lacks one", () => {
    const merged = mergeHealthStates([
      healthEntry({ label: "Digests", state: "unavailable", dataUpdatedAt: 0, ageMs: null }),
      healthEntry({ label: "Prices", state: "fresh", dataUpdatedAt: NOW }),
    ]);

    expect(merged.state).toBe("unavailable");
    expect(merged.affectedLabels).toEqual(["Digests"]);
    expect(merged.latestUpdatedAt).toBeNull();
  });
});
