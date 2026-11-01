import { describe, expect, it } from "vitest";
import { loadProbeOperatorWatch } from "../operator-watch-probe";

const NOW = 1_750_000_000;

function probeDb(details: Record<string, unknown> | null): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => (details == null ? null : {
          created_at: NOW,
          details_json: JSON.stringify(details),
        }),
      }),
    }),
  } as unknown as D1Database;
}

function persistentFailure(path: string) {
  return {
    plane: "external", lane: "external", origin: "https://api.pharos.watch",
    path, failStreak: 2, lastProbedAt: NOW,
  };
}

describe("loadProbeOperatorWatch", () => {
  it("turns a persistent probe failure into an operator condition", async () => {
    const evidence = await loadProbeOperatorWatch(probeDb({
      persistentProbeFailures: [persistentFailure("/api/mint-burn-flows")],
    }), NOW);
    expect(evidence.unknown).toBe(false);
    expect(evidence.conditions).toEqual([expect.objectContaining({
      id: "external:/api/mint-burn-flows",
      active: true,
    })]);
  });

  it("keeps reserve and redemption payload-contract paths status-level only", async () => {
    const evidence = await loadProbeOperatorWatch(probeDb({
      persistentProbeFailures: [
        persistentFailure("/api/stablecoin-reserves/iusd-infinifi"),
        persistentFailure("/api/redemption-backstops"),
        persistentFailure("/api/mint-burn-flows"),
      ],
    }), NOW);
    expect(evidence.unknown).toBe(false);
    expect(evidence.conditions.map((condition) => condition.id)).toEqual([
      "external:/api/mint-burn-flows",
    ]);
  });
});
