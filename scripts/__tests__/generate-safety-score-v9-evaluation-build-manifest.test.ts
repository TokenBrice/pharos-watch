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
  V9_SCORE_INPUT_DATA_PATHS,
  V9_SCORE_EVALUATOR_SOURCE_PATHS,
  buildV9EvaluationBuildManifest,
  collectV9EvaluationBuildSourcePaths,
  renderV9EvaluationBuildManifest,
} from "../maintenance/generate-safety-score-v9-evaluation-build-manifest";
import { createTempRepoTracker } from "./helpers/test-state";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EVALUATOR_ENTRY = "shared/lib/safety-score-v9/evaluate-set.ts";
const POLICY_ENTRY = "shared/lib/safety-score-v9/policy.ts";
// The evaluator embeds this generated digest; hashing it would be recursive.
const MANIFEST_PATH = "shared/data/safety-score-v9/evaluation-build-manifest-v1.ts";

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
  if (!importClause) return true;
  if (importClause.isTypeOnly) return false;
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
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier &&
      (!node.exportClause || !ts.isNamedExports(node.exportClause) ||
        node.exportClause.elements.some((element) => !element.isTypeOnly))) {
      const specifier = node.moduleSpecifier;
      if (ts.isStringLiteralLike(specifier)) imports.push(specifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier)) imports.push(specifier.text);
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
    if (!current || closure.has(current) || current === MANIFEST_PATH) continue;
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
      "worker/src/lib/safety-score-v9/fact-set.ts", "worker/src/lib/safety-score-v9/extension.ts",
      "worker/src/lib/evm-rpc.ts", "worker/src/lib/fetch-retry.ts",
      "shared/lib/p4-exit-route-capacity.ts", "shared/lib/redemption-backstops.ts",
    ]) {
      expect(selectChangedGeneratedArtifactIds([source]), source).not.toContain("safety-score-v9-evaluation-build");
    }
  });
  it("pins exactly the evaluator import graph, reviewed score inputs and catalog decoder", () => {
    const root = fixtureRoot();
    const paths = collectV9EvaluationBuildSourcePaths(root);
    const expected = [...new Set([
      ...collectRuntimeImportClosure(),
      ...V9_SCORE_INPUT_DATA_PATHS,
      "worker/src/lib/full-stablecoin-catalog.ts",
    ])].sort();
    expect(paths).toEqual(expected);
    expect(new Set(paths).size).toBe(paths.length);
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain(EVALUATOR_ENTRY);
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/compile.ts");
    expect(V9_SCORE_INPUT_DATA_PATHS).toContain("shared/data/safety-score-v9/reserve-bound-facts-v1.json");
    expect(V9_SCORE_INPUT_DATA_PATHS).toContain("shared/data/safety-score-v9/mechanism-review-overlays-v1.json");
    expect(paths).not.toContain("scripts/build-data/generate-worker-stablecoin-catalog.ts");
    expect(paths).not.toContain("shared/lib/__tests__/safety-score-v9-matched-invariants.test-support.ts");
    // Transfer rows and measurement registries are point-in-time fact inputs;
    // mechanism capture refs remain independently pinned by the manifest.
    expect(paths).not.toContain("shared/data/safety-score-v9/transfer-review-overlays-v1.json");
    expect(paths).not.toContain("shared/data/safety-score-v9/shock-coverage-measurements-v1.json");
    expect(paths).not.toContain("shared/data/safety-score-v9/shock-coverage-replay-attestations-v1.json");
    expect(buildV9EvaluationBuildManifest(root)).toEqual(buildV9EvaluationBuildManifest(root));
  });

  it("includes every executable evaluator admission schema leaf", () => {
    const paths = new Set<string>(V9_EVALUATION_BUILD_SOURCE_PATHS);
    for (const owner of [
      "shared/types/safety-score-v9-fact-input-primitives.ts",
      "shared/types/safety-score-v9-fact-primitives.ts",
      "shared/types/safety-score-v9-operational-resilience-primitives.ts",
    ]) {
      expect(paths.has(owner), owner).toBe(true);
    }
    expect(paths.has("shared/types/safety-score-v9-vocabulary.ts")).toBe(true);
    // This schema is executable through the evaluator's imported fact schemas,
    // even though scoring thresholds themselves come from validated policy.
    expect(paths.has("shared/types/safety-score-v9-grade.ts")).toBe(true);
  });

  it.each([
    "shared/types/safety-score-v9-fact-input-primitives.ts",
    "shared/types/safety-score-v9-operational-resilience-primitives.ts",
    "shared/types/safety-score-v9-vocabulary.ts",
    "shared/lib/safety-score-v9/score.ts",
    "shared/lib/math.ts",
    "shared/lib/business-calendars.ts",
    "shared/lib/safety-score-v9/gap-index.ts",
    "shared/lib/safety-score-v9/operational-market-depth.ts",
    "shared/lib/safety-score-v9/unavailability-roots.ts",
    "shared/data/safety-score-v9/chain-maturity-reviews-v1.ts",
    ...V9_SCORE_INPUT_DATA_PATHS,
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

  it("keeps the evaluator, compiler and policy runtime import closure complete", () => {
    const manifestPaths = Object.fromEntries(
      V9_EVALUATION_BUILD_SOURCE_PATHS.map((path) => [path, true] as const),
    ) as Record<string, true>;
    const missing = [...collectRuntimeImportClosure()]
      .filter((path) => !manifestPaths[path])
      .sort();
    expect(missing).toEqual([]);
  });

  it.each([
    "worker/src/lib/safety-score-v9/fact-set.ts",
    "worker/src/lib/safety-score-v9/extension.ts",
    "worker/src/cron/reserve-adapters/xdai-bridge.ts",
    "worker/src/lib/evm-rpc.ts",
    "worker/src/lib/fetch-retry.ts",
    "shared/lib/redemption-backstops.ts",
    "shared/lib/p4-exit-route-capacity.ts",
    "scripts/build-data/generate-worker-stablecoin-catalog.ts",
  ])("does not rotate identity for unpinned producer or tooling %s", (path) => {
    const root = fixtureRoot();
    const before = buildV9EvaluationBuildManifest(root);
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), "changed non-evaluator code\n");
    expect(buildV9EvaluationBuildManifest(root)).toEqual(before);
  });

  it("retains the latest per-mechanism capture hash and R2 key binding", () => {
    const root = fixtureRoot();
    const writeCapture = (mechanism: string, timestamp: number, sha256: string) => {
      const path = resolve(root,
        `shared/data/safety-score-v9/mechanism-measurements/${mechanism}/${timestamp}.summary.json`);
      mkdirSync(dirname(path), { recursive: true });
      const r2Key = `captures/${mechanism}/${timestamp}.json.gz`;
      writeFileSync(path, JSON.stringify({
        mechanism, date: String(timestamp), sha256, bytes: 1, r2Key,
        summary: { kind: "cdp-shock-coverage-measurement", block: { timestampUnix: timestamp } },
      }));
      return { sha256, r2Key };
    };
    writeCapture("a", 1, "1".repeat(64));
    const latest = writeCapture("a", 2, "2".repeat(64));
    const other = writeCapture("b", 1, "3".repeat(64));
    const before = buildV9EvaluationBuildManifest(root);
    expect(before.captures).toEqual([latest, other]);
    writeCapture("a", 1, "4".repeat(64));
    expect(buildV9EvaluationBuildManifest(root)).toEqual(before);
    const changed = writeCapture("a", 2, "5".repeat(64));
    const after = buildV9EvaluationBuildManifest(root);
    expect(after.captures).toEqual([changed, other]);
    expect(after.digest).not.toBe(before.digest);
  });

  it("fails when an enumerated contract disappears", () => {
    const root = fixtureRoot();
    rmSync(resolve(root, "shared/types/safety-score-v9.ts"));
    expect(() => buildV9EvaluationBuildManifest(root)).toThrow(/Missing.*safety-score-v9\.ts/);
  });
});
