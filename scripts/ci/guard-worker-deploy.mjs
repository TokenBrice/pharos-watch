#!/usr/bin/env node

import {
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const USAGE = `Usage: npm --prefix worker run deploy

Production publishing is intentionally unavailable through this command.
Use the production release workflow. For local debugging, run:
  cd worker && npm run dev

Options:
  -h, --help  Show this help`;

export function parseWorkerDeployGuardArgs(argv) {
  const { values } = parseStrictCliArgs(argv);
  return { help: values.help === true };
}

export function runWorkerDeployGuard(argv = process.argv.slice(2)) {
  const options = parseWorkerDeployGuardArgs(argv);
  if (writeCliHelpIfRequested(options, USAGE)) return;
  throw new Error(
    [
      "Worker production publishing is intentionally disabled from npm scripts.",
      "Use the production release workflow, which uploads a Worker Version, runs validation and D1 migration checks, preview-smokes the candidate, promotes the exact version, and syncs triggers.",
      "For local debugging, use `cd worker && npm run dev`.",
    ].join("\n"),
  );
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runWorkerDeployGuard(), {
    label: "worker-deploy",
    usage: USAGE,
  });
}
