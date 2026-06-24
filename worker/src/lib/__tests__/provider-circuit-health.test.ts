import { describe, expect, it } from "vitest";
import { CIRCUIT_SOURCE } from "../constants";
import { loadProviderCircuitHealth } from "../provider-circuit-health";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import type { CircuitRecord } from "@shared/types/status";
import { PROVIDER_CIRCUIT_INDEX_CACHE_KEY } from "../circuit-breaker";

function circuit(overrides: Partial<CircuitRecord>): CircuitRecord {
  return {
    state: "closed",
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
    openedAt: null,
    ...overrides,
  };
}

describe("provider-circuit-health", () => {
  it("summarizes active provider circuits without scanning by prefix", async () => {
    const now = 2_000;
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: [PROVIDER_CIRCUIT_INDEX_CACHE_KEY],
        rows: [
          {
            key: PROVIDER_CIRCUIT_INDEX_CACHE_KEY,
            value: JSON.stringify({
              circuits: {
                [CIRCUIT_SOURCE.BALANCER_API]: circuit({
                  state: "open",
                  consecutiveFailures: 4,
                  lastFailureAt: 1_900,
                  openedAt: 1_800,
                }),
                [CIRCUIT_SOURCE.ORCA_API]: circuit({
                  state: "half-open",
                  consecutiveFailures: 2,
                  lastFailureAt: 1_700,
                  openedAt: 1_600,
                }),
              },
              updatedAt: now,
            }),
            updated_at: now,
          },
        ],
      },
    ]);

    const health = await loadProviderCircuitHealth(db, now);

    expect(health.status).toBe("degraded");
    expect(health.openCount).toBe(1);
    expect(health.halfOpenCount).toBe(1);
    expect(health.openProviders.map((entry) => entry.providerId)).toEqual([
      CIRCUIT_SOURCE.BALANCER_API,
      CIRCUIT_SOURCE.ORCA_API,
    ]);
    expect(health.openProviders[0]).toMatchObject({
      family: "balancer",
      openAgeSec: 200,
    });
    expect(db.getHistory()[0]?.binds).toEqual([PROVIDER_CIRCUIT_INDEX_CACHE_KEY]);
    expect(db.getHistory()[0]?.sql).toContain("WHERE key = ?");
    expect(db.getHistory()[0]?.sql).not.toContain("LIKE 'circuit:%'");
  });

  it("degrades when tracked circuits are half-open but none are open", async () => {
    const now = 2_000;
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: [PROVIDER_CIRCUIT_INDEX_CACHE_KEY],
        rows: [
          {
            key: PROVIDER_CIRCUIT_INDEX_CACHE_KEY,
            value: JSON.stringify({
              circuits: {
                [CIRCUIT_SOURCE.ORCA_API]: circuit({
                  state: "half-open",
                  consecutiveFailures: 1,
                  lastFailureAt: 1_900,
                  openedAt: 1_850,
                }),
              },
              updatedAt: now,
            }),
            updated_at: now,
          },
        ],
      },
    ]);

    const health = await loadProviderCircuitHealth(db, now);

    expect(health.status).toBe("degraded");
    expect(health.openCount).toBe(0);
    expect(health.halfOpenCount).toBe(1);
  });
});
