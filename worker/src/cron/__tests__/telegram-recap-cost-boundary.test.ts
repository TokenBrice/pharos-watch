import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/* eslint-disable security/detect-non-literal-fs-filename -- test-only traversal of repo-local imports. */

const ROOT = resolve(process.cwd().endsWith("/worker") ? process.cwd() : resolve(process.cwd(), "worker"), "..");
const ENTRY = resolve(ROOT, "worker/src/cron/telegram-recap-planner.ts");
const FORBIDDEN_PATH = /(?:^|\/)(?:daily-digest|weekly-recap|anthropic|openai|ai-request)(?:\.|\/)|\/cron\/digest\//i;
const NETWORK_OR_PROVIDER_CALL = /\bfetch\s*\(|\bfetchWithRetry\b|api\.anthropic\.com|api\.openai\.com/i;

function resolveSourceImport(fromFile: string, specifier: string): string | null {
  let candidate: string;
  if (specifier.startsWith("@shared/")) {
    candidate = resolve(ROOT, "shared", specifier.slice("@shared/".length));
  } else if (specifier.startsWith(".")) {
    candidate = resolve(dirname(fromFile), specifier);
  } else {
    return null;
  }
  const candidates = extname(candidate)
    ? [candidate]
    : [`${candidate}.ts`, `${candidate}.tsx`, resolve(candidate, "index.ts"), resolve(candidate, "index.tsx")];
  const match = candidates.find(existsSync);
  return match ? realpathSync(match) : null;
}

function collectRuntimeGraph(entry: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (file: string) => {
    const canonical = realpathSync(file);
    if (files.has(canonical)) return;
    const source = readFileSync(canonical, "utf8");
    files.set(canonical, source);
    const sourceFile = ts.createSourceFile(canonical, source, ts.ScriptTarget.Latest, false);
    const imports: string[] = [];
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        if (statement.importClause?.isTypeOnly) continue;
        if (ts.isStringLiteral(statement.moduleSpecifier)) imports.push(statement.moduleSpecifier.text);
      } else if (
        ts.isExportDeclaration(statement)
        && !statement.isTypeOnly
        && statement.moduleSpecifier
        && ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        imports.push(statement.moduleSpecifier.text);
      }
    }
    for (const imported of imports) {
      const resolved = resolveSourceImport(canonical, imported);
      if (resolved) visit(resolved);
    }
  };
  visit(entry);
  return files;
}

describe("personalized recap hard cost boundary", () => {
  it("cannot reach AI provider or planning-network code through its import graph", () => {
    const graph = collectRuntimeGraph(ENTRY);
    const forbiddenPaths = [...graph.keys()].filter((file) => FORBIDDEN_PATH.test(file));
    const networkCalls = [...graph.entries()]
      .filter(([, source]) => NETWORK_OR_PROVIDER_CALL.test(source))
      .map(([file]) => file);

    expect(graph.size).toBeGreaterThan(5);
    expect(forbiddenPaths).toEqual([]);
    expect(networkCalls).toEqual([]);
  });
});
