import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import ts from "typescript";

export const TARGET_FILES = [
  "worker/src/api/stablecoin-detail.ts",
  "worker/src/api/feedback.ts",
  "worker/src/handlers/http.ts",
  "worker/src/cron/sync-stablecoins.ts",
  "src/app/methodology/sections/core/stability-index-section.tsx",
  "src/app/methodology/sections/core/safety-scores-section.tsx",
  "src/app/methodology/sections/core/liquidity-section.tsx",
  "src/app/methodology/sections/core/mint-burn-flow-section.tsx",
  "src/app/methodology/sections/monitoring/yield-intelligence-section.tsx",
  "src/app/methodology/sections/monitoring/pegscore-dews-section.tsx",
  "src/app/methodology/scoring-changelog/content-v6.tsx",
  "src/app/methodology/scoring-changelog/content-v5.tsx",
  "src/app/methodology/scoring-changelog/content-legacy.tsx",
  "src/app/methodology/scoring-changelog/content-summary.tsx",
  "src/app/coverage/client.tsx",
  "worker/src/cron/daily-digest/collectors.ts",
  "worker/src/cron/daily-digest.ts",
  "worker/src/cron/dex-liquidity/orchestrator.ts",
  "worker/src/cron/sync-mint-burn.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices.ts",
  "worker/src/cron/sync-blacklist.ts",
  "worker/src/cron/sync-fx-rates.ts",
  "worker/src/cron/yield-sync/sources.ts",
  "worker/src/lib/live-reserves-store.ts",
  "worker/src/lib/status-evaluation.ts",
  "worker/src/lib/status-reliability.ts",
];

export const BASELINE_PATH = resolve(process.cwd(), "scripts/lib/hotspot-ratchet-baseline.json");
const HOTSPOT_METRIC_KEYS = ["fileLines", "maxFunctionLines", "branchCount"];
const HOTSPOT_DISPOSITIONS = new Set(["stabilized", "queued-p4", "deferred"]);

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

    for (const metric of HOTSPOT_METRIC_KEYS) {
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

export function validateHotspotBaselineMetadata(baseline) {
  const errors = [];

  for (const file of TARGET_FILES) {
    const entry = baseline[file];
    if (!entry) {
      errors.push(`${file}: missing baseline entry`);
      continue;
    }

    for (const metric of HOTSPOT_METRIC_KEYS) {
      if (typeof entry[metric] !== "number" || !Number.isFinite(entry[metric])) {
        errors.push(`${file}: missing numeric ${metric}`);
      }
    }

    if (!HOTSPOT_DISPOSITIONS.has(entry.disposition)) {
      errors.push(`${file}: invalid disposition "${entry.disposition ?? "missing"}"`);
    }

    if (!entry.targetBudget || typeof entry.targetBudget !== "object") {
      errors.push(`${file}: missing targetBudget`);
      continue;
    }

    for (const metric of HOTSPOT_METRIC_KEYS) {
      const targetValue = entry.targetBudget[metric];
      if (typeof targetValue !== "number" || !Number.isFinite(targetValue)) {
        errors.push(`${file}: missing numeric targetBudget.${metric}`);
      }
    }

    if (typeof entry.notes !== "string" || entry.notes.trim().length === 0) {
      errors.push(`${file}: missing notes`);
    }
  }

  return errors;
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
