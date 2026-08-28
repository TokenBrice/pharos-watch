import { describe, expect, it } from "vitest";
import { CIRCUIT_SOURCE } from "../constants";
import { loadProviderCircuitHealth } from "../provider-circuit-health";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { CircuitRecord } from "@shared/types/status";

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
  it("summarizes active provider circuits from authoritative circuit rows without scanning by prefix", async () => {
    const now = 2_000;
    const db = mockD1([
      {
        match: "FROM cache WHERE key IN",
        rows: [
          {
            key: `circuit:${CIRCUIT_SOURCE.BALANCER_API}`,
            value: JSON.stringify(circuit({
              state: "open",
              consecutiveFailures: 4,
              lastFailureAt: 1_900,
              openedAt: 1_800,
            })),
          },
          {
            key: `circuit:${CIRCUIT_SOURCE.ORCA_API}`,
            value: JSON.stringify(circuit({
              state: "half-open",
              consecutiveFailures: 2,
              lastFailureAt: 1_700,
              openedAt: 1_600,
            })),
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
    expect(db.getHistory()[0]?.binds.every((key) => typeof key === "string" && key.startsWith("circuit:"))).toBe(true);
    expect(db.getHistory()[0]?.sql).toContain("WHERE key IN");
    expect(db.getHistory()[0]?.sql).not.toContain("LIKE 'circuit:%'");
  });

  it("degrades when tracked circuits are half-open but none are open", async () => {
    const now = 2_000;
    const db = mockD1([
      {
        match: "FROM cache WHERE key IN",
        rows: [
          {
            key: `circuit:${CIRCUIT_SOURCE.ORCA_API}`,
            value: JSON.stringify(circuit({
              state: "half-open",
              consecutiveFailures: 1,
              lastFailureAt: 1_900,
              openedAt: 1_850,
            })),
          },
        ],
      },
    ]);

    const health = await loadProviderCircuitHealth(db, now);

    expect(health.status).toBe("degraded");
    expect(health.openCount).toBe(0);
    expect(health.halfOpenCount).toBe(1);
  });

  it("reports authoritative open rows even when the aggregate provider index is stale", async () => {
    const now = 2_000;
    const db = mockD1([
      {
        match: "FROM cache WHERE key IN",
        rows: [
          {
            key: `circuit:${CIRCUIT_SOURCE.BALANCER_API}`,
            value: JSON.stringify(circuit({
              state: "open",
              consecutiveFailures: 3,
              lastFailureAt: 1_950,
              openedAt: 1_940,
            })),
          },
        ],
      },
    ]);

    const health = await loadProviderCircuitHealth(db, now);

    expect(health.status).toBe("degraded");
    expect(health.openCount).toBe(1);
    expect(health.openProviders.map((entry) => entry.providerId)).toContain(CIRCUIT_SOURCE.BALANCER_API);
  });

});
