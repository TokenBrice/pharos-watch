#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { buildSocialPreviewImages } from "../lib/social-preview-build";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const USAGE = `Generate destination-specific evergreen social previews.

Usage: npm run build:og-evergreen -- [--check | --map-only]

  (default)   Write the route map and render every current PNG missing from public/og/v2.
  --map-only  Write only the route map (bootstrap); the Pages build renders the PNGs.
  --check     Validate catalog, identities, copy and covers in memory; read no ignored output, write nothing.
  -h, --help  Show this help.

A URL hashes the drawn fields and the bytes and versions that render them, so
equal drawings share one URL and any input change renders a new one. PNGs are
not tracked: each deployment carries the current set and R2 evergreen/v2/ keeps
every published URL.
`;

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: { check: { type: "boolean" }, "map-only": { type: "boolean" }, help: { type: "boolean", short: "h" } },
    conflicts: [["check", "map-only"]],
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  const mode = values.check ? "check" : values["map-only"] ? "map" : "render";
  const result = await buildSocialPreviewImages({ repoRoot: REPO_ROOT, mode });
  console.log(`${mode === "check" ? "Verified" : "Mapped"} ${result.routes} destination previews (${result.images} images); rendered ${result.rendered} new PNGs.`);
}

runDirectCli(import.meta.url, main);
