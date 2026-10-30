#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIncidentRuntime } from "../lib/safety-score-v9-incident-runtime";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import { parseStrictCliArgs } from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function runCli(argv = process.argv.slice(2)): void {
  const { values } = parseStrictCliArgs(argv, { options: { check: { type: "boolean" } } });
  const value = JSON.parse(readFileSync(resolve(ROOT, "shared/data/safety-score-v9/incident-reviews-v1.json"), "utf8"));
  syncGeneratedArtifacts({ artifacts: [{ path: resolve(ROOT, "shared/data/safety-score-v9/incident-runtime-v1.generated.json"), contents: `${JSON.stringify(buildIncidentRuntime(value))}\n` }],
    check: values.check === true, staleMessage: "Safety Score incident runtime projection is stale.",
    currentMessage: "Safety Score incident runtime projection is current", writtenMessage: "Generated Safety Score incident runtime projection" });
}
if (isDirectRun(import.meta.url, process.argv[1])) runCli();
