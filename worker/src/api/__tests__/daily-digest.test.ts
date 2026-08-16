import { describe, it, expect } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { makeDigestRow } from "../../test-helpers/__shared/fixtures";
import { handleDailyDigest } from "../daily-digest";

describe("handleDailyDigest", () => {
  it("returns 200 with digest: null when no data", async () => {
    const db = mockD1([{ match: "FROM daily_digest", rows: [] }]);
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
        riskTape: [{ id: "risk-tape:depegs", label: "Depegs", value: "PMUSD 5284bps", tone: "critical" }],
        nextTriggers: [{
          id: "trigger:depeg:pmusd",
          label: "PMUSD depeg widening",
          metric: "depeg-bps",
          comparator: "abs-gte",
          thresholdLabel: "5500 bps off peg",
          thresholdValue: 5500,
          symbol: "PMUSD",
          rationale: "A wider deviation raises severity.",
          detail: "If PMUSD reaches 5500 bps off peg, severity rises.",
        }],
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
      riskTape: unknown[] | null;
      nextTriggers: unknown[] | null;
    };
    expect(body.digest).toBe(row.digest_text);
    expect(body.digestTitle).toBe(row.digest_title);
    expect(body.generatedAt).toBe(row.generated_at);
    expect(body.riskSignal).toMatchObject({ symbol: "PMUSD", bps: -5284, severity: "critical" });
    expect(body.riskTape).toHaveLength(1);
    expect(body.nextTriggers).toHaveLength(1);
  });

  it("includes X-Data-Age header when data exists", async () => {
    const row = makeDigestRow();
    const db = mockD1([{ match: "daily_digest", rows: [row], first: row }]);
    const res = await handleDailyDigest(db);
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });
});
