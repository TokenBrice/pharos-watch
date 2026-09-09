import { describe, expect, it } from "vitest";
import { DailySocialSnapshotSchema, buildDailySocialAltText, buildDailySocialTweetText, formatDailySocialValue, type DailySocialSnapshot } from "../daily-social";

const now = Date.parse("2026-09-10T12:00:00Z") / 1000;
const snapshot: DailySocialSnapshot = { schemaVersion: 1, editionDate: "2026-09-10", scheduledAt: now, capturedAt: now, asOf: now - 100,
  topic: "market-share", title: "This week's market-share gainers", subtitle: "Comparable cohort · 7 days", unit: "percentage-points",
  rows: [{ id: "usdc", name: "USD Coin", symbol: "USDC", value: 0.123, context: "22% share today" }], highlights: [], source: "Pharos", methodology: "Same cohort at both dates." };

describe("daily social publication contract", () => {
  it("requires real calendar dates, unique rows, finite values and dated evidence", () => {
    expect(DailySocialSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    for (const patch of [{ editionDate: "2026-02-30" }, { editionDate: "2026-09-09" }, { asOf: now + 100 },
      { rows: [] }, { rows: [snapshot.rows[0], snapshot.rows[0]] }, { rows: [{ ...snapshot.rows[0], value: Infinity }] }]) {
      expect(DailySocialSnapshotSchema.safeParse({ ...snapshot, ...patch }).success).toBe(false);
    }
  });
  it("reserves the link weight and space for non-ASCII asset symbols", () => {
    const unicode = { ...snapshot, rows: Array.from({ length: 5 }, (_, index) => ({ ...snapshot.rows[0], id: String(index), symbol: "界".repeat(20) })) };
    const tweet = buildDailySocialTweetText(unicode);
    const conservativeWeight = Array.from(tweet).reduce((sum, char) => sum + (char.codePointAt(0)! > 127 ? 2 : 1), 11);
    expect(conservativeWeight).toBeLessThanOrEqual(280);
    expect(tweet).toContain("0.123 pp");
  });
  it("preserves units and negative signs", () => {
    expect(formatDailySocialValue(-1234567, "usd")).toBe("-$1.23M");
    expect(formatDailySocialValue(0.123, "percentage-points")).toBe("0.123 pp");
    expect(formatDailySocialValue(84, "score")).toBe("84/100");
    expect(formatDailySocialValue(0, "count")).toBe("0");
  });
  it("produces deterministic bounded copy without cutting numeric facts", () => {
    const long = { ...snapshot, title: "A".repeat(70), rows: Array.from({ length: 5 }, (_, index) => ({ ...snapshot.rows[0], id: String(index), symbol: "SYMBOL".repeat(3), value: 123.123 })) };
    const tweet = buildDailySocialTweetText(long);
    expect(tweet.length).toBeLessThanOrEqual(280);
    expect(tweet).toBe(buildDailySocialTweetText(long));
    expect(tweet).toContain("123.123 pp");
    expect(buildDailySocialAltText(long).length).toBeLessThanOrEqual(1000);
  });
});
