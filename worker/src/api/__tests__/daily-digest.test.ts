import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeDigestRow } from "./helpers/fixtures";
import { handleDailyDigest } from "../daily-digest";

describe("handleDailyDigest", () => {
  it("returns 200 with digest: null when no data", async () => {
    const db = mockD1();
    const res = await handleDailyDigest(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { digest: null };
    expect(body.digest).toBeNull();
  });

  it("returns 200 with digest text when data exists", async () => {
    const row = makeDigestRow({
      input_data: JSON.stringify({
        activeDepegCount: 1,
        topDepegs: [{ symbol: "PMUSD", bps: -5284, mcapUsd: 65_000_000 }],
      }),
    });
    const db = mockD1([{ match: "daily_digest", rows: [row], first: row }]);
    const res = await handleDailyDigest(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      digest: string;
      digestTitle: string | null;
      digestExtended: string | null;
      generatedAt: number;
      riskSignal: { symbol: string; bps: number; severity: string } | null;
    };
    expect(body.digest).toBe(row.digest_text);
    expect(body.digestTitle).toBe(row.digest_title);
    expect(body.generatedAt).toBe(row.generated_at);
    expect(body.riskSignal).toMatchObject({ symbol: "PMUSD", bps: -5284, severity: "critical" });
  });

  it("includes X-Data-Age header when data exists", async () => {
    const row = makeDigestRow();
    const db = mockD1([{ match: "daily_digest", rows: [row], first: row }]);
    const res = await handleDailyDigest(db);
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });
});
