import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sortCemeteryCoins } from "@shared/lib/cemetery";
import { buildFrozenCemeteryProjection, CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const DATASET = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "public/datasets/stablecoin-cemetery.json"), "utf8"),
) as {
  schemaVersion: string;
  sourceData: { path: string; checksum: string; role: string }[];
  recordsOrderedBy: string;
  updatedAt: string | null;
  datasetFields: Record<string, string>;
  fields: Record<string, string>;
  rows: (Record<string, unknown> & { id: string; mechanismArchetype: string | null; recordedAt: string | null })[];
};
const CSV_HEADER = readFileSync(resolve(REPO_ROOT, "public/datasets/stablecoin-cemetery.csv"), "utf8").split("\n", 1)[0]!;

const FROZEN_PROJECTION_PATH = "shared/lib/cemetery-merged.ts#frozenCemeteryProjection";

describe("cemetery dataset provenance", () => {
  it("does not pin the whole tracked-stablecoin aggregate", () => {
    // Hashing coins.generated.json rotated this export on every live-coin
    // curation while no cemetery row moved, and published a checksum for a
    // gitignored path no external consumer can fetch.
    expect(DATASET.sourceData.map((source) => source.path)).not.toContain(
      "shared/data/stablecoins/coins.generated.json",
    );
  });

  it("pins the frozen-row projection the export actually consumes", () => {
    const entry = DATASET.sourceData.find((source) => source.path === FROZEN_PROJECTION_PATH);
    expect(entry).toBeDefined();
    expect(entry?.checksum).toBe(`sha256:${sha256Hex(stableJsonStringifyV1(buildFrozenCemeteryProjection()))}`);
  });

  it("preserves the independently reviewed WEMIX archive facts", () => {
    expect(buildFrozenCemeteryProjection().find((row) => row.id === "wemix-dollar-wemix"))
      .toMatchObject({ name: "WEMIX Dollar", symbol: "WEMIX$", causeOfDeath: "abandoned",
        deathDate: "2026-04", peakMcap: 22400000, archivedDataAvailable: true });
  });

  it("projects every frozen coin exactly once, ordered by id", () => {
    const ids = buildFrozenCemeteryProjection().map((entry) => entry.id);
    expect(ids).toEqual(FROZEN_STABLECOINS.map((coin) => coin.id).sort((a, b) => a.localeCompare(b)));
    expect(ids).toEqual([...new Set(ids)].sort((left, right) => left.localeCompare(right)));
    expect(buildFrozenCemeteryProjection().every((entry) => entry.archivedDataAvailable === true)).toBe(true);
  });
});

describe("cemetery dataset schema 1.1", () => {
  it("publishes rows in the shared cemetery sort order it documents", () => {
    expect(DATASET.rows.map((row) => row.id)).toEqual(
      sortCemeteryCoins(CEMETERY_ENTRIES, "newest").map((entry) => entry.id),
    );
    // The documented keys appear in the order the sort applies them.
    const keyOffsets = ["deathDate descending", "peakMcapUsd descending", "symbol ascending", "id ascending"]
      .map((key) => DATASET.recordsOrderedBy.indexOf(key));
    expect(keyOffsets.every((offset) => offset >= 0)).toBe(true);
    expect([...keyOffsets].sort((left, right) => left - right)).toEqual(keyOffsets);
  });

  it("exports mechanismArchetype and recordedAt from the source rows, null when absent", () => {
    const entriesById = new Map(CEMETERY_ENTRIES.map((entry) => [entry.id, entry]));
    for (const row of DATASET.rows) {
      const entry = entriesById.get(row.id);
      expect(row).toHaveProperty("mechanismArchetype");
      expect(row).toHaveProperty("recordedAt");
      expect(row.mechanismArchetype).toBe(entry?.mechanismArchetype ?? null);
      expect(row.recordedAt).toBe(entry?.recordedAt ?? null);
    }
  });

  it("dates the dataset by its latest recordedAt, not by any death date", () => {
    const recorded = DATASET.rows.flatMap((row) => (row.recordedAt === null ? [] : [row.recordedAt]));
    const latest = recorded.reduce<string | null>((max, value) => (max === null || value > max ? value : max), null);
    expect(DATASET.updatedAt).toBe(latest);
    expect(DATASET.datasetFields).toHaveProperty("updatedAt");
  });

  it("bumps the schema and describes every exported column in both formats", () => {
    expect(DATASET.schemaVersion).toBe("1.1");
    const describedFields = Object.keys(DATASET.fields).sort();
    for (const row of DATASET.rows) {
      expect(Object.keys(row).sort()).toEqual(describedFields);
    }
    expect(CSV_HEADER.split(",").sort()).toEqual(describedFields);
  });
});
