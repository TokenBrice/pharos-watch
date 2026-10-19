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

type LazyField = "blacklistabilityReview" | "mintAuthority";
type CatalogSource = { id: string } & Partial<Record<LazyField, unknown>>;
type PackedText = [bytes: number, payload: string];
export type PackedRecord = [id: string, bytes: number, payload: string, reviews?: Partial<Record<LazyField, PackedText>>];

function packText(text: string): PackedText {
  const bytes = Buffer.from(text, "utf8");
  return [bytes.length, Buffer.from(gzipSync(bytes, { level: 9, mtime: 0 })).toString("base64")];
}

export function buildWorkerStablecoinCatalog<T extends CatalogSource>(coins: readonly T[]) {
  if (coins.length === 0) {
    throw new Error("Cannot generate an empty Worker stablecoin catalog");
  }
  let maxUncompressedBytes = 0;
  const rows = coins.map((coin): PackedRecord => {
    const record: CatalogSource = { ...coin };
    const reviews: Partial<Record<LazyField, PackedText>> = {};
    for (const field of ["blacklistabilityReview", "mintAuthority"] as const) {
      if (coin[field] == null) continue;
      const packed = packText(JSON.stringify(coin[field]));
      reviews[field] = packed;
      // Preserve property order for byte-identical full-record serialization.
      record[field] = null;
      maxUncompressedBytes = Math.max(maxUncompressedBytes, packed[0]);
    }
    const [bytes, payload] = packText(JSON.stringify(record));
    maxUncompressedBytes = Math.max(maxUncompressedBytes, bytes);
    return Object.keys(reviews).length > 0
      ? [coin.id, bytes, payload, reviews]
      : [coin.id, bytes, payload];
  });
  return { version: 2, maxUncompressedBytes, coins: rows };
}

export function renderWorkerStablecoinCatalog<T extends CatalogSource>(coins: readonly T[]): string {
  return `${JSON.stringify(buildWorkerStablecoinCatalog(coins))}\n`;
}

export function runCli(argv = process.argv.slice(2)): void {
  const { values } = parseStrictCliArgs(argv, { options: { check: { type: "boolean" } } });
  if (values.help) {
    console.log("Usage: generate-worker-stablecoin-catalog.ts [--check]");
    return;
  }
  const coins = JSON.parse(readFileSync(SOURCE_PATH, "utf8")) as CatalogSource[];
  syncGeneratedArtifacts({
    artifacts: [{ path: OUTPUT_PATH, contents: renderWorkerStablecoinCatalog(coins) }],
    check: values.check === true,
    staleMessage: "Worker full catalog is stale. Run `node --import tsx scripts/build-data/generate-worker-stablecoin-catalog.ts`.",
    currentMessage: `Worker full catalog is current for ${coins.length} coins`,
    writtenMessage: `Generated lossless Worker catalog with lazy review evidence for ${coins.length} coins`,
  });
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCli();
}
