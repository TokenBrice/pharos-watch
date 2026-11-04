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
// One vocabulary for the stateful-container name hint: the AST pass tests a
// declared name with it and the prefilter recognises the same names in text.
const STATEFUL_CONTAINER_KEYWORDS = "cache|counter|key|limiter|limit|state|promise|initialization|window|secret|queue|buffer|pending|inflight";
const STATEFUL_CONTAINER_NAME = new RegExp(STATEFUL_CONTAINER_KEYWORDS, "i");
// Parsing is the expensive part of this guard, so the prefilter has to be a
// cheap superset of every declaration the AST pass can report: any file it
// rejects must be provably free of candidates.
//
// The AST pass only inspects module-level variable statements, so the hints run
// against the statement text instead of the whole file: `new Map()` inside a
// function body is not a candidate, and neither is a stateful object literal
// nested in one. Statements start in column 0; their parameter lists, generic
// annotations and closing braces also do, so a statement ends at the first
// column-0 line terminated by `;` rather than at the next column-0 line —
// unless it has opened a brace it has not closed yet (see `moduleStatementEnd`).
// A declaration can also start mid-line: after another statement (`;`), a block
// boundary (`{`/`}`), or a leading block/line comment, and `export` may sit
// before a comment rather than directly before the keyword. A comment run never
// crosses a line break: a declaration that follows a multi-line comment starts
// its own line and matches the `^` alternative, while a run that crossed lines
// would swallow every declaration in between (a `//` inside a string is enough
// to start one).
const COMMENT_RUN = String.raw`(?:(?:/\*[\s\S]*?\*/|//[^\n]*)[ \t]*)*`;
// eslint-disable-next-line security/detect-non-literal-regexp -- interpolates the module-level comment-run fragment, not caller input
const MODULE_DECLARATION_START = new RegExp(
  String.raw`(?:^|[;{}][ \t]*)${COMMENT_RUN}(?:export[ \t]+${COMMENT_RUN})?(?:const|let|var)\b`,
  "gmu",
);
const MODULE_STATEMENT_END = /^\S[^\n]*;[ \t]*$/gm;
const COLUMN_ZERO_LINE = /^\S/m;
const LEADING_INDENT = /^[ \t]*(?=\S)/gm;
// A stateful-container name, an optional type annotation (which may contain
// `=>`, generics and newlines), optional comments, `=`, more optional comments,
// then the object/array literal. The name pattern omits the identifier prefix on
// purpose: matching resumes at the keyword inside the name, which keeps the
// Unicode case classes off the hot path for every statement.
// eslint-disable-next-line security/detect-non-literal-regexp -- interpolates the module-level keyword vocabulary, not caller input
const STATEFUL_LITERAL_DECLARATION = new RegExp(
  String.raw`(?:${STATEFUL_CONTAINER_KEYWORDS})[$\p{L}\p{N}_]*\s*(?::[\s\S]*?)?\s*(?:(?:/\*[\s\S]*?\*/|//[^\n]*)\s*)*=\s*(?:(?:/\*[\s\S]*?\*/|//[^\n]*)\s*)*[\[{]`,
  "iu",
);

const STATE_SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);
const STATE_SCAN_EXCLUDED_DIRS = new Set(["__tests__", "__mocks__", "test-helpers"]);

function listSourceFiles(root: string, sourcePath: string): string[] {
  return collectSourceFiles(resolve(root, sourcePath), {
    extensions: STATE_SCAN_EXTENSIONS,
    excludedDirs: STATE_SCAN_EXCLUDED_DIRS,
  });
}

export function listStateScanFiles(root: string): string[] {
  return STATE_DIRECTORIES.flatMap((directory) => listSourceFiles(root, directory));
}

// Address just past the column-0 line that terminates the module-level
// statement starting at `start`, or the end of the file when the statement has no
// terminating `;` (automatic semicolon insertion, a trailing declaration). An
// object type body written at column 0 terminates its first lines with `;` while
// the declaration is still open, so the statement keeps extending until the
// braces it opened balance.
function openBraces(text: string): number {
  let open = 0;
  for (const char of text) {
    if (char === "{") open += 1;
    if (char === "}" && open > 0) open -= 1;
  }
  return open;
}

function moduleStatementEnd(text: string, start: number): number {
  MODULE_STATEMENT_END.lastIndex = start;
  let end = MODULE_STATEMENT_END.exec(text);
  if (!end) return text.length;
  let stop = end.index + end[0].length;
  let open = openBraces(text.slice(start, stop));
  while (open > 0) {
    MODULE_STATEMENT_END.lastIndex = stop;
    end = MODULE_STATEMENT_END.exec(text);
    if (!end) return text.length;
    const next = end.index + end[0].length;
    // Count only the text added since the last stop, so the scan stays linear.
    open += openBraces(text.slice(stop, next));
    stop = next;
  }
  return stop;
}

// Statement shape, not absolute indentation, marks module level. A file written
// with a uniform leading indent (an inline fixture, say) is de-indented so its
// statements stay in column 0; hand-written sources already start in column 0,
// which this returns untouched.
function withoutCommonIndent(text: string): string {
  if (COLUMN_ZERO_LINE.test(text)) return text;
  const indents = text.match(LEADING_INDENT);
  if (indents === null) return text;
  let shortest = indents[0]!.length;
  for (const indent of indents) shortest = Math.min(shortest, indent.length);
  if (shortest === 0) return text;
  // eslint-disable-next-line security/detect-non-literal-regexp -- interpolates a measured indent width, not caller input
  return text.replace(new RegExp(String.raw`^[ \t]{${shortest}}`, "gm"), "");
}

/**
 * Cheap, allocation-light superset of the AST pass below. It must admit every
 * file holding a module-level declaration the AST pass can report; it may admit
 * more, but never less.
 */
export function matchesCandidatePrefilter(text: string): boolean {
  const source = withoutCommonIndent(text);
  // matchAll clones the pattern, so the shared lastIndex is never mutated.
  for (const match of source.matchAll(MODULE_DECLARATION_START)) {
    // The pattern consumes the `;`/`{`/`}` this declaration follows, so the
    // statement itself starts after it.
    const start = /^[;{}]/.test(match[0]) ? match.index + 1 : match.index;
    const statement = source.slice(start, moduleStatementEnd(source, start));
    if (MUTABLE_CONSTRUCTOR.test(statement) || RECORDER_FACTORY.test(statement)) return true;
    // A `let` declaration is a candidate whatever its initializer looks like.
    if (match[0].endsWith("let") && statement.includes("=")) return true;
    // A literal candidate always names a stateful container, so the cheap
    // vocabulary screens statements before the annotated-match regex runs.
    if (STATEFUL_CONTAINER_NAME.test(statement) && STATEFUL_LITERAL_DECLARATION.test(statement)) return true;
  }
  return false;
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

function parseSource(sourcePath: string, file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, false, getScriptKind(file));
}

// Module-level declarations the AST pass recognises, keyed by name and seeded
// with whether the initializer already implies mutation through the recorder
// factory. This is the authority the prefilter must never narrow.
function statefulDeclarations(source: ts.SourceFile): Map<string, boolean> {
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
  return candidates;
}

function markMutations(source: ts.SourceFile, candidates: Map<string, boolean>): void {
  // Without parent pointers, track function nesting while visiting instead of
  // walking ancestors for every node.
  const visit = (node: ts.Node, functionDepth: number): void => {
    const depth = functionDepth + Number(ts.isFunctionLike(node));
    isMutationOfCandidate(node, candidates, depth > 0);
    ts.forEachChild(node, (child) => visit(child, depth));
  };
  visit(source, 0);
}

/**
 * Every module-level state declaration the AST pass recognises, mutated or not.
 * A file this reports a declaration for must also pass the prefilter; the
 * real-tree test asserts exactly that.
 */
export function findModuleStateDeclarations(root: string, file: string): IsolateLocalStateCandidate[] {
  const sourcePath = relative(root, file);
  const source = parseSource(sourcePath, file, readFileSync(file, "utf8"));
  return [...statefulDeclarations(source).keys()].map((stateName) => ({ sourcePath, stateName }));
}

function findCandidatesInFile(root: string, file: string, text: string): IsolateLocalStateCandidate[] {
  const sourcePath = relative(root, file);
  const source = parseSource(sourcePath, file, text);
  const declarations = statefulDeclarations(source);
  markMutations(source, declarations);
  return [...declarations]
    .filter(([, isMutated]) => isMutated)
    .map(([stateName]) => ({ sourcePath, stateName }));
}

export function findUnregisteredIsolateLocalState(
  registry: readonly IsolateLocalStateRegistryEntry[],
  options: { root: string; sourceFiles?: readonly string[] },
): IsolateLocalStateCandidate[] {
  const files = options.sourceFiles ?? listStateScanFiles(options.root);
  const registered = new Set(
    registry.flatMap((entry) => entry.stateNames.map((stateName) => `${entry.sourcePath}:${stateName}`)),
  );

  return files
    .flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return matchesCandidatePrefilter(text) ? findCandidatesInFile(options.root, file, text) : [];
    })
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
