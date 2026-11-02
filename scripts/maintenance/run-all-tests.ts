#!/usr/bin/env node

import { createExecutionUnit, createLocalVitestCommand, runExecutionUnit, runSpawnCommand } from "../lib/command-runner.mts";

// The full tier: no tag filter, so `*.nightly.test.*` files and
// `nightly`-tagged cases run here (and in the nightly shards) exactly like the
// rest of the suite. Only the PR runner filters the tier.
runExecutionUnit(createExecutionUnit([
  createLocalVitestCommand(["run", ...process.argv.slice(2)]),
]), {
  reporter: {},
  getCommandEnv: () => ({ PHAROS_V9_RESOURCE_LANE: "0" }),
  runCommandImpl: runSpawnCommand,
}).then((result) => {
  process.exit(result.status);
});
