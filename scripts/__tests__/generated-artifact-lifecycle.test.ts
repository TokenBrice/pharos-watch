import { describe, expect, it } from "vitest";
import { buildGeneratedArtifactPhases, GENERATED_ARTIFACT_REGISTRY, selectCheckableArtifactIds, selectGeneratedArtifacts } from "../lib/automation-registry.mjs";

// `automation-registry.mjs` is untyped JS, so give its shapes local names here.
interface RegistryArtifact {
  id: string;
  bootstrap?: boolean;
  checkable?: boolean;
  ciDriftCheck?: boolean;
  outputPaths: string[];
}

function selectedIds(options: Record<string, unknown>): string[] {
  return (buildGeneratedArtifactPhases(options) as { artifacts: RegistryArtifact[] }[]).flatMap(({ artifacts }) =>
    artifacts.map((artifact) => artifact.id),
  );
}

const registry = GENERATED_ARTIFACT_REGISTRY as RegistryArtifact[];

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

  it("leaves authored root instructions outside generated artifact ownership", () => {
    expect(registry.flatMap((artifact) => artifact.outputPaths)).not.toContain("AGENTS.md");
    expect(registry.flatMap((artifact) => artifact.outputPaths)).not.toContain("CLAUDE.md");
  });

  it("materializes ignored compile and serve inputs during bootstrap and their Pages phases", () => {
    const bootstrap = selectedIds({ bootstrap: true });
    const compile = selectedIds({ buildLifecycles: ["compile-input"] });
    const postRefresh = selectedIds({ buildLifecycles: ["post-refresh"] });
    expect(bootstrap).toEqual(expect.arrayContaining(["case-study-client-index", "changelog-registry", "llms-txt"]));
    expect(compile).toEqual(expect.arrayContaining(["case-study-client-index", "changelog-registry"]));
    expect(postRefresh).toContain("llms-txt");
  });
});

describe("check-mode artifact selection", () => {
  it("excludes bootstrap projections only from automatic drift plans, not explicit checks", () => {
    const projections = [
      "stablecoin-catalog", "postman", "openapi", "world-map", "report-card-registry-fingerprint",
      "legacy-stablecoin-redirects", "stablecoin-client-registry", "stablecoin-worker-full-catalog",
      "stablecoin-client-projections", "depeg-event-search-data",
      "case-study-client-index", "llms-txt", "changelog-registry",
    ];
    expect(registry.filter((artifact) => artifact.ciDriftCheck === false).map((artifact) => artifact.id).sort())
      .toEqual([...projections].sort());
    expect(selectCheckableArtifactIds([...projections, "runbook-index", "safety-score-v9-evaluation-build"]))
      .toEqual(["runbook-index", "safety-score-v9-evaluation-build"]);
    for (const id of projections) {
      expect(registry.find((artifact) => artifact.id === id)).toMatchObject({ bootstrap: true, checkable: true });
      expect(selectGeneratedArtifacts({ check: true, only: [id] }).map((artifact) => artifact.id)).toContain(id);
      expect(selectedIds({ bootstrap: true })).toContain(id);
    }
  });

  it("does not pull an unverifiable artifact in as a check-mode dependency", () => {
    const unverifiable = new Set(
      registry.filter((artifact) => artifact.checkable === false).map((artifact) => artifact.id),
    );
    expect(selectedIds({ check: true }).filter((id) => unverifiable.has(id))).toEqual([]);
  });
});
