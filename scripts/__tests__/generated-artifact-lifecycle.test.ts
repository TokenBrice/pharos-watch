import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGeneratedArtifactPhases, GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

function isGitIgnored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", path], { cwd: REPO_ROOT });
    return true;
  } catch {
    return false;
  }
}

// `automation-registry.mjs` is untyped JS, so give its shapes local names here.
interface RegistryArtifact {
  id: string;
  bootstrap?: boolean;
  checkable?: boolean;
  outputPaths: string[];
}

function selectedIds(options: Record<string, unknown>): string[] {
  return (buildGeneratedArtifactPhases(options) as { artifacts: RegistryArtifact[] }[]).flatMap(({ artifacts }) =>
    artifacts.map((artifact) => artifact.id),
  );
}

const registry = GENERATED_ARTIFACT_REGISTRY as RegistryArtifact[];

describe("generated artifact lifecycle", () => {
  it("keeps every gitignored artifact bootstrap-safe", () => {
    // A gitignored output only exists because `bootstrap:generated` wrote it.
    // An artifact that is ignored but not bootstrap-safe is missing from a
    // fresh clone and from every CI job, which surfaces as an import error.
    const offenders = registry
      .filter(
        (artifact) =>
          artifact.bootstrap !== true &&
          artifact.outputPaths.length > 0 &&
          artifact.outputPaths.every((path) => !path.includes("*") && isGitIgnored(path)),
      )
      .map((artifact) => artifact.id);

    expect(offenders).toEqual([]);
  });

  it("gitignores the report-card registry fingerprint projection", () => {
    expect(isGitIgnored("shared/data/stablecoins/report-card-registry-fingerprint.generated.ts")).toBe(true);
  });
});

describe("check-mode artifact selection", () => {
  it("omits build-time artifacts from check runs", () => {
    const ids = selectedIds({ check: true });
    expect(ids).not.toContain("sitemap-dates");
    expect(ids).not.toContain("docs-metadata");
  });

  it("still runs build-time artifacts in write mode", () => {
    const ids = selectedIds({});
    expect(ids).toContain("sitemap-dates");
    expect(ids).toContain("docs-metadata");
  });

  it("does not pull an unverifiable artifact in as a check-mode dependency", () => {
    const unverifiable = new Set(
      registry.filter((artifact) => artifact.checkable === false).map((artifact) => artifact.id),
    );
    expect(selectedIds({ check: true }).filter((id) => unverifiable.has(id))).toEqual([]);
  });
});
