import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { collectSourceFiles } from "./source-files.mts";
import { getScriptKind } from "./ts-ast.mts";
import type { IsolateLocalStateRegistryEntry } from "@shared/lib/isolate-local-state-registry";

export interface IsolateLocalStateCandidate {
  sourcePath: string;
  stateName: string;
}

const STATE_DIRECTORIES = ["worker/src", "shared/lib", "functions"];
const MUTABLE_CONSTRUCTOR = /new (?:Map|Set|WeakMap|WeakSet|IsolateLocalState)\b/;
const RECORDER_FACTORY = /createBufferedAttributionRecorder\b/;
const STATEFUL_CONTAINER_NAME = /(cache|counter|key|limiter|limit|state|promise|initialization|window|secret|queue|buffer|pending|inflight)/i;
// Any object/array literal assignment can initialise a stateful container, for
// any declared name or type annotation. Comments may sit between `=` and the
// literal, so a comment immediately before the literal is its own hint.
// Parsing a few extra files is harmless; skipping one would silently drop the
// declaration from the guard.
const LITERAL_ASSIGNMENT = /=\s*[\[{]/;
const COMMENTED_LITERAL = /(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*\n?)\s*[\[{]/;
// Cheap superset of every candidate declaration below. Whole-tree parsing plus
// parent-pointer construction is the expensive part of this guard; files
// without a plausible declaration marker cannot produce a candidate.
const CANDIDATE_TEXT_HINTS = [
  MUTABLE_CONSTRUCTOR,
  RECORDER_FACTORY,
  /\blet\s/,
  LITERAL_ASSIGNMENT,
  COMMENTED_LITERAL,
];

const STATE_SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);
const STATE_SCAN_EXCLUDED_DIRS = new Set(["__tests__", "__mocks__", "test-helpers"]);

function listSourceFiles(root: string, sourcePath: string): string[] {
  return collectSourceFiles(resolve(root, sourcePath), {
    extensions: STATE_SCAN_EXTENSIONS,
    excludedDirs: STATE_SCAN_EXCLUDED_DIRS,
  });
}

function rootIdentifier(expression: ts.Expression): string | null {
  let current: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isStatefulInitializer(initializer: ts.Expression, name: string, isLet: boolean, source: ts.SourceFile): boolean {
  const text = initializer.getText(source);
  return MUTABLE_CONSTRUCTOR.test(text)
    || RECORDER_FACTORY.test(text)
    || ((ts.isObjectLiteralExpression(initializer) || ts.isArrayLiteralExpression(initializer))
      && STATEFUL_CONTAINER_NAME.test(name))
    || isLet;
}

function isMutationOfCandidate(node: ts.Node, candidates: Map<string, boolean>, insideFunction: boolean): void {
  if (!insideFunction) return;
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    if (["set", "add", "delete", "clear", "push", "reset"].includes(method)) {
      const name = rootIdentifier(node.expression.expression);
      if (name && candidates.has(name)) candidates.set(name, true);
    }
  }

  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    const name = rootIdentifier(node.left);
    if (name && candidates.has(name)) candidates.set(name, true);
  }

  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    const name = rootIdentifier(node.operand);
    if (name && candidates.has(name)) candidates.set(name, true);
  }
}

function findCandidatesInFile(root: string, file: string): IsolateLocalStateCandidate[] {
  const sourcePath = relative(root, file);
  const text = readFileSync(file, "utf8");
  if (!CANDIDATE_TEXT_HINTS.some((hint) => hint.test(text))) return [];
  const source = ts.createSourceFile(
    sourcePath,
    text,
    ts.ScriptTarget.Latest,
    false,
    getScriptKind(file),
  );
  const candidates = new Map<string, boolean>();

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isLet = (statement.declarationList.flags & ts.NodeFlags.Let) !== 0;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const name = declaration.name.text;
      if (isStatefulInitializer(declaration.initializer, name, isLet, source)) {
        candidates.set(name, RECORDER_FACTORY.test(declaration.initializer.getText(source)));
      }
    }
  }

  // Without parent pointers, track function nesting while visiting instead of
  // walking ancestors for every node.
  const visit = (node: ts.Node, functionDepth: number): void => {
    const depth = functionDepth + Number(ts.isFunctionLike(node));
    isMutationOfCandidate(node, candidates, depth > 0);
    ts.forEachChild(node, (child) => visit(child, depth));
  };
  visit(source, 0);

  return [...candidates]
    .filter(([, isMutated]) => isMutated)
    .map(([stateName]) => ({ sourcePath, stateName }));
}

export function findUnregisteredIsolateLocalState(
  registry: readonly IsolateLocalStateRegistryEntry[],
  options: { root: string; sourceFiles?: readonly string[] },
): IsolateLocalStateCandidate[] {
  const files = options.sourceFiles ?? STATE_DIRECTORIES.flatMap((directory) => listSourceFiles(options.root, directory));
  const registered = new Set(
    registry.flatMap((entry) => entry.stateNames.map((stateName) => `${entry.sourcePath}:${stateName}`)),
  );

  return files
    .flatMap((file) => findCandidatesInFile(options.root, file))
    .filter((candidate) => !registered.has(`${candidate.sourcePath}:${candidate.stateName}`));
}

export function assertIsolateLocalStateRegistryComplete(
  registry: readonly IsolateLocalStateRegistryEntry[],
  options: { root: string; sourceFiles?: readonly string[] },
): void {
  const unregistered = findUnregisteredIsolateLocalState(registry, options);
  if (unregistered.length === 0) return;
  throw new Error(
    `Unregistered isolate-local module state:\n${unregistered
      .map((candidate) => `- ${candidate.sourcePath}: ${candidate.stateName}`)
      .join("\n")}`,
  );
}
