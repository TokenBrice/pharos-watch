/**
 * Shared TypeScript AST helpers for CI scanner scripts.
 *
 * All scripts that parse .ts/.tsx/.js/.mjs source with the TypeScript
 * compiler API should import getScriptKind and parseSourceFile from here
 * rather than re-implementing them locally.
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import ts from "typescript";

/**
 * Map a file extension to the TypeScript ScriptKind enum value.
 *
 * .tsx → TSX  |  .jsx → JSX  |  .ts / .mts / .cts → TS
 * .js / .mjs / .cjs → JS  |  anything else → TS (safe default for unknown types)
 *
 * Note: a retired client-import scanner previously mapped .jsx → TSX.
 * The canonical mapping uses JSX, which is the correct ScriptKind for
 * .jsx files (TSX is for TypeScript JSX; JSX is for JavaScript JSX).
 *
 * Getting this wrong is not cosmetic: parsing a .tsx file without ScriptKind.TSX
 * makes every JSX element a parse error, so scanners silently see an empty or
 * truncated AST instead of failing.
 */
export function getScriptKind(file: string): ts.ScriptKind {
  const ext = extname(file);
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return ts.ScriptKind.TS;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Parse a source file with the TypeScript compiler API.
 * Returns both the raw source text and the TypeScript SourceFile node.
 *
 * @param {string} file Absolute path to the source file.
 * @returns {{ source: string, sourceFile: import("typescript").SourceFile }}
 */
export function parseSourceFile(file: string): { source: string; sourceFile: ts.SourceFile } {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- parse the explicit scanner target
  const source = readFileSync(file, "utf8");
  return {
    source,
    sourceFile: ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, getScriptKind(file)),
  };
}
