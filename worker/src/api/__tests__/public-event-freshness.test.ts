import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { TapeEventsResponseSchema } from "@shared/types/tape-event";
import { makeBlacklistRow, makeDepegRow, makeMintBurnRow } from "../../test-helpers/__shared/fixtures";
import { handleBlacklist } from "../blacklist";
import { handleDepegEvents } from "../depeg-events";
import { handleMintBurnEvents } from "../mint-burn-events";
import { handleEvents } from "../events";
import { handleSafetyScoreHistory } from "../safety-score-history";
import { handleSafetyScoreHistoryV2 } from "../safety-score-history-v2";

const NOW = 1_800_000_000;
const tapeRow = {
  id: 1, event_id: "freshness-event", type: "depeg.opened", severity: "warning", ts: NOW * 1000,
  ends_at: null, coin_id: "usdt-tether", issuer_id: "tether", peg_currency: "peggedUSD", chain: null,
  title: "Depeg opened", summary: "Threshold crossed", payload_json: JSON.stringify({ direction: "below", absDeviationBps: 500 }),
  source_table: "depeg_events", source_row_id: "1", transition: "opened", source_url: null,
  methodology_version: "5.0", created_at: NOW,
};
const feeds = [
  { name: "events", handler: handleEvents, table: "tape_events", row: tapeRow, query: "coin=usdt-tether", offset: null },
  { name: "depeg-events", handler: handleDepegEvents, table: "depeg_events", row: makeDepegRow({ started_at: NOW }), query: "stablecoin=usdt-tether&includeTotal=false", offset: 50_000 },
  { name: "blacklist", handler: handleBlacklist, table: "blacklist_events", row: makeBlacklistRow({ timestamp: NOW }), query: "stablecoin=USDT", offset: 25_000 },
  { name: "mint-burn-events", handler: handleMintBurnEvents, table: "mint_burn_events", row: makeMintBurnRow({ timestamp: NOW }), query: "stablecoin=usdt-tether&includeTotal=false", offset: 25_000 },
];
afterEach(() => vi.useRealTimers());

for (const feed of feeds) {
  describe(`${feed.name} producer authority`, () => {
    for (const populated of [false, true]) {
      it.each(["missing", "lookup_failed", "retained-old", "fresh"] as const)(`%s with ${populated ? "matching events" : "an empty filtered page"}`, async (state) => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW * 1000);
        const timestamp = state === "fresh" ? NOW - 30 : state === "retained-old" ? NOW - 8 * 86_400 : null;
        const db = mockD1([
          { match: "FROM cron_runs", rows: [], first: { started_at: timestamp }, ...(state === "lookup_failed" ? { throwError: new Error("history unavailable") } : {}) },
          { match: `FROM ${feed.table}`, rows: populated ? [feed.row] : [] },
          ...(feed.name === "depeg-events" ? [{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }] : []),
        ]);
        const response = await feed.handler(db, new URL(`https://x/api/${feed.name}?${feed.query}`));
        expect(response.status).toBe(200);
        const body = await response.json() as { events: unknown[] };
        expect(body.events).toHaveLength(populated ? 1 : 0);
        if (state === "fresh") {
          expect(response.headers.get("X-Data-Age")).toBe("30");
          expect(response.headers.get("Cache-Control")).not.toBe("no-store");
        } else {
          expect(response.headers.get("Cache-Control")).toBe("no-store");
          expect(response.headers.get("X-Data-Age")).toBe(timestamp == null ? "unavailable" : String(8 * 86_400));
          if (timestamp == null) expect(response.headers.get("X-Data-Freshness")).toBe(state === "missing" ? "stale" : "unknown");
        }
        if (feed.name === "events") {
          const meta = TapeEventsResponseSchema.parse(body)._meta;
          expect(meta.status).toBe(state === "fresh" ? "fresh" : state === "lookup_failed" ? "unknown" : "stale");
          expect(meta.updatedAt).toBe(timestamp);
        }
      });
    }
    if (feed.offset != null) {
      it("never counts an unobserved offset as population", async () => {
        const db = mockD1([
          { match: `FROM ${feed.table}`, rows: [] },
          ...(feed.name === "depeg-events" ? [{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }] : []),
        ]);
        const response = await feed.handler(db, new URL(`https://x/api/${feed.name}?${feed.query}&offset=${feed.offset}`));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ events: [], total: 0, totalExact: false });
      });
    }
  });
}

it.each([handleSafetyScoreHistory, handleSafetyScoreHistoryV2])("does not refresh safety history from an empty result", async (handler) => {
  const { sqlite, db } = createLatestSchemaSqlite();
  try {
    const response = await handler(db, new URL("https://x/api/safety-score-history?stablecoin=usdt-tether"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Data-Age")).toBe("unavailable");
    expect(response.headers.get("X-Data-Freshness")).toBe("stale");
  } finally {
    sqlite.close();
  }
});

it("keeps a stalled producer stale after its successful run ages out of retained history", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  const { sqlite, db } = createLatestSchemaSqlite();
  try {
    const insert = sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES (?, ?, 1, 'ok')");
    for (const job of ["project-tape", "sync-stablecoins", "sync-blacklist", "sync-mint-burn"]) {
      insert.run(job, NOW - 8 * 86_400);
    }
    sqlite.prepare("DELETE FROM cron_runs WHERE started_at < ?").run(NOW - 7 * 86_400);
    for (const feed of feeds) {
      const response = await feed.handler(db, new URL(`https://x/api/${feed.name}?${feed.query}`));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ events: [] });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Data-Freshness")).toBe("stale");
      expect(response.headers.get("X-Data-Freshness-Reason")).toBe("producer-history-missing");
    }
  } finally {
    sqlite.close();
  }
});
