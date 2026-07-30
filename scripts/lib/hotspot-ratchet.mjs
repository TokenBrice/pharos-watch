import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

import { isValidDateOnly } from "./date-helpers.mjs";
import { collectSourceFilesUnderRoot } from "./source-files.mjs";
import { parseSourceFile } from "./ts-ast.mjs";

export const TARGET_FILES = [
  "shared/lib/report-cards.ts",
  "shared/lib/format.ts",
  "shared/lib/redemption-backstop-scoring.ts",
  "shared/lib/redemption-backstop-configs/queue-redeem.ts",
  "shared/lib/safety-score-v9/backing.ts",
  "shared/lib/safety-score-v9/control.ts",
  "shared/lib/safety-score-v9/coverage.ts",
  "shared/lib/safety-score-v9/evaluate-asset.ts",
  "shared/lib/safety-score-v9/formula.ts",
  "shared/types/safety-score-v9.ts",
  "shared/types/safety-score-v9-facts.ts",
  "shared/types/safety-score-v9-public.ts",
  "shared/types/stablecoin-meta-schemas.ts",
  "worker/src/api/stablecoin-detail.ts",
  "worker/src/api/feedback.ts",
  "worker/src/handlers/http/request-dispatch.ts",
  "src/components/stablecoin-table.tsx",
  "src/components/yield-history-chart.tsx",
  "src/app/chains/[chain]/client.tsx",
  "src/app/yield/client.tsx",
  "worker/src/cron/sync-stablecoins.ts",
  "src/app/methodology/sections/core/stability-index-section.tsx",
  "src/app/methodology/sections/core/safety-scores-section.tsx",
  "src/app/methodology/sections/core/mint-burn-flow-section.tsx",
  "src/app/methodology/sections/monitoring/yield-intelligence-section.tsx",
  "src/app/methodology/sections/monitoring/pegscore-dews-section.tsx",
  "src/app/methodology/scoring-changelog/content-v7-0.tsx",
  "src/app/methodology/scoring-changelog/content-v6.tsx",
  "src/app/methodology/scoring-changelog/content-v5.tsx",
  "src/app/methodology/scoring-changelog/content-legacy.tsx",
  "src/app/methodology/scoring-changelog/content-summary.tsx",
  "src/app/coverage/client.tsx",
  "src/components/api-key-request-form.tsx",
  "src/hooks/use-api-key-request-form-state.ts",
  "src/lib/stablecoin-detail-view-model.ts",
  "worker/src/api/api-key-requests.ts",
  "worker/src/api/api-key-requests/admin.ts",
  "worker/src/api/reclassify-atomic-roundtrips.ts",
  "worker/src/api/telegram-webhook-parsing.ts",
  "worker/src/cron/daily-digest/collectors.ts",
  "worker/src/cron/daily-digest.ts",
  "worker/src/cron/dispatch-telegram-alerts.ts",
  "worker/src/cron/dex-liquidity/scoring.ts",
  "worker/src/cron/dex-liquidity/process-pools.ts",
  "worker/src/cron/dex-liquidity/orchestrator.ts",
  "worker/src/cron/dex-liquidity/orchestrator-analysis.ts",
  "worker/src/cron/dex-liquidity/staging-merge.ts",
  "worker/src/cron/measured-execution/curve-composite.ts",
  "worker/src/cron/reserve-adapters/sfrxusd-crosschain-redemption.ts",
  "worker/src/cron/sync-mint-burn.ts",
  "worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts",
  "worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts",
  "worker/src/cron/sync-live-reserves.ts",
  "worker/src/cron/compute-dews.ts",
  "worker/src/cron/depeg-detection/decision-engine.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices.ts",
  "worker/src/cron/sync-fx-rates.ts",
  "worker/src/cron/sync-fx-rates-helpers.ts",
  "worker/src/cron/sync-yield-data.ts",
  "worker/src/cron/weekly-recap.ts",
  "worker/src/cron/yield-config.ts",
  "worker/src/cron/yield-sync/sources.ts",
  "worker/src/cron/yield-sync/vaults-fyi.ts",
  "worker/src/lib/live-reserves-store.ts",
  "worker/src/lib/depeg-resolver-incident-store.ts",
  "worker/src/lib/scheduled-slot-fence.ts",
  "worker/src/lib/status-evaluation.ts",
  "worker/src/lib/status-reliability.ts",
  "worker/src/lib/safety-score-v9-extension.ts",
  "worker/src/lib/telegram-usage-analytics.ts",
];

export const BASELINE_PATH = resolve(process.cwd(), "scripts/lib/hotspot-ratchet-baseline.json");
export const WAIVER_PATH = resolve(process.cwd(), "scripts/lib/hotspot-ratchet-waivers.json");

const HOTSPOT_SCAN_ROOTS = ["src", "shared", "worker/src", "functions"];
const HOTSPOT_SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const HOTSPOT_SCAN_EXCLUDED_DIRS = new Set();
const HOTSPOT_METRIC_KEYS = ["fileLines", "maxFunctionLines", "branchCount"];
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
  return HOTSPOT_SCAN_ROOTS.flatMap((root) =>
    collectSourceFilesUnderRoot(root, process.cwd(), {
      extensions: HOTSPOT_SCAN_EXTENSIONS,
      excludedDirs: HOTSPOT_SCAN_EXCLUDED_DIRS,
      skipDotEntries: true,
    }),
  )
    .map((absPath) => normalizeRelPath(relative(process.cwd(), absPath)))
    .filter((relPath) => !shouldSkipHotspotScanFile(relPath))
    .sort();
}

export function collectHotspotMetrics(relPath) {
  const filePath = resolve(process.cwd(), relPath);
  const { source: sourceText, sourceFile } = parseSourceFile(filePath);

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
    .filter(
      (row) =>
        row.maxFunctionLines >= HOTSPOT_FILELINE_MIN_FUNCTION_LINES ||
        row.branchCount >= HOTSPOT_FILELINE_MIN_BRANCH_COUNT,
    )
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

  return [...candidateMap.values()].sort(
    (left, right) =>
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
  return Object.keys(waivers).filter((file) => {
    if (candidateSet.has(file)) return false;
    try {
      readFileSync(resolve(process.cwd(), file), "utf8");
      return false;
    } catch {
      return true;
    }
  });
}

export function findHotspotCandidatesMissingCoverage(candidateFiles, waivers) {
  const waiverSet = new Set(Object.keys(waivers));
  return candidateFiles.filter((file) => !TARGET_FILES.includes(file) && !waiverSet.has(file));
}

export function writeHotspotBaseline(metrics) {
  const baseline = Object.fromEntries(TARGET_FILES.map((file) => [file, metrics[file]]));
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
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

    for (const key of Object.keys(entry)) {
      if (!HOTSPOT_METRIC_KEYS.includes(key)) errors.push(`${file}: unexpected baseline field ${key}`);
    }
  }

  return errors;
}

export function validateHotspotWaiverMetadata(waivers) {
  const errors = [];

  for (const [file, waiver] of Object.entries(waivers)) {
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
    if (typeof waiver.owner !== "string" || waiver.owner.trim().length === 0) {
      errors.push(`${file}: missing waiver owner`);
    }
    if (!isValidDateOnly(waiver.createdAt)) {
      errors.push(`${file}: missing or invalid waiver createdAt`);
    }
    if (!isValidDateOnly(waiver.reviewAfter)) {
      errors.push(`${file}: missing or invalid waiver reviewAfter`);
    }
    if (
      isValidDateOnly(waiver.createdAt) &&
      isValidDateOnly(waiver.reviewAfter) &&
      waiver.reviewAfter < waiver.createdAt
    ) {
      errors.push(`${file}: waiver reviewAfter must be on or after createdAt`);
    }
    if (typeof waiver.nextAction !== "string" || waiver.nextAction.trim().length === 0) {
      errors.push(`${file}: missing waiver nextAction`);
    }
  }

  return errors;
}

export function collectHotspotWaiverReviewQueue(waivers, { today = new Date(), lookaheadDays = 14 } = {}) {
  const todayString = toUtcDateOnly(today);
  const lookahead = new Date(`${todayString}T00:00:00.000Z`);
  lookahead.setUTCDate(lookahead.getUTCDate() + lookaheadDays);
  const lookaheadString = toUtcDateOnly(lookahead);
  const due = [];
  const upcoming = [];

  for (const [file, waiver] of Object.entries(waivers)) {
    if (!isValidDateOnly(waiver?.reviewAfter)) continue;
    const row = {
      file,
      owner: waiver.owner ?? "unknown",
      reviewAfter: waiver.reviewAfter,
      nextAction: waiver.nextAction ?? "",
    };
    if (waiver.reviewAfter <= todayString) {
      due.push(row);
    } else if (waiver.reviewAfter <= lookaheadString) {
      upcoming.push(row);
    }
  }

  const sortByReviewDate = (left, right) =>
    left.reviewAfter.localeCompare(right.reviewAfter) || left.file.localeCompare(right.file);

  return {
    due: due.sort(sortByReviewDate),
    upcoming: upcoming.sort(sortByReviewDate),
  };
}

function toUtcDateOnly(date) {
  return date.toISOString().slice(0, 10);
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
