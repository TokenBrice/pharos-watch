#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "fflate";
import { parseStrictCliArgs } from "../lib/cli-args.mjs";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_PATH = resolve(REPO_ROOT, "shared/data/stablecoins/coins.generated.json");
const OUTPUT_PATH = resolve(REPO_ROOT, "shared/data/stablecoins/coins.worker-full.generated.json");

export function buildWorkerStablecoinCatalog<T extends { id: string }>(coins: readonly T[]) {
  let maxUncompressedBytes = 0;
  const rows = coins.map((coin): [string, number, string] => {
    const bytes = Buffer.from(JSON.stringify(coin), "utf8");
    maxUncompressedBytes = Math.max(maxUncompressedBytes, bytes.length);
    // The pinned JavaScript compressor avoids native zlib-version drift across
    // Node releases. Each complete record gets a fixed timestamp and can be
    // inflated independently into the Worker's reusable bounded buffer.
    return [coin.id, bytes.length, Buffer.from(gzipSync(bytes, { level: 9, mtime: 0 })).toString("base64")];
  });
  return { version: 1, maxUncompressedBytes, coins: rows };
}

export function renderWorkerStablecoinCatalog<T extends { id: string }>(coins: readonly T[]): string {
  return `${JSON.stringify(buildWorkerStablecoinCatalog(coins))}\n`;
}

export function runCli(argv = process.argv.slice(2)): void {
  const { values } = parseStrictCliArgs(argv, { options: { check: { type: "boolean" } } });
  if (values.help) {
    console.log("Usage: generate-worker-stablecoin-catalog.ts [--check]");
    return;
  }
  const coins = JSON.parse(readFileSync(SOURCE_PATH, "utf8")) as { id: string }[];
  syncGeneratedArtifacts({
    artifacts: [{ path: OUTPUT_PATH, contents: renderWorkerStablecoinCatalog(coins) }],
    check: values.check === true,
    staleMessage: "Worker full catalog is stale. Run `node --import tsx scripts/build-data/generate-worker-stablecoin-catalog.ts`.",
    currentMessage: `Worker full catalog is current for ${coins.length} coins`,
    writtenMessage: `Generated lossless Worker full catalog for ${coins.length} coins`,
  });
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCli();
}
