import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { loadStatusForCoin } from "../telegram-webhook-status";

describe("loadStatusForCoin", () => {
  it("returns DEWS + safety + depeg=stable when no active event", async () => {
    const db = mockD1([
      { match: "FROM stress_signals", rows: [{ band: "ALERT", score: 42, computed_at: 1700000000 }] },
      { match: "FROM safety_grade_history", rows: [{ grade: "B+", score: 66, recorded_at: 1700000000 }] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [{ price: 0.9997, updated_at: 1700000000 }] },
    ]);
    const status = await loadStatusForCoin(db, "usdc-circle");
    expect(status.dews?.band).toBe("ALERT");
    expect(status.safety?.grade).toBe("B+");
    expect(status.depeg.status).toBe("stable");
    expect(status.priceUsd).toBeCloseTo(0.9997);
  });

  it("surfaces an active depeg event with direction and deviation", async () => {
    const db = mockD1([
      { match: "FROM stress_signals", rows: [{ band: "WATCH", score: 30, computed_at: 1700000000 }] },
      { match: "FROM safety_grade_history", rows: [{ grade: "A", score: 80, recorded_at: 1700000000 }] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [
        { direction: "below", peak_deviation_bps: 180, started_at: 1700000000, peg_reference: 1.0 },
      ] },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [{ price: 0.982, updated_at: 1700000500 }] },
    ]);
    const status = await loadStatusForCoin(db, "usdc-circle");
    expect(status.depeg.status).toBe("active");
    if (status.depeg.status === "active") {
      expect(status.depeg.direction).toBe("below");
      expect(status.depeg.peakDeviationBps).toBe(180);
    }
  });

  it("handles a fully unseeded coin gracefully (null everywhere)", async () => {
    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [] },
    ]);
    const status = await loadStatusForCoin(db, "newcoin-xyz");
    expect(status.dews).toBeNull();
    expect(status.safety).toBeNull();
    expect(status.priceUsd).toBeNull();
    expect(status.depeg.status).toBe("stable");
  });

  it("uses schema-correct column names", async () => {
    // Regression guard: the dispatcher uses `computed_at` on stress_signals and
    // `recorded_at` on safety_grade_history. Mismatching either would throw
    // `no such column` at D1 runtime but silently pass substring-based fixtures.
    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [] },
    ]);
    await loadStatusForCoin(db, "usdc-circle");
    const history = db.getHistory().map((h) => h.sql);

    const stressSql = history.find((s) => s.includes("FROM stress_signals"));
    expect(stressSql).toMatch(/\bcomputed_at\b/);
    expect(stressSql).not.toMatch(/\brecorded_at\b/);

    const safetySql = history.find((s) => s.includes("FROM safety_grade_history"));
    expect(safetySql).toMatch(/\brecorded_at\b/);
    expect(safetySql).not.toMatch(/\bcomputed_at\b/);

    const priceSql = history.find((s) => s.includes("FROM price_cache"));
    expect(priceSql).toMatch(/\basset_id\b/);
    expect(priceSql).toMatch(/\bupdated_at\b/);

    const depegSql = history.find((s) => s.includes("FROM depeg_events"));
    expect(depegSql).toMatch(/\bpeak_deviation_bps\b/);
    expect(depegSql).toMatch(/\bpeg_reference\b/);
  });
});
