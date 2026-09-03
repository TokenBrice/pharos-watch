import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const TELEGRAM_HTML_PATH = resolve(
  process.cwd().endsWith("/worker") ? process.cwd() : resolve(process.cwd(), "worker"),
  "src/lib/telegram/html.ts",
);

function runtimeImportSpecifiers(sourceText: string): string[] {
  const source = ts.createSourceFile(TELEGRAM_HTML_PATH, sourceText, ts.ScriptTarget.Latest, true);

  return source.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
      return ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [];
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier) {
      return ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [];
    }
    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
      const expression = statement.moduleReference.expression;
      return expression && ts.isStringLiteral(expression) ? [expression.text] : [];
    }
    return [];
  });
}

describe("telegram HTML helper", () => {
  it("has no runtime imports", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-local helper path.
    const sourceText = readFileSync(TELEGRAM_HTML_PATH, "utf8");

    expect(runtimeImportSpecifiers(sourceText)).toEqual([]);
  });
});
