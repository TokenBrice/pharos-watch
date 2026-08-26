import { describe, expect, it } from "vitest";
import { DIGEST_BY_DATE, DIGEST_DATES, DIGEST_ENTRIES, LATEST_DAILY_DIGEST } from "@/lib/digest-registry";
import { DigestStoredSnapshotSchema } from "@shared/types/digest";

describe("digest registry", () => {
  it("normalizes checked-in artifacts into deterministic newest-first order", () => {
    for (let index = 1; index < DIGEST_ENTRIES.length; index += 1) {
      expect(DIGEST_ENTRIES[index - 1]!.generatedAt).toBeGreaterThanOrEqual(DIGEST_ENTRIES[index]!.generatedAt);
    }
  });

  it("derives lookup and markdown-date membership from the sorted registry", () => {
    expect(DIGEST_BY_DATE.size).toBe(DIGEST_ENTRIES.length);
    expect(DIGEST_DATES.size).toBe(DIGEST_ENTRIES.length);
    for (const entry of DIGEST_ENTRIES) {
      expect(DIGEST_BY_DATE.get(entry.date)).toBe(entry);
      expect(DIGEST_DATES.has(entry.date)).toBe(true);
    }
  });

  it("selects the first daily entry without assuming the JSON file order", () => {
    expect(LATEST_DAILY_DIGEST).toBe(
      DIGEST_ENTRIES.find((entry) => (entry.digestType ?? "daily") !== "weekly"),
    );
  });

  it("normalizes legacy snapshots that predate edition metadata", () => {
    const [entry] = DigestStoredSnapshotSchema.parse([{
      date: "2026-08-26",
      title: "Signal & Noise",
      text: "Summary",
      extended: "Extended summary",
      generatedAt: 1_777_075_200,
    }]);

    expect(entry).toMatchObject({ digestType: "daily", editionNumber: 0 });
  });
});
