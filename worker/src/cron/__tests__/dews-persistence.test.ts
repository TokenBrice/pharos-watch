import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { persistDewsResults } from "../dews/persistence";
import type { DewsComputedRow } from "../dews/contracts";

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

describe("persistDewsResults", () => {
  it("upserts stress_signals_latest alongside current stress rows", async () => {
    const db = mockD1();

    await persistDewsResults({
      db,
      results: [buildDewsRow("usdt-tether")],
      eligibleIds: new Set(["usdt-tether"]),
      nowSec: 1_800_000_000,
    });

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("pharos:dews:stress-current-upsert"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("pharos:dews:stress-latest-upsert"))).toBe(true);
  });

  it("keeps current stress persistence safe when the latest table is absent", async () => {
    const db = mockD1([
      {
        match: "stress_signals_latest",
        rows: [],
        throwError: new Error("no such table: stress_signals_latest"),
      },
    ]);

    await expect(persistDewsResults({
      db,
      results: [buildDewsRow("usdt-tether")],
      eligibleIds: new Set(["usdt-tether"]),
      nowSec: 1_800_000_000,
    })).resolves.toEqual(expect.objectContaining({ rowsRetiredCurrent: 0 }));

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("pharos:dews:stress-current-upsert"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("pharos:dews:stress-latest-upsert"))).toBe(true);
  });
});
