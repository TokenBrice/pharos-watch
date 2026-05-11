#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { buildNoncriticalTestArgs } from "./lib/critical-test-files.mjs";
import { localBin } from "./lib/local-bin.mjs";
import { withCiVitestArgs } from "./lib/vitest-ci-args.mjs";

const generatedPrerequisites = [
  "scripts/generate-sitemap-dates.ts",
  "scripts/generate-docs-metadata.ts",
];

for (const script of generatedPrerequisites) {
  const generated = spawnSync(localBin("tsx"), [script], {
    stdio: "inherit",
  });

  if (generated.error) {
    throw generated.error;
  }
  if ((generated.status ?? 1) !== 0) {
    process.exit(generated.status ?? 1);
  }
}

const result = spawnSync(localBin("vitest"), withCiVitestArgs(buildNoncriticalTestArgs(process.argv.slice(2))), {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
