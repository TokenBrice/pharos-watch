import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mts";
import { resolveLocalPackageImport } from "../lib/package-imports.mts";
import { parseAssignments, unquote } from "../lib/wrangler-toml.mjs";
import {
  V9_EVALUATION_BUILD_DIGEST_DOMAIN,
  V9_EVALUATION_BUILD_SOURCE_PATHS,
  V9_FACT_PRODUCER_SOURCE_PATHS,
  V9_SCORE_EVALUATOR_SOURCE_PATHS,
  buildV9EvaluationBuildManifest,
  collectV9EvaluationBuildSourcePaths,
  renderV9EvaluationBuildManifest,
} from "../maintenance/generate-safety-score-v9-evaluation-build-manifest";
import { createTempRepoTracker } from "./helpers/test-state";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EVALUATOR_ENTRY = "shared/lib/safety-score-v9/evaluate-asset.ts";
const POLICY_ENTRY = "shared/lib/safety-score-v9/policy.ts";
const IMPORT_CLOSURE_ALLOWLIST: Record<string, true> = {
  // Runtime schema helpers validate the evaluator's input envelope; they are
  // outside the selected score-bearing implementation closure.
  "shared/types/date-primitives.ts": true,
  "shared/types/methodology-envelope.ts": true,
  // Public grade/weight consistency projection; scoring reads validated policy.
  "shared/types/safety-score-v9-grade.ts": true,
  "shared/types/validators.ts": true,
};

function resolveStaticImport(fromPath: string, specifier: string): string | null {
  const privateTarget = resolveLocalPackageImport(specifier, REPO_ROOT);
  if (!privateTarget && !specifier.startsWith(".") && !specifier.startsWith("@shared/")) return null;
  const base = privateTarget
    ? posix.normalize(privateTarget.slice(REPO_ROOT.length + 1))
    : specifier.startsWith("@shared/")
      ? `shared/${specifier.slice("@shared/".length)}`
      : posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const extension = extname(base);
  const candidates = extension
    ? [base, ...(extension === ".js" ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`] : [])]
    : [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.mts`,
        `${base}.json`,
        `${base}/index.ts`,
        `${base}/index.tsx`,
      ];
  return (
    candidates.find((candidate) => {
      const absolute = resolve(REPO_ROOT, candidate);
      return existsSync(absolute) && statSync(absolute).isFile();
    }) ?? null
  );
}

function hasRuntimeBindings(importClause: ts.ImportClause | undefined): boolean {
  if (!importClause || importClause.isTypeOnly) return false;
  if (importClause.name || importClause.namedBindings?.kind === ts.SyntaxKind.NamespaceImport) return true;
  if (importClause.namedBindings?.kind !== ts.SyntaxKind.NamedImports) return false;
  return importClause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function runtimeImports(path: string): string[] {
  const source = readFileSync(resolve(REPO_ROOT, path), "utf8");
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && hasRuntimeBindings(node.importClause)) {
      const specifier = node.moduleSpecifier;
      if (ts.isStringLiteralLike(specifier)) imports.push(specifier.text);
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      const specifier = node.moduleSpecifier;
      if (ts.isStringLiteralLike(specifier)) imports.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return imports;
}

function collectRuntimeImportClosure(): Set<string> {
  const closure = new Set<string>();
  const pending = [EVALUATOR_ENTRY, POLICY_ENTRY];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || closure.has(current)) continue;
    closure.add(current);
    for (const specifier of runtimeImports(current)) {
      const imported = resolveStaticImport(current, specifier);
      if (imported && !closure.has(imported)) pending.push(imported);
    }
  }
  return closure;
}

const roots = createTempRepoTracker("pharos-v9-build-manifest");
afterEach(() => roots.cleanup());

function fixtureRoot(): string {
  const root = roots.makeRoot();
  for (const path of V9_EVALUATION_BUILD_SOURCE_PATHS) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), `${path}\n`);
  }
  return root;
}

describe("Safety Score v9 evaluation-build manifest", () => {
  it("enrolls every fixed identity input and recursive capture summaries for regeneration", () => {
    for (const source of [...V9_EVALUATION_BUILD_SOURCE_PATHS,
      "shared/data/safety-score-v9/mechanism-measurements/one.summary.json",
      "shared/data/safety-score-v9/mechanism-measurements/nested/deleted.summary.json",
      "scripts/lib/mechanism-measurement/capture-summary.ts",
    ]) {
      expect(selectChangedGeneratedArtifactIds([source]), source).toContain("safety-score-v9-evaluation-build");
    }
    for (const source of ["shared/lib/cron-jobs.ts", "shared/lib/safety-score-v9/public.ts",
      "worker/src/lib/safety-score-v9/candidate.ts", "shared/data/safety-score-v9/transfer-review-overlays-v1.json",
    ]) {
      expect(selectChangedGeneratedArtifactIds([source]), source).not.toContain("safety-score-v9-evaluation-build");
    }
  });
  it("uses an explicit evaluator and fact-producer allowlist", () => {
    const root = fixtureRoot();
    const paths = collectV9EvaluationBuildSourcePaths(root);

    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/evaluate-set.ts");
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/formula.ts");
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/aggregation.ts");
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/scoped-risk.ts");
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/wrapper-risk.ts");
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/mechanism-profiles.ts");
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/operational-resilience.ts");
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/gap-index.ts");
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain(
      "shared/lib/safety-score-v9/operational-market-depth.ts",
    );
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/unavailability-roots.ts");
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain(
      "shared/data/safety-score-v9/chain-maturity-reviews-v1.ts",
    );
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain("worker/src/lib/safety-score-v9/fact-set.ts");
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain("shared/lib/p4-exit-route-capacity.ts");
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain("shared/lib/supply.ts");
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain("shared/lib/redemption-backstop-providers.ts");
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain("shared/lib/redemption-backstops.ts");
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain(
      "shared/lib/redemption-backstop-configs/offchain-issuer/major-issuers.ts",
    );
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain("shared/data/safety-score-v9/mechanism-review-overlays-v1.json");
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain(
      "shared/data/safety-score-v9/operational-resilience-overlays-v1.json",
    );
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain(
      "worker/src/lib/safety-score-v9/extension-operational-resilience.ts",
    );
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain("worker/src/lib/safety-score-v9/extension-transfer.ts");
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain("worker/src/lib/safety-score-v9/extension-shock.ts");
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain(
      "worker/src/lib/safety-score-v9/supply-attribution-contract.ts",
    );
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain(
      "worker/src/lib/safety-score-v9/wm-supply-observer.ts",
    );
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain(
      "worker/src/lib/safety-score-v9/supply-observation-primitives.ts",
    );
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain(
      "worker/src/lib/safety-score-v9/xaut-supply-attribution-contract.ts",
    );
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain(
      "worker/src/lib/safety-score-v9/xaut-supply-observer.ts",
    );
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain(
      "worker/src/lib/evm-rpc.ts",
    );
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain(
      "worker/src/lib/evm-selectors.ts",
    );
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain(
      "worker/src/lib/fetch-retry.ts",
    );
    expect(paths).toContain("shared/lib/safety-score-v9/score.ts");
    expect(paths).toContain("worker/src/lib/safety-score-v9/fact-set.ts");
    expect(paths).not.toContain("shared/lib/safety-score-v9/public.ts");
    expect(paths).not.toContain("shared/lib/safety-score-v9/coverage.ts");
    expect(paths).not.toContain("shared/lib/safety-score-v9/validation.ts");
    expect(paths).not.toContain("shared/lib/safety-score-v9/scenario-evaluator.ts");
    expect(paths).not.toContain("shared/lib/safety-score-v9-compiler.ts");
    expect(paths).not.toContain("shared/lib/safety-score-v9-research.ts");
    // Reviewed transfer rows are point-in-time facts. The loader/schema is
    // build-bound above; row contents are bound by the V9 fact-set digest.
    expect(paths).not.toContain("shared/data/safety-score-v9/transfer-review-overlays-v1.json");
    expect(paths).not.toContain("shared/data/safety-score-v9/shock-coverage-measurements-v1.json");
    expect(paths).not.toContain("shared/data/safety-score-v9/shock-coverage-replay-attestations-v1.json");
    expect(paths).not.toContain("shared/lib/__tests__/safety-score-v9-matched-invariants.test-support.ts");
    expect(paths).not.toContain("worker/src/lib/safety-score-v9/candidate.ts");
    expect(buildV9EvaluationBuildManifest(root)).toEqual(buildV9EvaluationBuildManifest(root));
  });

  it("includes runtime admission schema leaves and classifies public grade projection outside scoring", () => {
    const paths = new Set<string>(V9_EVALUATION_BUILD_SOURCE_PATHS);
    for (const owner of [
      "shared/types/safety-score-v9-fact-input-primitives.ts",
      "shared/types/safety-score-v9-fact-primitives.ts",
      "shared/types/safety-score-v9-operational-resilience-primitives.ts",
    ]) {
      expect(paths.has(owner), owner).toBe(true);
    }
    expect(paths.has("shared/types/safety-score-v9-vocabulary.ts")).toBe(true);
    // Grade thresholds/weights here validate public projections; the evaluator
    // reads its independently pinned validated methodology policy.
    expect(paths.has("shared/types/safety-score-v9-grade.ts")).toBe(false);
  });

  it.each([
    "shared/types/safety-score-v9-fact-input-primitives.ts",
    "shared/types/safety-score-v9-operational-resilience-primitives.ts",
    "shared/types/safety-score-v9-vocabulary.ts",
    "shared/lib/safety-score-v9/score.ts",
    "shared/lib/p4-exit-route-capacity.ts",
    "shared/lib/supply.ts",
    "shared/lib/redemption-backstop-providers.ts",
    "shared/lib/redemption-backstops.ts",
    "shared/lib/redemption-backstop-configs/offchain-issuer/major-issuers.ts",
    "shared/data/safety-score-v9/mechanism-review-overlays-v1.json",
    "shared/data/safety-score-v9/operational-resilience-overlays-v1.json",
    "shared/lib/redemption-backstop-scoring.ts",
    "shared/types/exit-route-identity.ts",
    "shared/lib/exit-route-output.ts",
    "shared/lib/safety-score-v9/gap-index.ts",
    "shared/lib/safety-score-v9/operational-market-depth.ts",
    "shared/lib/safety-score-v9/unavailability-roots.ts",
    "shared/data/safety-score-v9/chain-maturity-reviews-v1.ts",
    "worker/src/lib/safety-score-v9/supply-attribution.ts",
    "worker/src/lib/safety-score-v9/supply-attribution-contract.ts",
    "worker/src/lib/safety-score-v9/wm-supply-observer.ts",
    "worker/src/lib/safety-score-v9/supply-observation-primitives.ts",
    "worker/src/lib/safety-score-v9/xaut-supply-attribution-contract.ts",
    "worker/src/lib/safety-score-v9/xaut-supply-observer.ts",
    "worker/src/lib/evm-rpc.ts",
    "worker/src/lib/evm-selectors.ts",
    "worker/src/lib/fetch-retry.ts",
    "worker/src/lib/safety-score-v9/extension-supply.ts",
  ])("rotates build identity for score-bearing source %s", (path) => {
    const root = fixtureRoot();
    const before = buildV9EvaluationBuildManifest(root);
    expect(before.files).toContainEqual(expect.objectContaining({ path }));
    writeFileSync(resolve(root, path), `changed score-bearing contract ${path}\n`);
    const after = buildV9EvaluationBuildManifest(root);
    expect(after.domain).toBe(V9_EVALUATION_BUILD_DIGEST_DOMAIN);
    expect(after.digest).not.toBe(before.digest);
    expect(after.files.map((file) => file.path)).toContain(path);
    expect(renderV9EvaluationBuildManifest(after)).toContain(path);
    expect(renderV9EvaluationBuildManifest(after)).toContain(after.digest);
  });

  it("does not discover newly added operational files by name", () => {
    const root = fixtureRoot();
    const operational = resolve(root, "worker/src/lib/safety-score-v9-new-publication-step.ts");
    mkdirSync(dirname(operational), { recursive: true });
    writeFileSync(operational, "operational\n");
    const before = buildV9EvaluationBuildManifest(root);
    writeFileSync(operational, "changed operational code\n");
    expect(buildV9EvaluationBuildManifest(root)).toEqual(before);
  });

  it("binds the configured Worker full-catalog decoder and its transported complete bytes", () => {
    const configPath = resolve(REPO_ROOT, "worker/wrangler.toml");
    const alias = parseAssignments(readFileSync(configPath, "utf8"))
      .find((assignment) => assignment.section === "alias" && assignment.key === "#pharos-full-catalog");
    expect(alias).toBeDefined();
    const decoder = posix.normalize(posix.join("worker", unquote(alias?.value) ?? ""));
    expect(V9_EVALUATION_BUILD_SOURCE_PATHS).toContain(decoder);
    const packed = runtimeImports(decoder)
      .map((specifier) => resolveStaticImport(decoder, specifier))
      .find((path) => path?.endsWith("coins.worker-full.generated.json"));
    expect(packed).toBeDefined();
    expect(V9_EVALUATION_BUILD_SOURCE_PATHS).toContain(packed);
    const root = fixtureRoot();
    const before = buildV9EvaluationBuildManifest(root);
    writeFileSync(resolve(root, decoder), "changed decoder\n");
    const changedDecoder = buildV9EvaluationBuildManifest(root);
    expect(changedDecoder.digest).not.toBe(before.digest);
    writeFileSync(resolve(root, packed!), "changed full metadata\n");
    expect(buildV9EvaluationBuildManifest(root).digest).not.toBe(changedDecoder.digest);
  });

  it("keeps the evaluator and policy runtime import closure in the manifest", () => {
    const manifestPaths = Object.fromEntries(
      V9_EVALUATION_BUILD_SOURCE_PATHS.map((path) => [path, true] as const),
    ) as Record<string, true>;
    const missing = [...collectRuntimeImportClosure()]
      .filter((path) => !manifestPaths[path] && !IMPORT_CLOSURE_ALLOWLIST[path])
      .sort();
    expect(missing).toEqual([]);
  });

  it("pins runtime schema imports used by fact and incident admission", () => {
    for (const owner of [
      "shared/types/safety-score-v9-facts.ts",
      "shared/types/safety-score-v9-incidents.ts",
      "shared/types/safety-score-v9-operational-resilience.ts",
    ]) {
      for (const specifier of runtimeImports(owner)) {
        const dependency = resolveStaticImport(owner, specifier);
        if (dependency === null) continue;
        expect(
          (V9_EVALUATION_BUILD_SOURCE_PATHS as readonly string[]).includes(dependency) ||
          IMPORT_CLOSURE_ALLOWLIST[dependency] === true,
          `${owner}: ${dependency}`,
        ).toBe(true);
      }
    }
  });

  it("fails when an enumerated contract disappears", () => {
    const root = fixtureRoot();
    rmSync(resolve(root, "shared/types/safety-score-v9.ts"));
    expect(() => buildV9EvaluationBuildManifest(root)).toThrow(/Missing.*safety-score-v9\.ts/);
  });
});
