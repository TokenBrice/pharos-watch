#!/usr/bin/env node

import {
  collectAllHotspotMetrics,
  compareHotspotMetrics,
  loadHotspotBaseline,
  validateHotspotBaselineMetadata,
} from "./lib/hotspot-ratchet.mjs";

const current = collectAllHotspotMetrics();
const baseline = loadHotspotBaseline();
const metadataErrors = validateHotspotBaselineMetadata(baseline);

if (metadataErrors.length > 0) {
  console.error("Hotspot baseline metadata is incomplete:");
  for (const error of metadataErrors) {
    console.error(`  ${error}`);
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
