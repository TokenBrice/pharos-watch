import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import cemeteryDatasetExport from "../../../public/datasets/stablecoin-cemetery.json";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { GET as getCemeteryFeed } from "@/app/feed/cemetery.xml/route";
import { CEMETERY_DATASET_META, CEMETERY_FEED_MAX_ITEMS } from "@/lib/cemetery-dataset-meta";

const exported = cemeteryDatasetExport as {
  schemaVersion: string;
  license: string;
  sourceChecksum: string;
  rowCount: number;
  updatedAt?: string | null;
  rows: { recordedAt?: string | null }[];
};

describe("CEMETERY_DATASET_META", () => {
  it("mirrors the published export header", () => {
    expect(CEMETERY_DATASET_META).toMatchObject({
      schemaVersion: exported.schemaVersion,
      license: exported.license,
      sourceChecksum: exported.sourceChecksum,
    });
  });

  it("counts every exported row", () => {
    expect(CEMETERY_DATASET_META.rowCount).toBe(exported.rows.length);
  });

  it("dates the export by its latest recordedAt, or null when no row has one", () => {
    const recorded = exported.rows
      .map((row) => row.recordedAt)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .sort();
    expect(CEMETERY_DATASET_META.updatedAt).toBe(recorded.at(-1) ?? null);
    if (CEMETERY_DATASET_META.updatedAt !== null) {
      expect(CEMETERY_DATASET_META.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("shortens the sha256 checksum to its first 8 hex characters", () => {
    expect(CEMETERY_DATASET_META.sourceChecksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(CEMETERY_DATASET_META.sourceChecksumShort).toBe(CEMETERY_DATASET_META.sourceChecksum.slice(7, 15));
    expect(CEMETERY_DATASET_META.sourceChecksumShort).toMatch(/^[0-9a-f]{8}$/);
  });

  it("points downloads at published files and the feed at its route", () => {
    const root = process.cwd();
    expect(existsSync(path.join(root, "public", CEMETERY_DATASET_META.jsonUrl))).toBe(true);
    expect(existsSync(path.join(root, "public", CEMETERY_DATASET_META.csvUrl))).toBe(true);
    expect(existsSync(path.join(root, "src/app", CEMETERY_DATASET_META.rssUrl, "route.ts"))).toBe(true);
  });

  it("matches the item count the cemetery RSS feed actually publishes", async () => {
    const xml = await (await getCemeteryFeed()).text();
    const items = xml.match(/<item>/g) ?? [];
    expect(items).toHaveLength(Math.min(CEMETERY_FEED_MAX_ITEMS, CEMETERY_ENTRIES.length));
  });
});
