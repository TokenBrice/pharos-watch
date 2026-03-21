#!/usr/bin/env node

import {
  collectAllHotspotMetrics,
  compareHotspotMetrics,
  loadHotspotBaseline,
} from "./lib/hotspot-ratchet.mjs";

const current = collectAllHotspotMetrics();
const baseline = loadHotspotBaseline();
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
process.exit(1);
