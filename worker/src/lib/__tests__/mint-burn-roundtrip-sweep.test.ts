import { describe, expect, it, vi } from "vitest";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { sweepRecentRoundtrips } from "../mint-burn-pipeline/roundtrip-sweep";

vi.mock("../db", () => ({
  batchExecute: vi.fn().mockResolvedValue(0),
}));

vi.mock("../mint-burn-pipeline/persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mint-burn-pipeline/persistence")>();
  return {
    ...actual,
    recalcAffectedHours: vi.fn().mockResolvedValue(undefined),
  };
});

describe("sweepRecentRoundtrips", () => {
  it("returns 0 when no cross-run roundtrips exist", async () => {
    const db = makeNoopD1({
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
        }),
      }),
    });

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
    const prepare = vi.fn().mockReturnValue({ bind: mockBind });
    const db = makeNoopD1({ prepare });

    // Mock batchExecute to return the number of changes
    const { batchExecute } = await import("../db");
    vi.mocked(batchExecute).mockResolvedValue(2);

    const result = await sweepRecentRoundtrips(db, 1700001000);
    expect(result.reclassified).toBe(2);
    expect(result.affectedHours.size).toBe(1);

    const updateSql = prepare.mock.calls
      .map((call) => call[0] as string)
      .find((sql) => sql.includes("UPDATE mint_burn_events"));
    expect(updateSql).toContain("chain_id = ?");
    expect(mockBind).toHaveBeenCalledWith("0xaaa", "usdc-circle", "ethereum");
  });

  it("selects roundtrip candidates in deterministic oldest-first order", async () => {
    const prepare = vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
    });
    const db = makeNoopD1({ prepare });

    await sweepRecentRoundtrips(db, 1700001000);

    const sql = prepare.mock.calls[0]?.[0] as string;
    expect(sql).toContain("ORDER BY MIN(timestamp) ASC, stablecoin_id ASC, tx_hash ASC");
  });

  // Drift guard: the SQL HAVING clause must enforce the same 0.5% mint/burn
  // amount tolerance as the in-memory detector. The constant lives in
  // `roundtrip-detection.ts` (ROUNDTRIP_AMOUNT_TOLERANCE); SQL can't import it,
  // so we assert the literal and the CASE-WHEN max pattern are present.
  it("HAVING clause requires mint/burn totals match within the same 0.5% tolerance as the in-memory detector", async () => {
    const prepare = vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
    });
    const db = makeNoopD1({ prepare });

    await sweepRecentRoundtrips(db, 1700001000);

    const sql = prepare.mock.calls[0]?.[0] as string;
    expect(sql).toContain("0.005");
    // Verifies the CASE WHEN max pattern (not scalar MAX(a,b))
    expect(sql).toMatch(/CASE\s+WHEN[\s\S]+>=[\s\S]+THEN[\s\S]+ELSE[\s\S]+END/);
  });
});
