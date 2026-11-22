#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCliUsage, parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { buildSocialPreviewImages } from "../lib/social-preview-build";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const USAGE = `Generate destination-specific evergreen social previews.

Usage: npm run build:og-evergreen -- [--check | --map-only | --out-dir <path>]

  (default)         Write the route map and render every current PNG missing from public/og/v2
                    (or map-only when PHAROS_OG_EVERGREEN_MAP_ONLY=1 without --check/--shard/--out-dir).
  --map-only        Write only the route map without rendering PNGs.
  --check           Validate catalog, identities, copy and covers in memory; read no ignored output, write nothing.
  --out-dir <path>  Render PNGs into <path> (relative to repo root or absolute) instead of public/og/v2.
  --shard K/N       Render only the K-th of N slices of the missing PNGs and write no map.
  -h, --help        Show this help.

A URL hashes the drawn fields and the bytes and versions that render them, so
equal drawings share one URL and any input change renders a new one. PNGs are
not tracked: R2 evergreen/v2/ keeps every published URL permanently.
`;

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: {
      check: { type: "boolean" },
      "map-only": { type: "boolean" },
      "out-dir": { type: "string" },
      shard: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    conflicts: [["check", "map-only"], ["check", "shard"], ["map-only", "shard"], ["check", "out-dir"], ["map-only", "out-dir"]],
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  const outDirRaw = values["out-dir"];
  const outDir = typeof outDirRaw === "string" ? outDirRaw.trim() : undefined;
  assertCliUsage(outDirRaw === undefined || (outDir !== undefined && outDir.length > 0), "--out-dir must be nonblank");
  const mapOnlyEnv = process.env.PHAROS_OG_EVERGREEN_MAP_ONLY === "1" && !values.check && !values.shard && outDir === undefined;
  const mode = values.check ? "check" : values["map-only"] || mapOnlyEnv ? "map" : "render";
  const shardArg = typeof values.shard === "string" ? values.shard : undefined;
  const shardMatch = shardArg === undefined ? null : /^(\d+)\/(\d+)$/.exec(shardArg);
  if (shardArg !== undefined && (!shardMatch || Number(shardMatch[1]) >= Number(shardMatch[2]))) throw new Error(`--shard must be K/N with K < N: ${shardArg}`);
  const shard = shardMatch ? { index: Number(shardMatch[1]), count: Number(shardMatch[2]) } : undefined;
  const result = await buildSocialPreviewImages({ repoRoot: REPO_ROOT, mode, outDir, shard });
  console.log(`${mode === "check" ? "Verified" : "Mapped"} ${result.routes} destination previews (${result.images} images); rendered ${result.rendered} new PNGs.`);
}

runDirectCli(import.meta.url, main);
