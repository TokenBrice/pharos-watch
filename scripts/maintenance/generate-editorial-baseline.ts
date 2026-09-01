#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  EDITORIAL_STYLE_HASH,
  EDITORIAL_STYLE_VERSION,
} from "@shared/lib/editorial-style";

import {
  EDITORIAL_BASELINE_PATH,
} from "../lib/editorial-surface-registry";
import {
  buildEditorialBaseline,
  readEditorialBaseline,
  type EditorialObservation,
  writeEditorialBaseline,
} from "../lib/editorial-baseline";
import { collectGateObservations } from "../lib/editorial-gate";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

export function collectEditorialObservations(root = ROOT): EditorialObservation[] {
  return collectGateObservations({ root });
}

export function generateEditorialBaseline(root = ROOT) {
  const output = resolve(root, EDITORIAL_BASELINE_PATH);
  const previousBaseline = existsSync(output) ? readEditorialBaseline(output) : undefined;
  return buildEditorialBaseline(collectEditorialObservations(root), {
    policyVersion: EDITORIAL_STYLE_VERSION,
    policyHash: EDITORIAL_STYLE_HASH,
    previousBaseline,
  });
}

function main(): void {
  const baseline = generateEditorialBaseline();
  const output = resolve(ROOT, EDITORIAL_BASELINE_PATH);
  const serialized = `${JSON.stringify(baseline, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const current = existsSync(output) ? readFileSync(output, "utf8") : "";
    if (current !== serialized) {
      console.error(`[editorial-baseline] ${EDITORIAL_BASELINE_PATH} is stale; run npm run generate:editorial-baseline.`);
      process.exitCode = 1;
      return;
    }
    console.log(`[editorial-baseline] ${EDITORIAL_BASELINE_PATH} is current.`);
    return;
  }
  writeEditorialBaseline(output, baseline);
  console.log(
    `[editorial-baseline] wrote ${baseline.entries.length} selector/rule entries (${baseline.entries.reduce((total, entry) => total + entry.count, 0)} findings) to ${EDITORIAL_BASELINE_PATH}`,
  );
}

if (isDirectRun(import.meta.url, process.argv[1])) main();
