import { describe, expect, it } from "vitest";
import { buildGeneratedArtifactPhases, GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";

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
});

describe("check-mode artifact selection", () => {
  it("does not pull an unverifiable artifact in as a check-mode dependency", () => {
    const unverifiable = new Set(
      registry.filter((artifact) => artifact.checkable === false).map((artifact) => artifact.id),
    );
    expect(selectedIds({ check: true }).filter((id) => unverifiable.has(id))).toEqual([]);
  });
});
