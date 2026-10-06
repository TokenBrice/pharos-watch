import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { resolveLocalPackageImport } from "../lib/package-imports.mts";
import { parseAssignments, unquote } from "../lib/wrangler-toml.mjs";
import {
  V9_EVALUATION_BUILD_SOURCE_PATHS,
  buildV9EvaluationBuildManifest,
} from "../maintenance/generate-safety-score-v9-evaluation-build-manifest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EVALUATOR_ENTRY = "shared/lib/safety-score-v9/evaluate-asset.ts";
const POLICY_ENTRY = "shared/lib/safety-score-v9/policy.ts";
const IMPORT_CLOSURE_ALLOWLIST: Record<string, true> = {
  // Runtime schema helpers validate the evaluator's input envelope; they are
  // outside the selected score-bearing implementation closure.
  "shared/types/date-primitives.ts": true,
  "shared/types/methodology-envelope.ts": true,
  "shared/types/safety-score-v9-fact-input-primitives.ts": true,
  "shared/types/safety-score-v9-grade.ts": true,
  "shared/types/safety-score-v9-operational-resilience-primitives.ts": true,
  "shared/types/safety-score-v9-vocabulary.ts": true,
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

const OMITTED_SCORE_BEARING_SOURCE = "worker/src/lib/safety-score-v9/extension-supply.ts";

function fixtureRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "pharos-ver-010-"));
  for (const path of V9_EVALUATION_BUILD_SOURCE_PATHS) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), `${path}\n`);
  }
  mkdirSync(dirname(resolve(root, OMITTED_SCORE_BEARING_SOURCE)), { recursive: true });
  writeFileSync(resolve(root, OMITTED_SCORE_BEARING_SOURCE), "return supplyUsd / totalUsd;\n");
  return root;
}

// VER-010: an imported fact producer can change without changing the build manifest.
describe("VERITAS finding VER-010: evaluation build identity binds imported fact producers", () => {
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
    try {
      const before = buildV9EvaluationBuildManifest(root);
      writeFileSync(resolve(root, decoder), "changed decoder\n");
      const changedDecoder = buildV9EvaluationBuildManifest(root);
      expect(changedDecoder.digest).not.toBe(before.digest);
      writeFileSync(resolve(root, packed!), "changed full metadata\n");
      expect(buildV9EvaluationBuildManifest(root).digest).not.toBe(changedDecoder.digest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("changes when the imported supply-share producer changes", () => {
    const root = fixtureRoot();
    try {
      const before = buildV9EvaluationBuildManifest(root);
      writeFileSync(resolve(root, OMITTED_SCORE_BEARING_SOURCE), "return 0;\n");
      const after = buildV9EvaluationBuildManifest(root);

      expect(after.digest).not.toBe(before.digest);
      expect(after.files).toContainEqual(expect.objectContaining({ path: OMITTED_SCORE_BEARING_SOURCE }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
});
