import { describe, expect, it } from "vitest";
import { DailySocialSnapshotSchema, buildDailySocialAltText, buildDailySocialTweetText, dailySocialRowLabel, formatDailySocialShare, formatDailySocialValue, type DailySocialSnapshot } from "../daily-social";

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
    expect(formatDailySocialValue(0.123, "percentage-points", "expanded")).toBe("0.123 percentage points");
  });
  it("requires valid published provenance for visible grades", () => {
    const graded = { ...snapshot, safetyAsOf: now - 50, safetyPublicationId: "published",
      rows: [{ ...snapshot.rows[0], safetyGrade: "A+" }] };
    expect(DailySocialSnapshotSchema.safeParse(graded).success).toBe(true);
    for (const patch of [{ safetyAsOf: undefined }, { safetyPublicationId: undefined }, { safetyAsOf: now - 7201 },
      { safetyAsOf: now + 61 }, { rows: [{ ...snapshot.rows[0], safetyGrade: "AAA" }] }]) {
      expect(DailySocialSnapshotSchema.safeParse({ ...graded, ...patch }).success).toBe(false);
    }
  });
  it("keeps the complete grade before numeric scores in tweet and alt text", () => {
    const graded: DailySocialSnapshot = { ...snapshot, topic: "safety", unit: "score", safetyAsOf: now - 50,
      safetyPublicationId: "published", rows: [{ ...snapshot.rows[0], value: 84, safetyGrade: "A-" }] };
    expect(buildDailySocialTweetText(graded)).toContain("USDC (A-) 84/100");
    expect(buildDailySocialAltText(graded)).toContain("USDC (A-): 84/100");
    expect(dailySocialRowLabel({ ...graded.rows[0], symbol: "ABCDEFGHIJKLMNOPQRST" }, 8)).toBe("ABCDEFGH (A-)");
  });
  it("shows actual before/after shares and validates their arithmetic", () => {
    const row = { ...snapshot.rows[0], shareBeforePct: 19.5, shareAfterPct: 19.623 };
    const paired = { ...snapshot, rows: [row] };
    expect(DailySocialSnapshotSchema.safeParse(paired).success).toBe(true);
    expect(buildDailySocialTweetText(paired)).toContain("19.50% → 19.62%");
    expect(buildDailySocialTweetText(paired)).not.toContain(" pp");
    expect(formatDailySocialShare({ ...row, shareBeforePct: 0.0011, shareAfterPct: 0.0012 })).toBe("0.0011% → 0.0012%");
    for (const patch of [{ shareBeforePct: undefined }, { shareAfterPct: 101 }, { shareAfterPct: 21 }]) {
      expect(DailySocialSnapshotSchema.safeParse({ ...snapshot, rows: [{ ...row, ...patch }] }).success).toBe(false);
    }
  });
  it("preserves frozen copy for legacy ungraded snapshots", () => {
    expect(buildDailySocialTweetText(snapshot)).toBe("This week's market-share gainers\n\n1. USDC 0.123 pp\n\npharos.watch #Stablecoins");
    expect(buildDailySocialAltText(snapshot)).toBe("This week's market-share gainers. Comparable cohort · 7 days. Data as of 2026-09-10T11:58:20.000Z. USDC: 0.123 pp; 22% share today. Same cohort at both dates. Source: Pharos.");
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
