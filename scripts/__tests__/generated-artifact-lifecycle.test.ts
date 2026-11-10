import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import { cachedGlobMatcher } from "../lib/glob-matcher.mts";
import { collectModuleSpecifiers, resolveModuleSpecifier } from "../lib/pr-import-graph.mts";
import { V9_SCORE_INPUT_DATA_PATHS } from "../lib/safety-score-v9-evaluation-inputs.mts";
import { describe, expect, it } from "vitest";
import { buildGeneratedArtifactPhases as phases, GENERATED_ARTIFACT_REGISTRY, selectCheckableArtifactIds } from "../lib/automation-registry.mjs";

interface Artifact {
  id: string;
  script: string;
  phase: number;
  dependsOn?: string[];
  importExceptions?: { outputPath: string; reason: string }[];
  [field: string]: unknown;
  outputPaths: string[];
}

const registry = GENERATED_ARTIFACT_REGISTRY as Artifact[];
const selectedIds = (options: Record<string, unknown>) =>
  (phases(options) as { artifacts: { id: string }[] }[]).flatMap(({ artifacts }) => artifacts.map((a) => a.id));

const catalog = "stablecoin-catalog", detail = "stablecoin-detail-snapshots", manifest = "safety-score-v9-evaluation-build";
const projection = "stablecoin-client-projections";

describe("PR dataset integrity commands", () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])(
    "commands for check=%s integrityOnly=%s", (check, integrityOnly) => {
      const plan = (integrityOnly = false) => phases({ check, integrityOnly, only: ["public-datasets", "runbook-index"] })
        .flatMap(({ artifacts }) => artifacts);
      expect(plan(integrityOnly).map(({ command }) => command)).toEqual(plan().map(({ id, command }) =>
        command + (check && integrityOnly && id === "public-datasets" ? " --integrity-only" : "")));
    },
  );
});

describe("generated artifact lifecycle", () => {
  it("uses offline snapshots for bootstrap and live generation only after refresh", () => {
    const snapshot = (options: Record<string, unknown>) => phases(options)
      .flatMap((p) => p.artifacts).find((a) => a.id === detail)!;
    expect(snapshot({ bootstrap: true }).command).toContain("PHAROS_DETAIL_SNAPSHOT_BOOTSTRAP=1");
    expect(snapshot({ buildLifecycles: ["compile-input"] })).toBeUndefined();
    expect(snapshot({ buildLifecycles: ["post-refresh"] }).command).toBe(
      "node --import tsx scripts/build-data/build-stablecoin-detail-snapshots.ts",
    );
    expect(snapshot({ check: true }).command).toContain("PHAROS_DETAIL_SNAPSHOT_CHECK=1");
    expect(selectedIds({ only: [detail] })).toEqual([catalog, detail]);
    expect(registry.filter((a) => a.bootstrap).flatMap((a) => a.outputPaths)
      .filter((path) => /[*?\[\]{}]/.test(path))).toEqual([]);
  });

  it("leaves authored root instructions outside generated artifact ownership", () => {
    for (const path of ["AGENTS.md", "CLAUDE.md"]) expect(registry.flatMap((a) => a.outputPaths)).not.toContain(path);
  });

  it("records the atomic writer as a source of every artifact that publishes through it", () => {
    for (const id of [catalog, "stablecoin-client-registry"]) {
      expect(registry.find((a) => a.id === id)?.sourcePaths).toContain("scripts/lib/atomic-artifact-write.mts");
    }
  });

  it("materializes ignored compile and serve inputs during bootstrap and their Pages phases", () => {
    const pages = ["case-study-client-index", "changelog-registry"];
    expect(selectedIds({ bootstrap: true })).toEqual(expect.arrayContaining([...pages, "llms-txt"]));
    expect(selectedIds({ buildLifecycles: ["compile-input"] })).toEqual(expect.arrayContaining(pages));
    expect(selectedIds({ buildLifecycles: ["post-refresh"] })).toContain("llms-txt");
  });
});

describe("check-mode artifact selection", () => {
  it("excludes bootstrap projections only from automatic drift plans, not explicit checks", () => {
    const projections = [
      catalog, "postman", "openapi", "world-map", "report-card-registry-fingerprint",
      "legacy-stablecoin-redirects", "stablecoin-client-registry", "stablecoin-worker-full-catalog",
      projection, "depeg-event-search-data",
      "case-study-client-index", "llms-txt", "changelog-registry",
    ];
    expect(registry.filter((a) => a.ciDriftCheck === false).map((a) => a.id).sort())
      .toEqual([...projections, manifest].sort());
    expect(selectCheckableArtifactIds([...projections, "runbook-index", manifest]))
      .toEqual(["runbook-index"]);
    for (const id of projections) {
      expect(registry.find((a) => a.id === id)).toMatchObject({ bootstrap: true, checkable: true });
      expect(selectedIds({ check: true, only: [id] })).toContain(id);
      expect(selectedIds({ bootstrap: true })).toContain(id);
    }
  });

  it("does not pull an unverifiable artifact in as a check-mode dependency", () => {
    const unverifiable = new Set(registry.filter((a) => a.checkable === false).map((a) => a.id));
    expect(selectedIds({ check: true }).filter((id) => unverifiable.has(id))).toEqual([]);
  });
});

// shortcut: guard require/computed/fs inputs when added.
function producerEdges(artifacts = registry, read = (file: string) => readFileSync(file, "utf8")) {
  const owner = (file: string) => artifacts.find((a) => a.outputPaths.some((p) =>
    file === p || file.startsWith(`${p}/`) || cachedGlobMatcher(p)(file)));
  const virtual = (file: string) => !!owner(relative(process.cwd(), file));
  const fs = {
    readFileSync,
    existsSync: (file: string) => virtual(file) || existsSync(file),
    statSync: (file: string) => virtual(file) ? { isFile: () => true } : statSync(file),
  };
  const errors: string[] = [];
  for (const a of artifacts) {
    const deps = new Set(a.dependsOn), seen = new Set<string>(), unused = new Set(a.importExceptions);
    for (const id of deps) artifacts.find((p) => p.id === id)?.dependsOn?.forEach((id) => deps.add(id));
    const walk = (file: string, chain: string[]) => {
      const p = owner(file);
      if (p) {
        const ex = a.importExceptions?.find((e) => e.outputPath === file);
        if (ex) {
          expect(ex.reason.trim()).not.toBe("");
          unused.delete(ex);
        } else if (!deps.has(p.id) || !(p.phase < a.phase)) {
          errors.push(`${a.id} phase ${a.phase}: ${chain.join(" -> ")} -> ${p.id} phase ${p.phase}`);
        }
        return;
      }
      if (seen.has(file) || !/\.[cm]?[jt]sx?$/.test(file)) return;
      seen.add(file);
      const parsed = collectModuleSpecifiers(read(file));
      if (parsed.unterminated || parsed.patterns.length) throw new Error(`Unsupported import: ${chain.join(" -> ")}`);
      for (const spec of parsed.specifiers) {
        // Avoid Vitest's package mocks.
        try {
          if (createRequire(resolve(file)).resolve(spec).includes("/node_modules/")) continue;
        } catch { /* Local alias. */ }
        const target = resolveModuleSpecifier(spec, file, { fs });
        if (target.kind === "unresolved") throw new Error([a.id, ...chain, target.reason].join(" -> "));
        if (target.kind === "file") walk(target.file, [...chain, target.file]);
      }
    };
    walk(a.script, [a.script]);
    if (a.id === manifest) {
      V9_SCORE_INPUT_DATA_PATHS.filter(owner).forEach((file) => walk(file, [a.script, file]));
    }
    expect([...unused], a.id).toEqual([]);
  }
  return errors;
}

describe("cold-output producer deps", () => {
  it("orders producers; consumes exceptions", () => {
    expect(producerEdges()).toEqual([]);
  });

  // Frozen closures: c21e7bb1b^, 323475db5^.
  it.each([[0, [], 2], [1, [catalog], 1], [1, [projection], 1]] as const)(
    "checks frozen sitemap phase %s", (phase, dependsOn, failures) => {
      const script = "scripts/maintenance/generate-sitemap-dates.ts";
      const errors = producerEdges([
        { id: "sitemap-dates", script, phase, dependsOn: [...dependsOn], outputPaths: [] },
        { script: "leaf.json", id: catalog, phase: 0, outputPaths: ["shared/data/stablecoins/coins.generated.json"] },
        { script: "leaf.json", id: projection, phase: 1, dependsOn: [catalog], outputPaths: ["src/generated/stablecoin-static-data.ts"] },
      ], () => 'import "@shared/data/stablecoins/coins.generated.json"; import "@/generated/stablecoin-static-data";');
      expect(errors).toHaveLength(failures);
      expect(errors.join()).toMatch(/sitemap-dates phase .*generate-sitemap-dates.* -> .* phase [01]/);
    },
  );
});
