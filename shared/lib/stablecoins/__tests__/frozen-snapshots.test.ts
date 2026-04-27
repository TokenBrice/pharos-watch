import { describe, expect, it } from "vitest";
import { FROZEN_SNAPSHOTS, FROZEN_SNAPSHOTS_BY_ID, parseFrozenSnapshots } from "../frozen-snapshots";

describe("frozen-snapshots", () => {
  it("indexes every registered snapshot by id", () => {
    expect(FROZEN_SNAPSHOTS.length).toBe(FROZEN_SNAPSHOTS_BY_ID.size);
    for (const snapshot of FROZEN_SNAPSHOTS) {
      expect(FROZEN_SNAPSHOTS_BY_ID.get(snapshot.id)).toBe(snapshot);
    }
  });

  it("parses a well-formed snapshot", () => {
    const parsed = parseFrozenSnapshots([
      {
        id: "fixture-frozen",
        capturedAt: "2026-04-27T00:00:00Z",
        peggedAssetRow: {
          id: "fixture-frozen",
          name: "Fixture",
          symbol: "FXT",
          circulating: { peggedUSD: 1234567 },
          chainCirculating: {},
        },
      },
    ], "fixture");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("fixture-frozen");
  });

  it("rejects an entry whose top-level id mismatches peggedAssetRow.id", () => {
    expect(() =>
      parseFrozenSnapshots(
        [{ id: "a", capturedAt: "2026-04-27T00:00:00Z", peggedAssetRow: { id: "b" } }],
        "fixture",
      ),
    ).toThrow(/id mismatch/i);
  });
});
