import { afterEach, describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { routeContextFactory } from "../../test-helpers/__shared/routes";
import { makeDepegRow } from "../../test-helpers/__shared/fixtures";
import { handleDepegEvents } from "../depeg-events";
import { handleStablecoins } from "../cache-handlers";
import { route } from "../../router";
import { validateAndWriteStablecoinsCache } from "../../cron/sync-stablecoins/cache-publication";
import { makePeggedAsset } from "../../cron/sync-stablecoins/__tests__/_fixtures";
import { getResponseReadyCacheKey } from "../../lib/api-cache-read";

/**
 * Single-row admission on aggregate public routes (rule R8 / ADR-35).
 *
 * These pin the current whole-response admission: one unusable stored row fails
 * the route instead of being withheld while the readable peers publish. Both
 * routes fail closed; depeg-events names the refused row, stablecoins names the
 * malformed cached payload.
 */
const SEC = 1_700_000_000;
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("/api/depeg-events single-row admission", () => {
  function dbWithRows(rows: Record<string, unknown>[]) {
    return mockD1([
      { match: "pharos:depeg-event-projection:active-incidents", rows: [] },
      { match: "pharos:depeg-events:count", rows: [{ total: rows.length }] },
      { match: "depeg_events", rows },
    ]);
  }

  it("publishes every row when each stored semantic value is readable", async () => {
    const db = dbWithRows([makeDepegRow({ id: 1 }), makeDepegRow({ id: 2, stablecoin_id: "usdc-circle", symbol: "USDC" })]);
    const body = await readJsonResponse(await handleDepegEvents(db, new URL("https://x/api/depeg-events")), 200) as {
      events: Array<{ id: number }>;
      total: number;
    };
    expect(body.events.map((event) => event.id)).toEqual([1, 2]);
    expect(body.total).toBe(2);
  });

  it.each([
    { field: "direction", overrides: { direction: "sideways" }, reason: "invalid-direction" },
    { field: "source", overrides: { source: "replay" }, reason: "invalid-source" },
    { field: "close_reason", overrides: { close_reason: "not-a-close-reason" }, reason: "invalid-close-reason" },
  ])("names the refused $field row instead of publishing a partial ledger", async ({ overrides, reason }) => {
    // No partial publish: a row whose stored semantics cannot be classified is
    // not served as a best-effort event (never invent direction/source/closure).
    const badRow: Record<string, unknown> = { ...makeDepegRow({ id: 2 }), ...overrides };
    const db = dbWithRows([makeDepegRow({ id: 1 }), badRow]);
    const url = new URL("https://x/api/depeg-events");
    const expected = { error: "Depeg event row unreadable", reason, eventId: 2 };
    const publicResponse = await route(routeContextFactory({ db })({ url }));
    expect(publicResponse).not.toBeNull();
    expect(publicResponse!.headers.get("Cache-Control")).toBe("no-store");
    expect(await readJsonResponse(publicResponse!, 503)).toEqual(expected);
    // Secondary: the unreadable row is the handler's own named refusal, not an
    // unrelated failure the error boundary happened to catch.
    expect(await readJsonResponse(await handleDepegEvents(db, url), 503)).toEqual(expected);
  });

  it("keeps a row whose stored coverage JSON no longer decodes, with explicit empty coverage", async () => {
    const db = dbWithRows([{ ...makeDepegRow({ id: 1 }), price_coverage_json: "{not-json" }]);
    const body = await readJsonResponse(await handleDepegEvents(db, new URL("https://x/api/depeg-events")), 200) as {
      events: Array<{ id: number; priceCoverage: unknown }>;
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.priceCoverage).toEqual({
      intervals: [], atParIntervals: [], lastTrustedObservationAt: null, gapStartedAt: null,
    });
  });
});

describe("/api/stablecoins single-row admission", () => {
  it("fails closed with a named 503 instead of publishing the readable peers", async () => {
    // The cache handler admits the whole published envelope at once, so one row
    // that a reader-floor schema rejects takes the route down (unlike the
    // sync-stablecoins publication boundary, which quarantines per asset).
    const { sqlite, db: fixtureDb } = fixtures.open();
    await validateAndWriteStablecoinsCache({
      assets: [makePeggedAsset({
        pegMechanism: "fiat-backed", price: 1, priceSource: "coingecko",
        circulating: { peggedUSD: 100 }, chainCirculating: {}, chains: [],
      })],
      db: fixtureDb,
      syncStartSec: SEC,
      validationContext: "main",
    }, () => ({ metadata: "blocked" }));
    const cached = sqlite.prepare("SELECT value FROM cache WHERE key = 'stablecoins'").get() as { value: string };
    const payload = JSON.parse(cached.value) as { peggedAssets: Array<Record<string, unknown>> };
    payload.peggedAssets.push({ ...payload.peggedAssets[0]!, id: "bad-coin-bad", circulating: "not-a-bucket" });
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = 'stablecoins'").run(JSON.stringify(payload));
    // The response-ready companion would otherwise mask the canonical mutation.
    sqlite.prepare("DELETE FROM cache WHERE key = ?").run(getResponseReadyCacheKey("stablecoins"));

    const response = await handleStablecoins(fixtureDb);
    expect(await readJsonResponse(response, 503)).toEqual({ error: "Cached stablecoins payload is malformed" });
  });
});
