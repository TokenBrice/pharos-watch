import { readFileSync, readdirSync, writeFileSync } from "fs";
import { extname, join, relative, resolve } from "path";
import ts from "typescript";

export const TARGET_FILES = [
  "shared/lib/report-cards.ts",
  "worker/src/api/stablecoin-detail.ts",
  "worker/src/api/feedback.ts",
  "worker/src/handlers/http.ts",
  "src/components/contagion-graph.tsx",
  "src/app/chains/[chain]/client.tsx",
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
  "worker/src/cron/dispatch-telegram-alerts.ts",
  "worker/src/cron/dex-liquidity/scoring.ts",
  "worker/src/cron/dex-liquidity/orchestrator.ts",
  "worker/src/cron/dex-liquidity/orchestrator-analysis.ts",
  "worker/src/cron/sync-mint-burn.ts",
  "worker/src/cron/sync-live-reserves.ts",
  "worker/src/cron/compute-dews.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices.ts",
  "worker/src/cron/sync-blacklist.ts",
  "worker/src/cron/sync-fx-rates.ts",
  "worker/src/cron/yield-config.ts",
  "worker/src/cron/yield-sync/sources.ts",
  "worker/src/lib/live-reserves-store.ts",
  "worker/src/lib/status-evaluation.ts",
  "worker/src/lib/status-reliability.ts",
];

export const BASELINE_PATH = resolve(process.cwd(), "scripts/lib/hotspot-ratchet-baseline.json");
export const WAIVER_PATH = resolve(process.cwd(), "scripts/lib/hotspot-ratchet-waivers.json");

const HOTSPOT_SCAN_ROOTS = ["src", "shared", "worker/src", "functions"];
const HOTSPOT_SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const HOTSPOT_METRIC_KEYS = ["fileLines", "maxFunctionLines", "branchCount"];
const HOTSPOT_DISPOSITIONS = new Set(["stabilized", "queued-p4", "deferred"]);
const HOTSPOT_WAIVER_DISPOSITIONS = new Set(["queued-p4", "deferred"]);
const HOTSPOT_CANDIDATE_TOP_N = 12;
const HOTSPOT_FILELINE_MIN_FUNCTION_LINES = 40;
const HOTSPOT_FILELINE_MIN_BRANCH_COUNT = 8;

function normalizeRelPath(relPath) {
  return relPath.replaceAll("\\", "/");
}

function shouldSkipHotspotScanFile(relPath) {
  return (
    relPath.endsWith(".d.ts") ||
    relPath.includes("/__tests__/") ||
    relPath.includes("/ui/") ||
    relPath.startsWith("src/data/") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(relPath)
  );
}

function collectHotspotSourceFiles() {
  const relPaths = [];

  function walk(absDirPath) {
    for (const entry of readdirSync(absDirPath, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const absPath = join(absDirPath, entry.name);
      if (entry.isDirectory()) {
        walk(absPath);
        continue;
      }

      if (!HOTSPOT_SCAN_EXTENSIONS.has(extname(entry.name))) continue;
      const relPath = normalizeRelPath(relative(process.cwd(), absPath));
      if (shouldSkipHotspotScanFile(relPath)) continue;
      relPaths.push(relPath);
    }
  }

  for (const root of HOTSPOT_SCAN_ROOTS) {
    walk(resolve(process.cwd(), root));
  }

  relPaths.sort();
  return relPaths;
}

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

function collectHotspotMetricsForFiles(relPaths) {
  return Object.fromEntries(relPaths.map((file) => [file, collectHotspotMetrics(file)]));
}

export function collectAllRepoHotspotMetrics() {
  return collectHotspotMetricsForFiles(collectHotspotSourceFiles());
}

export function collectHotspotCandidateRows(repoMetrics = collectAllRepoHotspotMetrics()) {
  const rows = Object.entries(repoMetrics).map(([file, metrics]) => ({ file, ...metrics }));
  const candidateMap = new Map();
  const byFileLines = [...rows]
    .filter((row) => row.maxFunctionLines >= HOTSPOT_FILELINE_MIN_FUNCTION_LINES || row.branchCount >= HOTSPOT_FILELINE_MIN_BRANCH_COUNT)
    .sort((left, right) => right.fileLines - left.fileLines)
    .slice(0, HOTSPOT_CANDIDATE_TOP_N);
  const byFunctionLines = [...rows]
    .sort((left, right) => right.maxFunctionLines - left.maxFunctionLines)
    .slice(0, HOTSPOT_CANDIDATE_TOP_N);
  const byBranchCount = [...rows]
    .sort((left, right) => right.branchCount - left.branchCount)
    .slice(0, HOTSPOT_CANDIDATE_TOP_N);

  for (const [metric, metricRows] of [
    ["fileLines", byFileLines],
    ["maxFunctionLines", byFunctionLines],
    ["branchCount", byBranchCount],
  ]) {
    for (const row of metricRows) {
      const existing = candidateMap.get(row.file) ?? { ...row, metrics: [] };
      existing.metrics.push(metric);
      candidateMap.set(row.file, existing);
    }
  }

  return [...candidateMap.values()].sort((left, right) =>
    right.fileLines - left.fileLines ||
    right.maxFunctionLines - left.maxFunctionLines ||
    right.branchCount - left.branchCount ||
    left.file.localeCompare(right.file),
  );
}

export function collectHotspotCandidateFiles(repoMetrics = collectAllRepoHotspotMetrics()) {
  return collectHotspotCandidateRows(repoMetrics).map((row) => row.file);
}

export function collectAllHotspotMetrics() {
  return collectHotspotMetricsForFiles(TARGET_FILES);
}

export function validateHotspotTargetFiles() {
  return TARGET_FILES.filter((file) => {
    try {
      readFileSync(resolve(process.cwd(), file), "utf8");
      return false;
    } catch {
      return true;
    }
  });
}

export function loadHotspotBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

export function loadHotspotWaivers() {
  return JSON.parse(readFileSync(WAIVER_PATH, "utf8"));
}

export function findUnexpectedHotspotBaselineEntries(baseline) {
  return Object.keys(baseline).filter((file) => !TARGET_FILES.includes(file));
}

export function findStaleHotspotWaiverEntries(waivers, candidateFiles) {
  const candidateSet = new Set(candidateFiles);
  return Object.keys(waivers).filter((file) => !candidateSet.has(file));
}

export function findHotspotCandidatesMissingCoverage(candidateFiles, waivers) {
  const waiverSet = new Set(Object.keys(waivers));
  return candidateFiles.filter((file) => !TARGET_FILES.includes(file) && !waiverSet.has(file));
}

export function writeHotspotBaseline(metrics) {
  const existingBaseline = loadHotspotBaseline();
  const mergedBaseline = Object.fromEntries(
    TARGET_FILES.map((file) => [file, { ...existingBaseline[file], ...metrics[file] }]),
  );
  writeFileSync(BASELINE_PATH, `${JSON.stringify(mergedBaseline, null, 2)}\n`);
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

export function validateHotspotWaiverMetadata(waivers, candidateFiles) {
  const errors = [];
  const candidateSet = new Set(candidateFiles);

  for (const [file, waiver] of Object.entries(waivers)) {
    if (!candidateSet.has(file)) continue;
    if (TARGET_FILES.includes(file)) {
      errors.push(`${file}: already enrolled in hotspot baseline; remove waiver`);
    }
    if (!waiver || typeof waiver !== "object") {
      errors.push(`${file}: missing waiver metadata`);
      continue;
    }
    if (!HOTSPOT_WAIVER_DISPOSITIONS.has(waiver.disposition)) {
      errors.push(`${file}: invalid waiver disposition "${waiver.disposition ?? "missing"}"`);
    }
    if (typeof waiver.notes !== "string" || waiver.notes.trim().length === 0) {
      errors.push(`${file}: missing waiver notes`);
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
