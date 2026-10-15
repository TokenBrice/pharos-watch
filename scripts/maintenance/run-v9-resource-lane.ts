#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseStrictCliArgs, runDirectCli } from "../lib/cli-args.mjs";
import { createLocalVitestCommand, runSpawnCommand, type CommandImplementation, type SpawnCommand } from "../lib/command-runner.mts";

export const RESOURCE_TEST_FILE = "worker/src/lib/__tests__/safety-score-v9-resource-budget.test.ts";
const REQUIRED_CASES = [
  "publishes the full registry within 128 MiB of old-space",
  "evaluates a bounded nine-scenario matrix within 256 MiB of old-space",
];
const reportSchema = z.object({
  testResults: z.array(z.object({
    name: z.string(),
    assertionResults: z.array(z.object({ title: z.string(), status: z.string() })),
  })),
});

export function assertRequiredResourceCases(report: unknown): void {
  const parsed = reportSchema.parse(report);
  const cases = parsed.testResults
    .filter((file) => file.name.replaceAll("\\", "/").endsWith(RESOURCE_TEST_FILE))
    .flatMap((file) => file.assertionResults);
  for (const title of REQUIRED_CASES) {
    const matches = cases.filter((test) => test.title === title);
    if (matches.length !== 1 || matches[0].status !== "passed") {
      throw new Error(`Required V9 resource case did not pass: ${title}`);
    }
  }
}

export async function runV9ResourceLane({
  argv = process.argv.slice(2),
  outputDirectory = ".tmp/v9-resource-lane",
  runCommand = runSpawnCommand,
}: {
  argv?: readonly string[];
  outputDirectory?: string;
  runCommand?: CommandImplementation<SpawnCommand>;
} = {}): Promise<number> {
  const { values } = parseStrictCliArgs(argv);
  if (values.help) {
    console.log("Usage: npm run test:v9-resource\nRuns the isolated, required V9 publication and contagion probes.");
    return 0;
  }
  mkdirSync(outputDirectory, { recursive: true });
  const reportPath = join(outputDirectory, "vitest.json");
  // A stale passing report must never turn a failed launch into a green lane.
  rmSync(reportPath, { force: true });
  const command = createLocalVitestCommand([
    "run", RESOURCE_TEST_FILE, "--coverage.enabled=false", "--maxWorkers=1",
    "--no-file-parallelism", "--reporter=json", `--outputFile=${reportPath}`,
  ]);
  const result = await runCommand(command, { PHAROS_V9_RESOURCE_LANE: "1" });
  const status = typeof result === "number" ? result : result.status;
  assertRequiredResourceCases(JSON.parse(readFileSync(reportPath, "utf8")));
  return status || (typeof result !== "number" && (result.error || result.aborted) ? 1 : 0);
}

runDirectCli(import.meta.url, async () => {
  process.exitCode = await runV9ResourceLane();
}, { label: "[v9-resource]" });
