import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { loadDewsRows } from "../dispatch-telegram-state";

const nowSec = Math.floor(Date.now() / 1000);
const completedDewsAt = nowSec - 60;

const signalsJson = JSON.stringify({
  supply: { value: 10, available: true },
});

function freshnessRow(updatedAt: number) {
  return {
    key: "dews:published-generation",
    value: JSON.stringify({ updatedAt, source: "compute-dews", publishStatus: "published" }),
    updated_at: updatedAt,
  };
}

describe("loadDewsRows", () => {
  it("uses the published DEWS generation pointer as the reader cutoff", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [freshnessRow(completedDewsAt)],
        first: freshnessRow(completedDewsAt),
      },
      {
        match: "pharos:telegram-dispatch:dews-latest",
        matchBinds: [completedDewsAt],
        rows: [],
      },
      {
        match: "pharos:telegram-dispatch:dews-legacy",
        matchBinds: [completedDewsAt],
        rows: [
          {
            stablecoin_id: "usdt-tether",
            score: 12,
            band: "CALM",
            signals_json: signalsJson,
            computed_at: completedDewsAt,
          },
        ],
      },
    ]);

    const rows = await loadDewsRows(db, nowSec);

    expect(rows).toEqual([
      {
        stablecoin_id: "usdt-tether",
        score: 12,
        band: "CALM",
        signals_json: signalsJson,
        computed_at: completedDewsAt,
      },
    ]);
    const history = db.getHistory();
    expect(history.some((entry) =>
      entry.sql.includes("pharos:telegram-dispatch:dews-latest") &&
      entry.sql.includes("computed_at <= ?") &&
      entry.binds[0] === completedDewsAt
    )).toBe(true);
    expect(history.some((entry) =>
      entry.sql.includes("pharos:telegram-dispatch:dews-legacy") &&
      entry.sql.includes("computed_at <= ?") &&
      entry.binds[0] === completedDewsAt
    )).toBe(true);
  });

  it("preserves legacy-only rows when latest rows are fresh but partial", async () => {
    const latestRow = {
      stablecoin_id: "usdc-circle",
      score: 8,
      band: "CALM",
      signals_json: signalsJson,
      computed_at: completedDewsAt,
    };
    const legacyOnlyRow = {
      stablecoin_id: "usdt-tether",
      score: 13,
      band: "WATCH",
      signals_json: signalsJson,
      computed_at: completedDewsAt - 30,
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [freshnessRow(completedDewsAt)],
        first: freshnessRow(completedDewsAt),
      },
      {
        match: "pharos:telegram-dispatch:dews-latest",
        matchBinds: [completedDewsAt],
        rows: [latestRow],
      },
      {
        match: "pharos:telegram-dispatch:dews-legacy",
        matchBinds: [completedDewsAt],
        rows: [legacyOnlyRow],
      },
    ]);

    const rows = await loadDewsRows(db, nowSec);

    expect(rows).toEqual([legacyOnlyRow, latestRow]);
    const history = db.getHistory();
    expect(history.some((entry) =>
      entry.sql.includes("pharos:telegram-dispatch:dews-legacy")
    )).toBe(true);
  });
});
