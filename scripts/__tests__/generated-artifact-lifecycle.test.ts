import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGeneratedArtifactPhases, GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";


const REPO_ROOT = resolve(import.meta.dirname, "../..");

function isGitIgnored(path: string, root = REPO_ROOT): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", path], { cwd: root, stdio: "pipe" });
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 1) return false;
    throw error;
  }
}

// `automation-registry.mjs` is untyped JS, so give its shapes local names here.
interface RegistryArtifact {
  id: string;
  buildLifecycle: "compile-input" | "post-refresh" | "maintenance-only";
  bootstrap?: boolean;
  checkable?: boolean;
  inputState?: string;
  outputPaths: string[];
}

/** Ids the `bootstrap:generated:history` npm script passes to `--only`. */
function historyBootstrapIds(): string[] {
  const scripts = (
    JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const only = /--only=([^\s"]+)/.exec(scripts["bootstrap:generated:history"] ?? "");
  return only ? only[1].split(",") : [];
}

function selectedIds(options: Record<string, unknown>): string[] {
  return (buildGeneratedArtifactPhases(options) as { artifacts: RegistryArtifact[] }[]).flatMap(({ artifacts }) =>
    artifacts.map((artifact) => artifact.id),
  );
}

const registry = GENERATED_ARTIFACT_REGISTRY as RegistryArtifact[];

function hasIgnoredOutput(artifact: RegistryArtifact, root = REPO_ROOT): boolean {
  return artifact.outputPaths.some((path) => !/[*?\[\]{}]/.test(path) && isGitIgnored(path, root));
}

describe("generated artifact lifecycle", () => {
  it("uses offline snapshots for bootstrap and live generation only after refresh", () => {
    const snapshot = (options: Record<string, unknown>) => buildGeneratedArtifactPhases(options)
      .flatMap(({ artifacts }) => artifacts).find((artifact) => artifact.id === "stablecoin-detail-snapshots")!;
    expect(snapshot({ bootstrap: true }).command).toContain("PHAROS_DETAIL_SNAPSHOT_BOOTSTRAP=1");
    expect(snapshot({ buildLifecycles: ["compile-input"] })).toBeUndefined();
    expect(snapshot({ buildLifecycles: ["post-refresh"] }).command).toBe(
      "node --import tsx scripts/build-data/build-stablecoin-detail-snapshots.ts",
    );
    expect(snapshot({ check: true }).command).toContain("PHAROS_DETAIL_SNAPSHOT_CHECK=1");
    expect(selectedIds({ only: ["stablecoin-detail-snapshots"] })).toEqual([
      "stablecoin-catalog", "stablecoin-detail-snapshots",
    ]);
    expect(registry.filter((artifact) => artifact.bootstrap).flatMap((artifact) => artifact.outputPaths)
      .filter((path) => /[*?\[\]{}]/.test(path))).toEqual([]);
  });

  it("materializes every gitignored artifact from one of the two bootstrap paths", () => {
    // A gitignored output only exists because a bootstrap wrote it. An ignored
    // artifact reachable from neither path is missing on a fresh clone and in
    // every CI job, which surfaces as an unresolved import rather than a
    // useful error. `bootstrap:generated` covers the ordinary projections;
    // `bootstrap:generated:history` covers the ones needing full git history,
    // which are deliberately kept out of the ordinary bootstrap because five
    // workflows run it on a shallow checkout.
    const historyIds = new Set(historyBootstrapIds());
    const offenders = registry
      .filter(
        (artifact) => artifact.bootstrap !== true && !historyIds.has(artifact.id) && hasIgnoredOutput(artifact),
      )
      .map((artifact) => artifact.id);

    expect(offenders).toEqual([]);
  });
});

describe("check-mode artifact selection", () => {
  it("does not pull an unverifiable artifact in as a check-mode dependency", () => {
    const unverifiable = new Set(
      registry.filter((artifact) => artifact.checkable === false).map((artifact) => artifact.id),
    );
    expect(selectedIds({ check: true }).filter((id) => unverifiable.has(id))).toEqual([]);
  });
});
