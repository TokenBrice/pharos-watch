import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mts";
import { collectChangelogEntryFiles, renderChangelogRegistry } from "../maintenance/generate-changelog-registry";

const CHANGELOG_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../src/data/changelogs");
const INDEX_PATH = join(CHANGELOG_DIR, "index.ts");
const ENTRY_FILES = collectChangelogEntryFiles(
  readdirSync(CHANGELOG_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name),
);

describe("changelog registry generator", () => {
  it("includes every dated entry in the current ascending order with byte parity", () => {
    const dates = ENTRY_FILES.map((fileName) => fileName.slice(0, -5));
    const current = readFileSync(INDEX_PATH, "utf8");
    const imports = [...current.matchAll(/^import (e\d{8}) from "\.\/(\d{4}-\d{2}-\d{2})\.json";$/gm)];
    const registryEntries = [...current.matchAll(/^  (e\d{8}),$/gm)].map((match) => match[1]);

    expect(imports).toHaveLength(ENTRY_FILES.length);
    expect(imports.map((match) => match[2])).toEqual(dates);
    expect(registryEntries).toEqual(dates.map((date) => `e${date.replaceAll("-", "")}`));
    expect(renderChangelogRegistry(ENTRY_FILES)).toBe(current);
  });

  it("rejects duplicate and malformed entry filenames", () => {
    expect(() => collectChangelogEntryFiles(["2026-08-23.json", "2026-08-23.json"])).toThrow(/duplicate/i);
    expect(() => collectChangelogEntryFiles(["2026-08-23.json", "2026-8-24.json"])).toThrow(/malformed/i);
    expect(() => collectChangelogEntryFiles(["2026-02-30.json"])).toThrow(/malformed/i);
    expect(() => collectChangelogEntryFiles(["2026-08-23.ts"])).toThrow(/malformed/i);
  });

  it("sorts entry filenames in the existing ascending barrel order", () => {
    expect(collectChangelogEntryFiles(["2026-08-23.json", "2026-03-08.json", "2026-07-05.json"])).toEqual([
      "2026-03-08.json",
      "2026-07-05.json",
      "2026-08-23.json",
    ]);
  });

  it("selects dated additions and deletions but not unrelated paths", () => {
    for (const path of ["src/data/changelogs/2027-01-03.json", "src/data/changelogs/2026-03-08.json", "src/data/changelogs/2026-03-08.ts"]) {
      expect(selectChangedGeneratedArtifactIds([path])).toContain("changelog-registry");
    }
    expect(selectChangedGeneratedArtifactIds(["public/logos/coin.png"])).not.toContain("changelog-registry");
    expect(GENERATED_ARTIFACT_REGISTRY.find((artifact) => artifact.id === "changelog-registry"))
      .toMatchObject({ autoStage: true, reproducibility: "deterministic" });
  });
});
