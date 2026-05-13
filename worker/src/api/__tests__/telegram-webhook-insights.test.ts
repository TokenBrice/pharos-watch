import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { buildTopMessage } from "../telegram-webhook-insights";

describe("buildTopMessage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds /top depeg from schema-correct depeg_events columns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));

    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: 180,
            display_price: 0.982,
            peg_reference: 1,
            started_at: Math.floor(Date.now() / 1000) - 3600,
          },
        ],
      },
    ]);

    const message = await buildTopMessage(db, "depeg");

    expect(message).toContain("Top active depegs");
    expect(message).toContain("USDC");
    expect(message).toContain("below peg 1.8%");
    expect(message).toContain("price $0.9820");

    const sql = db.getHistory()[0]?.sql ?? "";
    expect(sql).toMatch(/\bCOALESCE\(peak_price,\s*start_price\) AS display_price\b/);
    expect(sql).not.toMatch(/\bSELECT\b[\s\S]*,\s*price\s*,[\s\S]*\bFROM depeg_events\b/);
  });

  it("falls back to usage text for unknown /top views", async () => {
    const db = mockD1([], { requireMatch: true });

    await expect(buildTopMessage(db, "unknown")).resolves.toBe("Usage: /top depeg|dews|yield|liquidity|chains|safety");
    expect(db.getHistory()).toEqual([]);
  });

  it("filters /top yield rows to legacy or published yield_data rows", async () => {
    const db = mockD1([
      {
        match: "FROM yield_data",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            current_apy: 4.4,
            apy_30d: 4.2,
            yield_source: "Aave V3",
            pharos_yield_score: 31,
            source_tvl_usd: 12_000_000,
          },
        ],
      },
    ]);

    const message = await buildTopMessage(db, "yield");

    expect(message).toContain("Top risk-adjusted yields");
    expect(message).toContain("USDC");
    const yieldSql = db.getHistory().find((entry) => entry.sql.includes("FROM yield_data"))?.sql;
    expect(yieldSql).toContain("publication_generation_id IS NULL OR publication_state = 'published'");
  });

  it("suggests the closest /top view for one-character typos", async () => {
    const db = mockD1([], { requireMatch: true });

    await expect(buildTopMessage(db, "dewz")).resolves.toBe(
      "Did you mean /top dews?\nUsage: /top depeg|dews|yield|liquidity|chains|safety",
    );
    await expect(buildTopMessage(db, "safty")).resolves.toBe(
      "Did you mean /top safety?\nUsage: /top depeg|dews|yield|liquidity|chains|safety",
    );
    expect(db.getHistory()).toEqual([]);
  });
});
