#!/usr/bin/env node

/**
 * `AGENTS.md` is a byte-for-byte copy of `CLAUDE.md`.
 *
 * The two files exist because different agent harnesses look for different
 * filenames; they are not two documents. Generating one from the other makes
 * drift impossible instead of merely detectable, so edits go to `CLAUDE.md`
 * and this generator republishes `AGENTS.md`.
 *
 * Scoped `AGENTS.md` files under `src/`, `shared/`, `worker/`, `functions/`,
 * and `shared/data/stablecoins/` are hand-written and untouched by this script.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_REL = "CLAUDE.md";
const OUTPUT_REL = "AGENTS.md";
const SOURCE_ABS = resolve(REPO_ROOT, SOURCE_REL);
const OUTPUT_ABS = resolve(REPO_ROOT, OUTPUT_REL);
const CHECK_MODE = process.argv.includes("--check");

const contents = readFileSync(SOURCE_ABS, "utf8");

syncGeneratedArtifacts({
  artifacts: [{ path: OUTPUT_ABS, contents }],
  check: CHECK_MODE,
  staleMessage: `${OUTPUT_REL} is stale. Run \`node --import tsx scripts/maintenance/generate-agents-doc.ts\`.`,
  currentMessage: `${OUTPUT_REL}: matches ${SOURCE_REL}`,
  writtenMessage: `${OUTPUT_REL}: republished from ${SOURCE_REL} (${contents.length} bytes)`,
});
