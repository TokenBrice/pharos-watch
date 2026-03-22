import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import ts from "typescript";

export const TARGET_FILES = [
  "worker/src/api/stablecoin-detail.ts",
  "worker/src/api/feedback.ts",
  "worker/src/handlers/http.ts",
  "worker/src/cron/sync-stablecoins.ts",
  "src/app/methodology/sections/core-sections.tsx",
  "src/app/coverage/client.tsx",
  "worker/src/cron/daily-digest/collectors.ts",
  "worker/src/cron/sync-fx-rates.ts",
  "worker/src/lib/status-evaluation.ts",
];

export const BASELINE_PATH = resolve(process.cwd(), "scripts/lib/hotspot-ratchet-baseline.json");

export function collectHotspotMetrics(relPath) {
  const filePath = resolve(process.cwd(), relPath);
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const fileLines = sourceText.split("\n").length;
  let maxFunctionLines = 0;
  let branchCount = 0;

  visit(sourceFile, (node) => {
    if (isBranchNode(node)) branchCount += 1;
    if (isFunctionLike(node) && node.body) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      const end = sourceFile.getLineAndCharacterOfPosition(node.body.getEnd()).line;
      maxFunctionLines = Math.max(maxFunctionLines, end - start + 1);
    }
  });

  return { fileLines, maxFunctionLines, branchCount };
}

export function collectAllHotspotMetrics() {
  return Object.fromEntries(TARGET_FILES.map((file) => [file, collectHotspotMetrics(file)]));
}

export function loadHotspotBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

export function writeHotspotBaseline(metrics) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(metrics, null, 2)}\n`);
}

export function compareHotspotMetrics(current, baseline) {
  const regressions = [];

  for (const file of TARGET_FILES) {
    const currentMetrics = current[file];
    const baselineMetrics = baseline[file];
    if (!baselineMetrics) {
      regressions.push({ file, metric: "baseline", current: "missing", baseline: "missing" });
      continue;
    }

    for (const metric of ["fileLines", "maxFunctionLines", "branchCount"]) {
      if (currentMetrics[metric] > baselineMetrics[metric]) {
        regressions.push({
          file,
          metric,
          current: currentMetrics[metric],
          baseline: baselineMetrics[metric],
        });
      }
    }
  }

  return regressions;
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}

function isBranchNode(node) {
  return (
    ts.isIfStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isSwitchStatement(node) ||
    ts.isCaseClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCatchClause(node)
  );
}

function visit(node, callback) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}
