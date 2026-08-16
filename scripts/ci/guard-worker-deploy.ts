#!/usr/bin/env node

import {
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const USAGE: string = `Usage: npm --prefix worker run deploy

Production publishing is intentionally unavailable through this command.
Use the production release workflow. For local debugging, run:
  cd worker && npm run dev

Options:
  -h, --help  Show this help`;

export function parseWorkerDeployGuardArgs(argv: readonly string[]): { help: boolean } {
  const { values } = parseStrictCliArgs(argv);
  return { help: values.help === true };
}

export function runWorkerDeployGuard(argv: readonly string[] = process.argv.slice(2)): void {
  const options = parseWorkerDeployGuardArgs(argv);
  if (writeCliHelpIfRequested(options, USAGE)) return;
  throw new Error(
    [
      "Worker production publishing is intentionally disabled from npm scripts.",
      "Use the production release workflow, which checks and applies D1 migrations, deploys once with `wrangler deploy --strict`, and verifies that the SHA-tagged version owns 100% of production traffic.",
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
