#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCanonicalStablecoinId } from "@shared/lib/stablecoin-id";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT_JSON_REL = "shared/data/stablecoins/legacy-llama-redirects.generated.json";

interface StablecoinRedirectSource {
  llamaId?: unknown;
  id: string;
}

/** Historical identity is independent of the catalog's current ingestion provider. */
export function buildLegacyStablecoinRedirects(
  source: StablecoinRedirectSource[],
  historical: Record<string, string>,
  pagesRedirects: string,
): Record<string, string> {
  const knownIds = new Set(source.map((coin) => coin.id));
  const redirects = new Map<string, string>();
  function add(alias: string, destination: string) {
    const targetId = destination.match(/^\/stablecoin\/([^/]+)\/$/)?.[1];
    if (!isCanonicalStablecoinId(alias) || knownIds.has(alias)
      || !(targetId ? knownIds.has(targetId) : ["/coverage/", "/cemetery/"].includes(destination))) {
      throw new Error(`Invalid legacy stablecoin redirect: ${alias} -> ${destination}`);
    }
    const existing = redirects.get(alias);
    if (existing && existing !== destination) {
      throw new Error(`Conflicting legacy stablecoin redirect: ${alias} -> ${existing} / ${destination}`);
    }
    redirects.set(alias, destination);
  }
  for (const [alias, destination] of Object.entries(historical)) add(alias, destination);
  for (const coin of source) {
    if (typeof coin.llamaId === "string" && coin.llamaId.length > 0) {
      add(coin.llamaId, `/stablecoin/${coin.id}/`);
    }
  }
  // Reuse the authored retirement policy; explicitly enforce it in the Function too.
  for (const line of pagesRedirects.split("\n")) {
    const match = line.match(/^\/stablecoin\/([^/*]+)\/?\s+(\S+)\s+301\s*$/);
    if (match) add(match[1], match[2]);
  }
  return Object.fromEntries([...redirects].sort(([left], [right]) => left.localeCompare(right)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const readJson = (path: string) => JSON.parse(readFileSync(resolve(REPO_ROOT, path), "utf8"));
  const redirects = buildLegacyStablecoinRedirects(
    readJson("shared/data/stablecoins/coins.generated.json"),
    readJson("shared/data/stablecoins/legacy-route-redirects.json"),
    readFileSync(resolve(REPO_ROOT, "public/_redirects"), "utf8"),
  );
  syncGeneratedArtifacts({
    artifacts: [{ path: resolve(REPO_ROOT, OUTPUT_JSON_REL), contents: `${JSON.stringify(redirects, null, 2)}\n` }],
    check: process.argv.includes("--check"),
    staleMessage: `${OUTPUT_JSON_REL} is stale. Run \`node --import tsx scripts/maintenance/generate-legacy-stablecoin-redirects.ts\`.`,
    currentMessage: `${OUTPUT_JSON_REL}: legacy redirect map is current (${Object.keys(redirects).length} entries)`,
    writtenMessage: `${OUTPUT_JSON_REL}: wrote legacy redirect map (${Object.keys(redirects).length} entries)`,
  });
}
