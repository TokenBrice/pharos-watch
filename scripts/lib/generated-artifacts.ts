/* eslint-disable security/detect-non-literal-fs-filename -- build/check scripts operate on explicit repo-local generated artifact paths. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface GeneratedArtifact {
  path: string;
  contents: string;
}

interface SyncGeneratedArtifactsOptions {
  artifacts: readonly GeneratedArtifact[];
  check: boolean;
  staleMessage: string;
  currentMessage: string;
  writtenMessage: string;
  encoding?: BufferEncoding;
}

export function syncGeneratedArtifacts({
  artifacts,
  check,
  staleMessage,
  currentMessage,
  writtenMessage,
  encoding = "utf8",
}: SyncGeneratedArtifactsOptions): void {
  if (check) {
    const staleArtifact = artifacts.find((artifact) => (
      !existsSync(artifact.path) || readFileSync(artifact.path, encoding) !== artifact.contents
    ));

    if (staleArtifact) {
      console.error(staleMessage);
      process.exit(1);
    }

    console.log(currentMessage);
    return;
  }

  for (const artifact of artifacts) {
    mkdirSync(dirname(artifact.path), { recursive: true });
    writeFileSync(artifact.path, artifact.contents, encoding);
  }

  console.log(writtenMessage);
}
