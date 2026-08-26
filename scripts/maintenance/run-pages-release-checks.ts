#!/usr/bin/env node

import {
  createExecutionUnit,
  createNpmScriptCommand,
  runExecutionUnit,
  runParallelExecutionUnits,
  runSpawnCommand,
  type ExecutionResult,
} from "../lib/command-runner.mts";

function formatFailure(result: ExecutionResult): string {
  const name = result.failedCmd?.match(/^npm run (\S+)/)?.[1] ?? "unknown";
  return `${name} failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`}).`;
}

async function main(): Promise<void> {
  try {
    const reporter = { start: (cmd: string) => console.log(`[pages-release-checks] ${cmd}`) };
    const parallelResult = await runParallelExecutionUnits([
      createExecutionUnit([createNpmScriptCommand("check:feature-flag-inlining")]),
      createExecutionUnit([createNpmScriptCommand("check:build-size")]),
      createExecutionUnit([createNpmScriptCommand("check:phishing-signatures")]),
    ], { reporter, runCommandImpl: runSpawnCommand });
    if (parallelResult.status !== 0) throw new Error(formatFailure(parallelResult));

    const seoResult = await runExecutionUnit(createExecutionUnit([
      createNpmScriptCommand("seo:check"),
    ]), { reporter, runCommandImpl: runSpawnCommand });
    if (seoResult.status !== 0) throw new Error(formatFailure(seoResult));
  } catch (error) {
    console.error(`[pages-release-checks] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

void main();
