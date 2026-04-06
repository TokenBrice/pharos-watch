#!/usr/bin/env node

import {
  collectAllHotspotMetrics,
  collectAllRepoHotspotMetrics,
  collectHotspotCandidateFiles,
  collectHotspotCandidateRows,
  compareHotspotMetrics,
  findHotspotCandidatesMissingCoverage,
  findStaleHotspotWaiverEntries,
  findUnexpectedHotspotBaselineEntries,
  loadHotspotBaseline,
  loadHotspotWaivers,
  validateHotspotBaselineMetadata,
  validateHotspotTargetFiles,
  validateHotspotWaiverMetadata,
} from "./lib/hotspot-ratchet.mjs";

const missingTargetFiles = validateHotspotTargetFiles();
if (missingTargetFiles.length > 0) {
  console.error("Hotspot target list contains stale file paths:");
  for (const file of missingTargetFiles) {
    console.error(`  ${file}`);
  }
  console.error("");
  console.error("Remove or replace stale entries in scripts/lib/hotspot-ratchet.mjs before updating the baseline.");
  process.exit(1);
}

const current = collectAllHotspotMetrics();
const repoMetrics = collectAllRepoHotspotMetrics();
const candidateRows = collectHotspotCandidateRows(repoMetrics);
const candidateFiles = collectHotspotCandidateFiles(repoMetrics);
const baseline = loadHotspotBaseline();
const waivers = loadHotspotWaivers();
const metadataErrors = validateHotspotBaselineMetadata(baseline);
const waiverErrors = validateHotspotWaiverMetadata(waivers, candidateFiles);
const unexpectedBaselineEntries = findUnexpectedHotspotBaselineEntries(baseline);
const staleWaiverEntries = findStaleHotspotWaiverEntries(waivers, candidateFiles);
const uncoveredCandidates = findHotspotCandidatesMissingCoverage(candidateFiles, waivers);

if (
  metadataErrors.length > 0 ||
  waiverErrors.length > 0 ||
  unexpectedBaselineEntries.length > 0 ||
  staleWaiverEntries.length > 0 ||
  uncoveredCandidates.length > 0
) {
  console.error("Hotspot baseline metadata is incomplete:");
  for (const error of metadataErrors) {
    console.error(`  ${error}`);
  }
  for (const error of waiverErrors) {
    console.error(`  ${error}`);
  }
  for (const file of unexpectedBaselineEntries) {
    console.error(`  unexpected baseline entry: ${file}`);
  }
  for (const file of staleWaiverEntries) {
    console.error(`  stale waiver entry: ${file}`);
  }
  if (uncoveredCandidates.length > 0) {
    console.error("  missing candidate enrollment or waiver:");
    for (const row of candidateRows.filter((candidate) => uncoveredCandidates.includes(candidate.file))) {
      console.error(
        `    ${row.file} (fileLines=${row.fileLines}, maxFunctionLines=${row.maxFunctionLines}, branchCount=${row.branchCount}, metrics=${row.metrics.join(",")})`,
      );
    }
  }
  process.exit(1);
}

const regressions = compareHotspotMetrics(current, baseline);

if (regressions.length === 0) {
  console.log("Hotspot complexity ratchet passed.");
  process.exit(0);
}

console.error("Hotspot complexity regressions detected:");
for (const regression of regressions) {
  console.error(
    `  ${regression.file} ${regression.metric}: current=${regression.current} baseline=${regression.baseline}`,
  );
}
console.error("");
console.error("If these changes are intentional, update the baseline:");
console.error("  npm run check:hotspot-ratchet:update-baseline");
process.exit(1);
