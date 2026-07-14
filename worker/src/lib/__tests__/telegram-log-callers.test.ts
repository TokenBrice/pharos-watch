import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const FORBIDDEN_EXACT_KEYS = new Set([
  "chatId",
  "userId",
  "oldChatId",
  "updateId",
  "callbackData",
  "callbackQueryId",
  "botToken",
  "initData",
  "sourceEventId",
  "pageKey",
  "pendingId",
  "targetRef",
  "presetIds",
  "expectedUrl",
  "miniAppUrl",
  "err",
  "error",
  "stack",
]);

function sourceFiles(directory: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- recursion is confined to repo-owned directory entries.
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return entry.name.endsWith(".ts") ? [fullPath] : [];
  });
}

describe("Telegram structured log callers", () => {
  it("use direct allowlisted objects with no identifier, secret, URL, or raw-error metadata", () => {
    const violations: string[] = [];
    let callerCount = 0;

    for (const file of sourceFiles(path.resolve("worker/src"))) {
      if (file.includes(`${path.sep}__tests__${path.sep}`) || file.endsWith(`${path.sep}telegram-log.ts`)) continue;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- files come only from sourceFiles(worker/src).
      const sourceText = readFileSync(file, "utf8");
      const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);

      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "logTelegramEvent"
        ) {
          callerCount += 1;
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          const argument = node.arguments[0];
          if (!argument || !ts.isObjectLiteralExpression(argument)) {
            violations.push(`${file}:${line}: non-object logger argument`);
          } else {
            for (const property of argument.properties) {
              if (ts.isSpreadAssignment(property)) {
                violations.push(`${file}:${line}: spread logger metadata`);
                continue;
              }
              const key = property.name && ts.isComputedPropertyName(property.name)
                ? null
                : property.name?.getText(source).replace(/["']/g, "") ?? null;
              if (key == null) {
                violations.push(`${file}:${line}: computed logger key`);
                continue;
              }
              if (FORBIDDEN_EXACT_KEYS.has(key) || /(?:^|_)(?:token|secret|signature|hash|url|init_?data)$/i.test(key)) {
                violations.push(`${file}:${line}: forbidden logger key ${key}`);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(callerCount).toBeGreaterThan(40);
    expect(violations).toEqual([]);
  }, 15_000);
});
