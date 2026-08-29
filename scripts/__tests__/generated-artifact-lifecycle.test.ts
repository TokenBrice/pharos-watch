import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

function isFullyGitIgnored(artifact: RegistryArtifact): boolean {
  return (
    artifact.outputPaths.length > 0 &&
    artifact.outputPaths.every((path) => !path.includes("*") && isGitIgnored(path))
  );
}

describe("generated artifact lifecycle", () => {
  it("declares one positive build lifecycle for every artifact", () => {
    expect(new Set(registry.map((artifact) => artifact.buildLifecycle))).toEqual(
      new Set(["compile-input", "post-refresh", "maintenance-only"]),
    );
    expect(registry.every((artifact) => artifact.buildLifecycle != null)).toBe(true);
  });

  it("selects only compile inputs for plain prebuild", () => {
    expect(selectedIds({ buildLifecycles: ["compile-input"] })).toEqual([
      "stablecoin-catalog",
      "sitemap-dates",
      "case-study-client-index",
      "docs-metadata",
      "postman",
      "openapi",
      "world-map",
      "report-card-registry-fingerprint",
      "legacy-stablecoin-redirects",
      "stablecoin-client-registry",
      "stablecoin-client-projections",
    ]);
  });

  it("classifies refresh-sensitive projections separately", () => {
    expect(
      registry.filter((artifact) => artifact.buildLifecycle === "post-refresh").map((artifact) => artifact.id),
    ).toEqual(["depeg-event-search-data", "llms-txt"]);
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
        (artifact) => artifact.bootstrap !== true && !historyIds.has(artifact.id) && isFullyGitIgnored(artifact),
      )
      .map((artifact) => artifact.id);

    expect(offenders).toEqual([]);
  });

  it("keeps the history bootstrap script in step with the build-time artifacts", () => {
    const buildTimeIds = registry
      .filter((artifact) => artifact.inputState === "build-time")
      .map((artifact) => artifact.id);

    expect([...historyBootstrapIds()].sort()).toEqual([...buildTimeIds].sort());
    expect(
      registry
        .filter((artifact) => historyBootstrapIds().includes(artifact.id))
        .every((artifact) => artifact.buildLifecycle === "compile-input"),
    ).toBe(true);
  });

  it("excludes build-time artifacts from the ordinary bootstrap", () => {
    // They need full git history; `bootstrap:generated` must stay safe to run
    // on the shallow checkouts several workflows use.
    const leaked = registry
      .filter((artifact) => artifact.inputState === "build-time" && artifact.bootstrap === true)
      .map((artifact) => artifact.id);

    expect(leaked).toEqual([]);
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
