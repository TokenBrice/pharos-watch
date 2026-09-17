import { existsSync, readFileSync } from "node:fs";
import { writeFileResolved } from "./cli-args.mjs";

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
    writeFileResolved(artifact.path, Buffer.from(artifact.contents, encoding));
  }

  console.log(writtenMessage);
}
