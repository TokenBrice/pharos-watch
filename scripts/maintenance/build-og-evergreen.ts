#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { buildSocialPreviewImages } from "../lib/social-preview-build";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const USAGE = `Generate destination-specific evergreen social previews.

Usage: npm run build:og-evergreen -- [--check]

  --check  Verify exact source closure, route map and every retained PNG; never write.
  -h, --help  Show this help.

New semantic content creates a new /og/v2/ hash URL. Existing URLs are never
re-rendered, overwritten, expired or pruned. Restore corrupted retained files
from version control; there is deliberately no --force or rebaseline option.
`;

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: { check: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  const result = await buildSocialPreviewImages({ repoRoot: REPO_ROOT, check: values.check === true });
  console.log(`${values.check ? "Verified" : "Published"} ${result.routes} destination previews; ${result.rendered} new immutable PNGs.`);
}

runDirectCli(import.meta.url, main);
