import { afterEach, describe, expect, it, vi } from "vitest";
import { DIGEST_BY_DATE, DIGEST_DATES, DIGEST_ENTRIES } from "@/lib/digest-registry";
import { DigestStoredSnapshotSchema } from "@shared/types/digest";

function storedEntry(
  date: string,
  generatedAt: number,
  digestType: "daily" | "weekly",
  editionNumber: number,
): Record<string, unknown> {
  return {
    date,
    title: `Edition ${editionNumber}`,
    text: "Summary",
    extended: "Extended summary",
    generatedAt,
    digestType,
    editionNumber,
  };
}

/**
 * The registry normalizes the checked-in artifact at module initialization, so
 * ordering and selection can only be observed by re-importing it against a
 * deliberately unsorted snapshot.
 */
async function loadRegistryWith(entries: readonly unknown[]) {
  vi.resetModules();
  vi.doMock("../../../data/digests.json", () => ({ default: entries }));
  return import("@/lib/digest-registry");
}

afterEach(() => {
  vi.doUnmock("../../../data/digests.json");
  vi.resetModules();
});

describe("digest registry", () => {
  it("sorts an unsorted snapshot newest-first and breaks generatedAt ties by date", async () => {
    const registry = await loadRegistryWith([
      storedEntry("2026-08-25", 1000, "daily", 5),
      storedEntry("2026-08-27-weekly", 3000, "weekly", 2),
      storedEntry("2026-08-26", 2000, "daily", 6),
      storedEntry("2026-08-24", 2000, "daily", 4),
    ]);

    expect(registry.DIGEST_ENTRIES.map((entry) => entry.date)).toEqual([
      "2026-08-27-weekly",
      "2026-08-26",
      "2026-08-24",
      "2026-08-25",
    ]);
    expect(registry.DIGEST_BY_DATE.get("2026-08-24")?.editionNumber).toBe(4);
    expect(registry.DIGEST_DATES.has("2026-08-27-weekly")).toBe(true);
  });

  it("selects the newest daily edition even when a weekly edition is newer", async () => {
    const registry = await loadRegistryWith([
      storedEntry("2026-08-25", 1000, "daily", 5),
      storedEntry("2026-08-27-weekly", 3000, "weekly", 2),
      storedEntry("2026-08-26", 2000, "daily", 6),
    ]);

    expect(registry.LATEST_DAILY_DIGEST?.date).toBe("2026-08-26");
    expect(registry.LATEST_DAILY_DIGEST?.digestType).toBe("daily");
  });

  it("falls back to the newest weekly edition when no daily edition exists", async () => {
    const registry = await loadRegistryWith([
      storedEntry("2026-08-20-weekly", 1000, "weekly", 1),
      storedEntry("2026-08-27-weekly", 3000, "weekly", 2),
    ]);

    expect(registry.LATEST_DAILY_DIGEST?.date).toBe("2026-08-27-weekly");
  });

  it("exposes an empty registry with no latest edition for an empty snapshot", async () => {
    const registry = await loadRegistryWith([]);

    expect(registry.DIGEST_ENTRIES).toEqual([]);
    expect(registry.DIGEST_BY_DATE.size).toBe(0);
    expect(registry.DIGEST_DATES.size).toBe(0);
    expect(registry.LATEST_DAILY_DIGEST).toBeUndefined();
  });

  it("derives lookup and markdown-date membership from the sorted registry", () => {
    expect(DIGEST_BY_DATE.size).toBe(DIGEST_ENTRIES.length);
    expect(DIGEST_DATES.size).toBe(DIGEST_ENTRIES.length);
    for (const entry of DIGEST_ENTRIES) {
      expect(DIGEST_BY_DATE.get(entry.date)).toBe(entry);
      expect(DIGEST_DATES.has(entry.date)).toBe(true);
    }
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
