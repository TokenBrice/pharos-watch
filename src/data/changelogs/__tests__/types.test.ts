import { describe, expect, it } from "vitest";
import type { ChangelogEntry } from "../types";

describe("ChangelogEntry type", () => {
  it("accepts a well-formed entry", () => {
    const entry: ChangelogEntry = {
      dateRange: { from: "2026-03-17", to: "2026-03-24" },
      summary: [{ label: "Broader coverage", description: "DUSD, USSD, USBD added", tag: "coverage" }],
      stats: { totalCommits: 42 },
      commits: [{ hash: "abc1234", message: "feat: add DUSD" }],
    };

    expect(entry.dateRange.from).toBe("2026-03-17");
    expect(entry.summary).toHaveLength(1);
    expect(entry.stats.totalCommits).toBe(42);
    expect(entry.commits[0].hash).toBe("abc1234");
  });
});
