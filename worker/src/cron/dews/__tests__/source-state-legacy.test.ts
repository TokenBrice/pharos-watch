import { describe, expect, it } from "vitest";
import { loadDewsSourceState } from "../source-state";

/**
 * Minimal D1 mock that returns a single row from the previous-stress-signals
 * SELECT and empty results elsewhere. Used to verify that legacy flat-shape
 * `signals_json` blobs (no `amplifiers` wrapper) hydrate cleanly alongside
 * the new `{ signals, amplifiers }` shape.
 */
function mockDbWithPrevRows(
  prevRows: Array<{
    stablecoin_id: string;
    signals_json: string;
    band: string;
    computed_at: number;
  }>,
  rankingsCache?: { value: string; updated_at: number },
): D1Database {
  const stmt = (sql: string) => {
    const all = async <T>() => {
      if (sql.includes("FROM stress_signals s")) {
        return { results: prevRows as unknown as T[] };
      }
      return { results: [] as T[] };
    };
    const first = async <T>() => {
      if (sql.includes("FROM cache WHERE key = ?")) return (rankingsCache ?? null) as T | null;
      return null as T | null;
    };
    const run = async () => ({ success: true, meta: { changes: 0 } });
    return {
      bind: () => ({ all, first, run }),
      all,
      first,
      run,
    };
  };
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

describe("loadDewsSourceState legacy signals_json hydration", () => {
  const nowSec = 1_700_000_000;

  it("hydrates a legacy flat-shape signals_json row (no amplifiers wrapper)", async () => {
    const legacyPayload = {
      supply: { value: 5, available: true },
      pool: { value: 12, available: true },
    };
    const db = mockDbWithPrevRows([
      {
        stablecoin_id: "usdt-tether",
        signals_json: JSON.stringify(legacyPayload),
        band: "CALM",
        computed_at: nowSec - 600,
      },
    ]);

    const sourceState = await loadDewsSourceState({
      db,
      nowSec,
      bootstrapPending: false,
      registerSourceFailure: () => {},
      registerMalformedPersistedInput: () => {},
    });

    // Legacy rows surface as the flat signals map (no `.signals` wrapper key).
    const prev = sourceState.prevSignals.get("usdt-tether");
    expect(prev).toBeDefined();
    expect(prev?.signals.supply).toEqual({ value: 5, available: true });
    expect(prev?.signals.pool).toEqual({ value: 12, available: true });
    expect(prev?.ageSec).toBe(600);
  });

  it("hydrates a new wrapped-shape signals_json row by unwrapping .signals", async () => {
    const newPayload = {
      signals: {
        supply: { value: 8, available: true },
      },
      amplifiers: { psi: 1, contagion: 1 },
    };
    const db = mockDbWithPrevRows([
      {
        stablecoin_id: "usdt-tether",
        signals_json: JSON.stringify(newPayload),
        band: "CALM",
        computed_at: nowSec - 600,
      },
    ]);

    const sourceState = await loadDewsSourceState({
      db,
      nowSec,
      bootstrapPending: false,
      registerSourceFailure: () => {},
      registerMalformedPersistedInput: () => {},
    });

    // New rows surface as the unwrapped signals map for back-compat with the
    // existing smoothing read path.
    const prev = sourceState.prevSignals.get("usdt-tether");
    expect(prev).toBeDefined();
    expect(prev?.signals.supply).toEqual({ value: 8, available: true });
    // The amplifiers envelope is stripped — downstream hydration defaults it
    // to { psi: 1, contagion: 1 } when re-scoring.
    expect((prev?.signals as Record<string, unknown>).amplifiers).toBeUndefined();
  });

  it("hydrates structured yield source-risk and rank attribution from rankings cache", async () => {
    const db = mockDbWithPrevRows([], {
      value: JSON.stringify({
        rankings: [
          {
            id: "usdt-tether",
            sourceRisk: {
              sourceRiskPenalty: 1.5,
              rewardShare: 0.9,
              sourceAgeSeconds: 30_000,
              venueRiskTier: "unknown",
            },
            rankChangeAttribution: {
              rankDelta: -5,
              primaryDriver: "source-risk",
            },
          },
        ],
      }),
      updated_at: nowSec,
    });

    const sourceState = await loadDewsSourceState({
      db,
      nowSec,
      bootstrapPending: false,
      registerSourceFailure: () => {},
      registerMalformedPersistedInput: () => {},
    });

    expect(sourceState.yieldSourceRisk.get("usdt-tether")).toMatchObject({
      sourceRiskPenalty: 1.5,
      rewardShare: 0.9,
      sourceAgeSeconds: 30_000,
      venueRiskTier: "unknown",
    });
    expect(sourceState.yieldRankChangeAttribution.get("usdt-tether")).toMatchObject({
      rankDelta: -5,
      primaryDriver: "source-risk",
    });
    expect(sourceState.sourceCoverage.yieldStructuredRows).toBe(1);
  });
});
