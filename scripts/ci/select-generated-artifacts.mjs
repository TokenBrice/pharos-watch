#!/usr/bin/env node

import { matchesGlob } from "node:path";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mjs";

function matchesPath(path, pattern) {
  return path === pattern || matchesGlob(path, pattern);
}

export function selectChangedGeneratedArtifactIds(changedFiles, registry = GENERATED_ARTIFACT_REGISTRY) {
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

export function runSelector(argv = process.argv.slice(2), env = process.env) {
  const { base, head, rest } = parseChangedFileArgs(argv, env);
  if (rest.length > 0) throw new Error(`Unknown option(s): ${rest.join(", ")}`);
  return selectChangedGeneratedArtifactIds(collectChangedFiles({ base, head }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${runSelector().join(",")}\n`);
}
