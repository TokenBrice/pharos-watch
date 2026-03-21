#!/usr/bin/env node

import {
  collectAllHotspotMetrics,
  writeHotspotBaseline,
} from "./lib/hotspot-ratchet.mjs";

const metrics = collectAllHotspotMetrics();
writeHotspotBaseline(metrics);
console.log("Updated hotspot ratchet baseline.");
