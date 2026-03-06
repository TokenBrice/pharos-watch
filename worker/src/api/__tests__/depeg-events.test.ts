import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeDepegRow } from "./helpers/fixtures";
import { handleDepegEvents } from "../depeg-events";

describe("handleDepegEvents", () => {
  const row = makeDepegRow();

  it("returns 200 with events and total", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "depeg_events", rows: [row] },
    ]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      total: number;
      methodology: Record<string, unknown>;
    };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.methodology).toHaveProperty("version");
    expect(body.methodology).toHaveProperty("changelogPath");
  });

  it("maps snake_case to camelCase via rowToDepegEvent", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "depeg_events", rows: [row] },
    ]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events"));
    const body = (await res.json()) as { events: Array<Record<string, unknown>> };
    const event = body.events[0];
    expect(event).toHaveProperty("stablecoinId");
    expect(event).toHaveProperty("peakDeviationBps");
    expect(event).toHaveProperty("startedAt");
    expect(event).toHaveProperty("pegReference");
    expect(event).not.toHaveProperty("stablecoin_id");
    expect(event).not.toHaveProperty("peak_deviation_bps");
  });

  it("returns 200 with empty results when no data", async () => {
    const emptyDb = mockD1([
      { match: "COUNT", rows: [{ total: 0 }] },
      { match: "depeg_events", rows: [] },
    ]);
    const res = await handleDepegEvents(emptyDb, new URL("https://x/api/depeg-events"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; total: number };
    expect(body.events).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("rejects unknown stablecoin ID with 404", async () => {
    const db = mockD1([]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?stablecoin=<script>"));
    expect(res.status).toBe(404);
  });

  it("includes X-Data-Age header", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "depeg_events", rows: [row] },
    ]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events"));
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });

  it("uses latest successful sync timestamp for freshness headers", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "depeg_events", rows: [makeDepegRow({ started_at: now - 7 * 86400 })] },
      { match: "cron_runs", rows: [], first: { started_at: now - 45 } },
    ]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events"));
    const age = Number(res.headers.get("X-Data-Age"));
    expect(age).toBeLessThan(120);
  });
});
