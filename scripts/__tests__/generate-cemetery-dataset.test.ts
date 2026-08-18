import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFrozenCemeteryProjection } from "@shared/lib/cemetery-merged";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const DATASET = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "public/datasets/stablecoin-cemetery.json"), "utf8"),
) as { sourceData: { path: string; checksum: string; role: string }[] };

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

  it("projects every frozen coin exactly once, ordered by id", () => {
    const ids = buildFrozenCemeteryProjection().map((entry) => entry.id);
    expect(ids).toEqual([...new Set(ids)].sort((left, right) => left.localeCompare(right)));
    expect(buildFrozenCemeteryProjection().every((entry) => entry.archivedDataAvailable === true)).toBe(true);
  });
});
