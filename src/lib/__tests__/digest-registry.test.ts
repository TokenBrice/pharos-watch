import { afterEach, describe, expect, it, vi } from "vitest";
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
 * indexability is observed by re-importing it against a controlled snapshot.
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
  it("indexes weekly recaps only; daily editions are noindex from publication", async () => {
    const day = 86_400;
    const newest = 1_800_000_000;
    const registry = await loadRegistryWith([
      storedEntry("2026-10-10", newest, "daily", 3),
      storedEntry("2026-09-10", newest - 30 * day, "daily", 2),
      storedEntry("2026-08-01", newest - 70 * day, "weekly", 1),
    ]);

    expect(registry.INDEXABLE_DIGEST_ENTRIES.map((entry) => entry.date)).toEqual(["2026-08-01"]);
    expect(registry.isDigestIndexable(registry.DIGEST_BY_DATE.get("2026-10-10")!)).toBe(false);
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

it("retains the persisted model while parsing an archived edition", () => {
  const [entry] = DigestStoredSnapshotSchema.parse([{ date: "2026-09-12", title: "Title", text: "Text", extended: "", generatedAt: 1, llm: { servedModel: "claude-sonnet-5" } }]);
  expect(entry.llm?.servedModel).toBe("claude-sonnet-5");
});
