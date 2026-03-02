import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleDigestSnapshot } from "../digest-snapshot";

const nowSec = Math.floor(Date.now() / 1000);
const todayStr = new Date(nowSec * 1000).toISOString().slice(0, 10);

describe("handleDigestSnapshot", () => {
  it("returns 400 when date param is missing", async () => {
    const db = mockD1();
    const res = await handleDigestSnapshot(db, new URL("https://x/api/digest-snapshot"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid date format", async () => {
    const db = mockD1();
    const res = await handleDigestSnapshot(db, new URL("https://x/api/digest-snapshot?date=not-a-date"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when no digest found for date", async () => {
    const db = mockD1([
      { match: "daily_digest", rows: [] },
    ]);
    const res = await handleDigestSnapshot(db, new URL(`https://x/api/digest-snapshot?date=${todayStr}`));
    expect(res.status).toBe(404);
  });

  it("returns 200 with snapshot data when digest exists", async () => {
    const dayStart = Math.floor(new Date(`${todayStr}T00:00:00Z`).getTime() / 1000);
    const digestRow = {
      generated_at: dayStart + 3600, // 1 hour after midnight
      input_data: JSON.stringify({ totalMcapUsd: 100e9, mcap7dDelta: 5 }),
    };
    const db = mockD1([
      { match: "daily_digest", rows: [digestRow] },
      { match: "depeg_events", rows: [] },
      { match: "blacklist_events", rows: [] },
    ]);
    const res = await handleDigestSnapshot(db, new URL(`https://x/api/digest-snapshot?date=${todayStr}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      date: string;
      inputData: Record<string, unknown>;
      depegEvents: unknown[];
      blacklistEvents: unknown[];
    };
    expect(body.date).toBe(todayStr);
    expect(body).toHaveProperty("inputData");
    expect(body).toHaveProperty("depegEvents");
    expect(body).toHaveProperty("blacklistEvents");
  });
});
