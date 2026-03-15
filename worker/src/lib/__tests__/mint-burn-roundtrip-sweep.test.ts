import { describe, expect, it, vi } from "vitest";
import { sweepRecentRoundtrips } from "../mint-burn-pipeline/roundtrip-sweep";

vi.mock("../db", () => ({
  batchExecute: vi.fn().mockResolvedValue(0),
}));

vi.mock("../mint-burn-pipeline/persistence", () => ({
  recalcAffectedHours: vi.fn().mockResolvedValue(undefined),
}));

describe("sweepRecentRoundtrips", () => {
  it("returns 0 when no cross-run roundtrips exist", async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
        }),
      }),
    } as unknown as D1Database;

    const result = await sweepRecentRoundtrips(db, Math.floor(Date.now() / 1000));
    expect(result.reclassified).toBe(0);
    expect(result.affectedHours.size).toBe(0);
  });

  it("reclassifies cross-run roundtrips and returns affected hours", async () => {
    const mockAll = vi.fn().mockResolvedValue({
      results: [
        { tx_hash: "0xaaa", stablecoin_id: "usdc-circle", chain_id: "ethereum", min_ts: 1700000000 },
      ],
    });
    const mockBind = vi.fn().mockReturnValue({
      all: mockAll,
      run: vi.fn().mockResolvedValue({ meta: { changes: 2 } }),
    });
    const db = {
      prepare: vi.fn().mockReturnValue({ bind: mockBind }),
    } as unknown as D1Database;

    // Mock batchExecute to return the number of changes
    const { batchExecute } = await import("../db");
    vi.mocked(batchExecute).mockResolvedValue(2);

    const result = await sweepRecentRoundtrips(db, 1700001000);
    expect(result.reclassified).toBe(2);
    expect(result.affectedHours.size).toBe(1);
  });
});
