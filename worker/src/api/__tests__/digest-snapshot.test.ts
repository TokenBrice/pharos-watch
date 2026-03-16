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

  it("extracts last daily inputData from weekly recap input_data", async () => {
    const dayStart = Math.floor(new Date(`${todayStr}T00:00:00Z`).getTime() / 1000);
    const weeklyInputData = {
      weekStartDate: "2026-03-10",
      weekEndDate: "2026-03-16",
      dailyDigests: [
        { date: "2026-03-10", title: "Day 1", text: "...", inputData: { totalMcapUsd: 90e9, mcap7dDelta: 1 } },
        { date: "2026-03-14", title: "Day 5", text: "...", inputData: { totalMcapUsd: 95e9, mcap7dDelta: 3 } },
        { date: "2026-03-16", title: "Day 7", text: "...", inputData: { totalMcapUsd: 100e9, mcap7dDelta: 5 } },
      ],
    };
    const digestRow = {
      generated_at: dayStart + 3600,
      input_data: JSON.stringify(weeklyInputData),
    };
    const db = mockD1([
      { match: "daily_digest", rows: [digestRow] },
      { match: "depeg_events", rows: [] },
      { match: "blacklist_events", rows: [] },
    ]);
    const res = await handleDigestSnapshot(db, new URL(`https://x/api/digest-snapshot?date=${todayStr}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      inputData: { totalMcapUsd: number; mcap7dDelta: number } | null;
      prevInputData: { totalMcapUsd: number; mcap7dDelta: number } | null;
    };
    // Should extract last daily (end-of-week) as inputData
    expect(body.inputData?.totalMcapUsd).toBe(100e9);
    expect(body.inputData?.mcap7dDelta).toBe(5);
    // Should extract first daily (start-of-week) as prevInputData
    expect(body.prevInputData?.totalMcapUsd).toBe(90e9);
  });
});
