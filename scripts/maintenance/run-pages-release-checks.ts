#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { runDirectCli } from "../lib/cli-args.mjs";
import {
  createExecutionUnit,
  createNpmScriptCommand,
  runExecutionUnit,
  runParallelExecutionUnits,
  runSpawnCommand,
  type CommandImplementation,
  type NpmScriptCommand,
} from "../lib/command-runner.mts";

export async function runPagesReleaseChecks({
  runCommandImpl = runSpawnCommand,
  report = (summary: string) => console.log(summary),
}: {
  runCommandImpl?: CommandImplementation<NpmScriptCommand>;
  report?: (summary: string) => void;
} = {}): Promise<number> {
  const reporter = { start: (cmd: string) => console.log(`[pages-release-checks] ${cmd}`) };
  const parallelResult = await runParallelExecutionUnits([
    createExecutionUnit([createNpmScriptCommand("check:feature-flag-inlining")], { leaf: "feature-flag inlining" }),
    createExecutionUnit([createNpmScriptCommand("check:build-size")], { leaf: "build-size / CSS integrity" }),
    createExecutionUnit([createNpmScriptCommand("check:phishing-signatures")], { leaf: "phishing signatures" }),
  ], { reporter, runCommandImpl });
  const rows = parallelResult.results.map((result) => ({
    leaf: result.unit.leaf,
    command: result.unit.commands[0].cmd,
    outcome: result.aborted ? "aborted" : result.status === 0 ? "passed" : "failed",
    detail: result.signal ? `signal ${result.signal}` : `exit ${result.status}`,
  }));
  let status = parallelResult.status;
  if (status === 0) {
    const seoResult = await runExecutionUnit(createExecutionUnit([
      createNpmScriptCommand("seo:check"),
    ]), { reporter, runCommandImpl });
    status = seoResult.status;
    rows.push({ leaf: "SEO / published archive continuity", command: "npm run seo:check",
      outcome: seoResult.aborted ? "aborted" : status === 0 ? "passed" : "failed",
      detail: seoResult.signal ? `signal ${seoResult.signal}` : `exit ${status}` });
  } else {
    rows.push({ leaf: "SEO / published archive continuity", command: "npm run seo:check",
      outcome: "skipped", detail: "prerequisite artifact gate failed" });
  }
  report([
    "## Pages artifact gate results", "",
    "| Leaf | Command | Outcome | Detail |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.leaf} | ${row.command} | ${row.outcome} | ${row.detail} |`),
    "",
  ].join("\n"));
  return status === 0 ? 0 : 1;
}

runDirectCli(import.meta.url, () => {
  void runPagesReleaseChecks({ report: (summary) => {
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  } }).then((status) => { process.exitCode = status; }, (error: unknown) => {
    console.error(`[pages-release-checks] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
});
