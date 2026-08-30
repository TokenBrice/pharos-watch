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
    expect(ENTRY_FILES).toHaveLength(26);
    expect(ENTRY_FILES[0]).toBe("2026-03-08.ts");
    expect(ENTRY_FILES[ENTRY_FILES.length - 1]).toBe("2026-08-30.ts");

    const dates = ENTRY_FILES.map((fileName) => fileName.slice(0, -3));
    const current = readFileSync(INDEX_PATH, "utf8");
    const imports = [...current.matchAll(/^import \{ entry as (e\d{8}) \} from "\.\/(\d{4}-\d{2}-\d{2})";$/gm)];
    const registryEntries = [...current.matchAll(/^  (e\d{8}),$/gm)].map((match) => match[1]);

    expect(imports).toHaveLength(ENTRY_FILES.length);
    expect(imports.map((match) => match[2])).toEqual(dates);
    expect(registryEntries).toEqual(dates.map((date) => `e${date.replaceAll("-", "")}`));
    expect(renderChangelogRegistry(ENTRY_FILES)).toBe(current);
  });

  it("rejects duplicate and malformed entry filenames", () => {
    expect(() => collectChangelogEntryFiles(["2026-08-23.ts", "2026-08-23.ts"])).toThrow(/duplicate/i);
    expect(() => collectChangelogEntryFiles(["2026-08-23.ts", "2026-8-24.ts"])).toThrow(/malformed/i);
    expect(() => collectChangelogEntryFiles(["2026-02-30.ts"])).toThrow(/malformed/i);
  });

  it("sorts entry filenames in the existing ascending barrel order", () => {
    expect(collectChangelogEntryFiles(["2026-08-23.ts", "2026-03-08.ts", "2026-07-05.ts"])).toEqual([
      "2026-03-08.ts",
      "2026-07-05.ts",
      "2026-08-23.ts",
    ]);
  });

  it("registers the generated barrel as an auto-staged deterministic artifact", () => {
    expect(GENERATED_ARTIFACT_REGISTRY).toContainEqual(
      expect.objectContaining({
        id: "changelog-registry",
        autoStage: true,
        buildLifecycle: "maintenance-only",
        checkCommand: "node --import tsx scripts/maintenance/generate-changelog-registry.ts --check",
        command: "node --import tsx scripts/maintenance/generate-changelog-registry.ts",
        outputPaths: ["src/data/changelogs/index.ts"],
        reproducibility: "deterministic",
        script: "scripts/maintenance/generate-changelog-registry.ts",
        sourcePaths: ["scripts/maintenance/generate-changelog-registry.ts", "src/data/changelogs/*.ts"],
      }),
    );
    expect(selectChangedGeneratedArtifactIds(["src/data/changelogs/2026-08-23.ts"])).toContain("changelog-registry");
  });
});
