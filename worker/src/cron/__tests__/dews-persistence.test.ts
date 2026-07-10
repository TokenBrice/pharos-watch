import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { persistDewsResults } from "../dews/persistence";
import type { DewsComputedRow } from "../dews/contracts";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";

function buildDewsRow(stablecoinId: string): DewsComputedRow {
  return {
    stablecoinId,
    score: 12,
    band: "CALM",
    signals: { supply: { value: 10, available: true, weight: 1 } },
    amplifiers: { psi: 1, contagion: 1 },
    baseScore: 12,
    finalScore: 12,
    availableWeight: 1,
    effectiveWeights: { supply: 1 },
    evidenceKinds: ["supply"],
    insufficientEvidenceReason: null,
    dataQualityScore: 1,
    topContributors: [],
  } as unknown as DewsComputedRow;
}

function makeDewsPersistenceDb(options: {
  currentGenerationRows?: number;
  latestGenerationRows?: number;
  latestTableMissing?: boolean;
} = {}) {
  const currentGenerationRows = options.currentGenerationRows ?? 1;
  const latestGenerationRows = options.latestGenerationRows ?? 1;
  return mockD1([
    {
      match: "pharos:dews:stress-current-generation-count",
      rows: [{ cnt: currentGenerationRows }],
      first: { cnt: currentGenerationRows },
    },
    {
      match: "pharos:dews:stress-latest-generation-count",
      rows: [{ cnt: latestGenerationRows }],
      first: { cnt: latestGenerationRows },
      throwError: options.latestTableMissing ? new Error("no such table: stress_signals_latest") : undefined,
    },
    ...(options.latestTableMissing
      ? [{
          match: "stress_signals_latest",
          rows: [],
          throwError: new Error("no such table: stress_signals_latest"),
        }]
      : []),
  ]);
}

describe("persistDewsResults", () => {
  it("upserts stress_signals_latest alongside current stress rows", async () => {
    const db = makeDewsPersistenceDb();

    const result = await persistDewsResults({
      db,
      results: [buildDewsRow("usdt-tether")],
      eligibleIds: new Set(["usdt-tether"]),
      publishFreshnessSentinel: true,
      nowSec: 1_800_000_000,
    });

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("pharos:dews:stress-current-upsert"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("pharos:dews:stress-latest-upsert"))).toBe(true);
    expect(history.some((entry) => entry.binds.includes("dews:published-generation"))).toBe(true);
    const pointerWrite = history.find((entry) => entry.binds.includes("dews:published-generation"));
    expect(JSON.parse(String(pointerWrite?.binds[1]))).toMatchObject({
      coverageVersion: 2,
      expectedRowCount: 1,
      stablecoinIdsDigest: buildDewsStablecoinIdsDigest(["usdt-tether"]),
    });
    expect(result).toMatchObject({
      currentGenerationRows: 1,
      latestGenerationRows: 1,
      publicationPointerWritten: true,
      publishedGeneration: 1_800_000_000,
    });
  });

  it("keeps current stress persistence safe when the latest table is absent", async () => {
    const db = makeDewsPersistenceDb({ latestTableMissing: true });

    await expect(persistDewsResults({
      db,
      results: [buildDewsRow("usdt-tether")],
      eligibleIds: new Set(["usdt-tether"]),
      publishFreshnessSentinel: true,
      nowSec: 1_800_000_000,
    })).resolves.toEqual(expect.objectContaining({ rowsRetiredCurrent: 0 }));

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("pharos:dews:stress-current-upsert"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("pharos:dews:stress-latest-upsert"))).toBe(true);
    expect(history.some((entry) => entry.binds.includes("dews:published-generation"))).toBe(true);
  });

  it("writes the publication pointer but skips the freshness sentinel when the run is degraded", async () => {
    const db = makeDewsPersistenceDb();

    await persistDewsResults({
      db,
      results: [buildDewsRow("usdt-tether")],
      eligibleIds: new Set(["usdt-tether"]),
      publishFreshnessSentinel: false,
      nowSec: 1_800_000_000,
    });

    const history = db.getHistory();
    expect(history.some((entry) => entry.binds.includes("dews:published-generation"))).toBe(true);
    expect(history.some((entry) => entry.binds.includes("freshness:dews"))).toBe(false);
  });

  it("does not publish freshness when the signal aborts after current-row writes", async () => {
    const db = makeDewsPersistenceDb();
    const originalBatch = db.batch.bind(db);
    const controller = new AbortController();
    const abortError = new Error("cron timed out");
    let batchCalls = 0;

    db.batch = async <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      const result = await originalBatch<T>(statements);
      batchCalls++;
      if (batchCalls === 1) {
        controller.abort(abortError);
      }
      return result;
    };

    await expect(
      persistDewsResults({
        db,
        results: [buildDewsRow("usdt-tether")],
        eligibleIds: new Set(["usdt-tether"]),
        publishFreshnessSentinel: true,
        nowSec: 1_800_000_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cron timed out");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("pharos:dews:stress-current-upsert"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("pharos:dews:stress-latest-upsert"))).toBe(false);
    expect(history.some((entry) => entry.binds.includes("dews:published-generation"))).toBe(false);
    expect(history.some((entry) => entry.binds.includes("freshness:dews"))).toBe(false);
  });

  it("does not publish the pointer when the current generation row count is incomplete", async () => {
    const db = makeDewsPersistenceDb({ currentGenerationRows: 0 });

    await expect(persistDewsResults({
      db,
      results: [buildDewsRow("usdt-tether")],
      eligibleIds: new Set(["usdt-tether"]),
      publishFreshnessSentinel: true,
      nowSec: 1_800_000_000,
    })).rejects.toThrow("DEWS publication incomplete");

    const history = db.getHistory();
    expect(history.some((entry) => entry.binds.includes("dews:published-generation"))).toBe(false);
    expect(history.some((entry) => entry.binds.includes("freshness:dews"))).toBe(false);
  });

  it("skips the freshness sentinel when no DEWS rows were written", async () => {
    const db = mockD1();

    await persistDewsResults({
      db,
      results: [],
      eligibleIds: new Set(["usdt-tether"]),
      publishFreshnessSentinel: true,
      nowSec: 1_800_000_000,
    });

    const history = db.getHistory();
    expect(history.some((entry) => entry.binds.includes("dews:published-generation"))).toBe(false);
    expect(history.some((entry) => entry.binds.includes("freshness:dews"))).toBe(false);
  });
});
