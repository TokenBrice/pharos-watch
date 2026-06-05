#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { localBin } from "../lib/local-bin.mjs";

const MADGE_BIN = localBin("madge");
const MADGE_ARGS = ["--circular", "--extensions", "ts,tsx", "--ts-config", "tsconfig.json"];
const CYCLE_TARGETS = [
  { label: "shared", path: "shared", mode: "blocking" },
  { label: "worker/src", path: "worker/src", mode: "blocking" },
  { label: "src", path: "src", mode: "blocking" },
];

function isCycleExit(result, output) {
  return result.status === 1 && output.includes("circular dependencies");
}

let hasBlockingCycles = false;

for (const target of CYCLE_TARGETS) {
  console.log(`[cycles] ${target.label} (${target.mode})`);
  const result = spawnSync(MADGE_BIN, [...MADGE_ARGS, target.path], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const output = [result.stdout, result.stderr]
    .filter((chunk) => typeof chunk === "string" && chunk.length > 0)
    .join("")
    .trim();

  if (output) {
    console.log(output);
  }

  if (result.status === 0) {
    continue;
  }

  if (isCycleExit(result, output)) {
    hasBlockingCycles = true;
    continue;
  }

  if (result.error) {
    console.error(`[cycles] Failed to run Madge for ${target.label}: ${result.error.message}`);
  }

  process.exit(result.status ?? 1);
}

if (hasBlockingCycles) {
  console.error("[cycles] Blocking cycles detected.");
  process.exit(1);
}
