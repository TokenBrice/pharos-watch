#!/usr/bin/env node

import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mts";
import { hasOnlyInternalDocsImpact } from "../lib/deploy-impact.mts";
import { runDirectCli } from "../lib/cli-args.mjs";
import { selectChangedGeneratedArtifactIds } from "./select-generated-artifacts.mts";
import { runGeneratedArtifacts } from "../maintenance/run-generated-artifacts.ts";

export function selectDocsGeneratedArtifactIds(changedFiles: readonly string[]): string[] {
  if (!hasOnlyInternalDocsImpact(changedFiles)) return [];
  return selectChangedGeneratedArtifactIds(changedFiles).filter((id) => id === "llms-txt");
}

export async function checkDocsGeneratedArtifacts({
  env = process.env,
  changedFiles,
  runArtifacts = runGeneratedArtifacts,
}: {
  env?: NodeJS.ProcessEnv;
  changedFiles?: readonly string[];
  runArtifacts?: (options: { argv: readonly string[]; env: NodeJS.ProcessEnv }) => Promise<{ status: number }>;
} = {}): Promise<number> {
  const { base, head } = parseChangedFileArgs([], env);
  const ids = selectDocsGeneratedArtifactIds(changedFiles ?? collectChangedFiles({ base, head }));
  if (ids.length === 0) return 0;
  const result = await runArtifacts({ argv: ["--check", `--only=${ids.join(",")}`], env });
  return result.status;
}

runDirectCli(import.meta.url, async () => {
  process.exitCode = await checkDocsGeneratedArtifacts();
});
