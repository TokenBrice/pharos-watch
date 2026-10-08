#!/usr/bin/env node

import { PAGES_PREVIOUS_SITEMAP_URL, runPagesArtifactLane } from "../ci/run-pages-artifact-lane.ts";
import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import {
  createExecutionUnit,
  createNpmScriptCommand,
  runExecutionUnit,
  runSpawnCommand,
  type CommandImplementation,
  type NpmScriptCommand,
} from "../lib/command-runner.mts";

const USAGE = `Usage: npm run check:release -- [--live-continuity]

Rehearse the production Pages artifact profile and strict Worker packaging offline.
Runs local typechecking and migration validation; never applies migrations or deploys.
  --live-continuity  Also fetch the live previous sitemap for archive continuity.
  -h, --help        Show this help.
`;

interface RehearsalDependencies {
  runCommand: CommandImplementation<NpmScriptCommand>;
  runPages: typeof runPagesArtifactLane;
  report: (message: string) => void;
}

export async function runReleaseRehearsal(
  { liveContinuity = false }: { liveContinuity?: boolean } = {},
  {
    runCommand = runSpawnCommand,
    runPages = runPagesArtifactLane,
    report = console.log,
  }: Partial<RehearsalDependencies> = {},
): Promise<void> {
  const runScript = async (name: string): Promise<void> => {
    const result = await runExecutionUnit(createExecutionUnit([createNpmScriptCommand(name)]), {
      reporter: { start: (command) => report(`[release-rehearsal] ${command}`) },
      runCommandImpl: runCommand,
    });
    if (result.status !== 0) {
      throw new Error(`${name} failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`}).`);
    }
  };

  report(liveContinuity
    ? `[release-rehearsal] Published archive continuity enabled: ${PAGES_PREVIOUS_SITEMAP_URL}`
    : "[release-rehearsal] Published archive continuity skipped (offline; opt in with --live-continuity).");
  // Next typechecks the exact regenerated build inputs, as in a standalone build.
  await runPages({
    acquireReleaseData: false,
    preserveTypecheck: true,
    ...(liveContinuity ? { previousSitemapUrl: PAGES_PREVIOUS_SITEMAP_URL } : {}),
  });
  await runScript("check:migrations");
  await runScript("check:worker-package");
}

runDirectCli(import.meta.url, async () => {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: { "live-continuity": { type: "boolean" } },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  await runReleaseRehearsal({ liveContinuity: values["live-continuity"] === true });
}, { label: "release-rehearsal", usage: USAGE });
