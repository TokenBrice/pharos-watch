#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SOURCE_JSON_REL = "shared/data/stablecoins/coins.generated.json";
const OUTPUT_JSON_REL = "shared/data/stablecoins/legacy-llama-redirects.generated.json";
const SOURCE_JSON_ABS = resolve(REPO_ROOT, SOURCE_JSON_REL);
const OUTPUT_JSON_ABS = resolve(REPO_ROOT, OUTPUT_JSON_REL);
const CHECK_MODE = process.argv.includes("--check");

interface StablecoinRedirectSource {
  llamaId?: unknown;
  id?: unknown;
}

const source = JSON.parse(readFileSync(SOURCE_JSON_ABS, "utf8")) as StablecoinRedirectSource[];
if (!Array.isArray(source)) {
  console.error(`[legacy-stablecoin-redirects] ${SOURCE_JSON_REL} is not a JSON array`);
  process.exit(1);
}

const redirects = Object.fromEntries(
  source
  .filter(
    (coin): coin is { llamaId: string; id: string } =>
      typeof coin.llamaId === "string" && coin.llamaId.length > 0 && typeof coin.id === "string",
  )
    .map((coin) => [coin.llamaId, coin.id])
    .sort(([left], [right]) => Number(left) - Number(right)),
);
const contents = `${JSON.stringify(redirects, null, 2)}\n`;

syncGeneratedArtifacts({
  artifacts: [{ path: OUTPUT_JSON_ABS, contents }],
  check: CHECK_MODE,
  staleMessage: `${OUTPUT_JSON_REL} is stale. Run \`node --import tsx scripts/maintenance/generate-legacy-stablecoin-redirects.ts\`.`,
  currentMessage: `${OUTPUT_JSON_REL}: legacy redirect map is current (${Object.keys(redirects).length} entries)`,
  writtenMessage: `${OUTPUT_JSON_REL}: wrote legacy redirect map (${Object.keys(redirects).length} entries)`,
});
