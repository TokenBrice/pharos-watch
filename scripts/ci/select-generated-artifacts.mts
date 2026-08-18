#!/usr/bin/env node

import { matchesGlob } from "node:path";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
import { collectChangedFiles, collectStagedFiles, parseChangedFileArgs } from "../lib/changed-files.mts";

interface GeneratedArtifactDefinition {
  id: string;
  sourcePaths: readonly string[];
  dependsOn?: readonly string[];
}

function matchesPath(path: string, pattern: string) {
  return path === pattern || matchesGlob(path, pattern);
}

export function selectChangedGeneratedArtifactIds(
  changedFiles: readonly string[],
  registry: readonly GeneratedArtifactDefinition[] = GENERATED_ARTIFACT_REGISTRY,
): string[] {
  const selected = new Set(
    registry
      .filter((artifact) => changedFiles.some((file) => artifact.sourcePaths.some((pattern) => matchesPath(file, pattern))))
      .map((artifact) => artifact.id),
  );

  let added;
  do {
    added = false;
    for (const artifact of registry) {
      if (selected.has(artifact.id)) continue;
      if ((artifact.dependsOn ?? []).some((dependency) => selected.has(dependency))) {
        selected.add(artifact.id);
        added = true;
      }
    }
  } while (added);

  return registry.filter((artifact) => selected.has(artifact.id)).map((artifact) => artifact.id);
}

export function runSelector(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env) {
  const { base, head, rest, staged } = parseChangedFileArgs(argv, env);
  if (rest.length > 0) throw new Error(`Unknown option(s): ${rest.join(", ")}`);
  return selectChangedGeneratedArtifactIds(staged ? collectStagedFiles() : collectChangedFiles({ base, head }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${runSelector().join(",")}\n`);
}
