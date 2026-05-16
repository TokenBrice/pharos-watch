#!/usr/bin/env node

/**
 * Build-time projection of `shared/data/stablecoins/coins.generated.json`
 * into a slim client-facing JSON consumed by
 * `shared/lib/stablecoins/client-registry.ts`.
 *
 * The full per-coin asset is ~1.37 MiB (391 entries × ~50 fields). Client
 * surfaces only read ~16 of those fields for routing, labels, filtering,
 * and classification. This generator drops the heavy arrays (`reserves`,
 * `contracts`, `dependencies`, `blacklistabilityReview`, `featuredContent`,
 * obituary prose, etc.) and emits an array with deterministic key ordering.
 *
 * The output file is checked in (not generated at runtime) so the Next.js
 * client bundle can `import` it directly without a runtime fetch.
 *
 * Modes:
 *   node scripts/build-data/build-client-registry.mjs           # write file
 *   node scripts/build-data/build-client-registry.mjs --check   # CI guard
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SOURCE_JSON_REL = "shared/data/stablecoins/coins.generated.json";
const OUTPUT_JSON_REL = "shared/data/stablecoins/coins.client.generated.json";
const SOURCE_JSON_ABS = resolve(REPO_ROOT, SOURCE_JSON_REL);
const OUTPUT_JSON_ABS = resolve(REPO_ROOT, OUTPUT_JSON_REL);
const CHECK_MODE = process.argv.includes("--check");

/**
 * Field allowlist. Must match `STABLECOIN_CLIENT_META_FIELDS` in
 * `shared/types/stablecoin-client-meta.ts`. Order here defines the key
 * order in the emitted JSON so re-runs are byte-identical.
 */
const CLIENT_FIELDS = [
  "id",
  "name",
  "symbol",
  "oneLiner",
  "flags",
  "pegMechanism",
  "mechanismArchetype",
  "geckoId",
  "protocolSlug",
  "variantOf",
  "variantKind",
  "status",
  "tags",
  "frozenAt",
  "launchDate",
  "launchPhase",
  "canBeBlacklisted",
  "canBeBlacklistedSource",
  "commodityOunces",
  "infrastructures",
];

function projectCoin(coin) {
  const slim = {};
  for (const field of CLIENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(coin, field)) {
      slim[field] = coin[field];
    }
  }
  return slim;
}

function validateProjection(slim, sourceCoin, index) {
  if (typeof slim.id !== "string" || slim.id.length === 0) {
    throw new Error(`[client-registry] entry ${index}: invalid or missing id`);
  }
  if (typeof slim.name !== "string" || slim.name.length === 0) {
    throw new Error(`[client-registry] entry ${index} (${slim.id}): invalid or missing name`);
  }
  if (typeof slim.symbol !== "string" || slim.symbol.length === 0) {
    throw new Error(`[client-registry] entry ${index} (${slim.id}): invalid or missing symbol`);
  }
  if (!slim.flags || typeof slim.flags !== "object") {
    throw new Error(`[client-registry] entry ${index} (${slim.id}): missing flags`);
  }
  if (typeof slim.flags.pegCurrency !== "string") {
    throw new Error(`[client-registry] entry ${index} (${slim.id}): flags.pegCurrency must be a string`);
  }
  if (typeof slim.flags.backing !== "string") {
    throw new Error(`[client-registry] entry ${index} (${slim.id}): flags.backing must be a string`);
  }
  if (typeof slim.flags.governance !== "string") {
    throw new Error(`[client-registry] entry ${index} (${slim.id}): flags.governance must be a string`);
  }
  // Drift guard: any field present in the slim projection must equal the
  // source value. Catches generator bugs that silently mutate values.
  for (const field of CLIENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(slim, field)) {
      const sourceValue = sourceCoin[field];
      const slimValue = slim[field];
      if (JSON.stringify(sourceValue) !== JSON.stringify(slimValue)) {
        throw new Error(
          `[client-registry] entry ${index} (${slim.id}): field ${field} diverges from source`,
        );
      }
    }
  }
}

const rawJson = readFileSync(SOURCE_JSON_ABS, "utf8");
const parsed = JSON.parse(rawJson);

if (!Array.isArray(parsed)) {
  console.error(`[client-registry] ${SOURCE_JSON_REL} is not a JSON array`);
  process.exit(1);
}

const slimCoins = parsed.map((coin, index) => {
  const slim = projectCoin(coin);
  validateProjection(slim, coin, index);
  return slim;
});

const output = `${JSON.stringify(slimCoins, null, 2)}\n`;

if (CHECK_MODE) {
    const current = existsSync(OUTPUT_JSON_ABS) ? readFileSync(OUTPUT_JSON_ABS, "utf8") : "";
  if (current !== output) {
    console.error(
      `${OUTPUT_JSON_REL} is stale. Run: node scripts/build-data/build-client-registry.mjs`,
    );
    process.exit(1);
  }
  console.log(
    `${OUTPUT_JSON_REL}: client registry is current (${slimCoins.length} entries, ${output.length} bytes)`,
  );
} else {
  mkdirSync(dirname(OUTPUT_JSON_ABS), { recursive: true });
    writeFileSync(OUTPUT_JSON_ABS, output, "utf8");
  console.log(
    `${OUTPUT_JSON_REL}: wrote client registry (${slimCoins.length} entries, ${output.length} bytes)`,
  );
}
