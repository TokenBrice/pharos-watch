#!/usr/bin/env node

/**
 * Build-time projection of `shared/data/stablecoins/coins.generated.json`
 * into a slim client-facing JSON consumed by
 * `shared/lib/stablecoins/client-registry.ts`.
 *
 * The full per-coin asset is ~1.37 MiB (391 entries × ~50 fields). Client
 * surfaces read a curated subset of those fields for routing, labels,
 * filtering, classification, reserve coverage summaries, mint-authority coverage
 * classification, and portfolio exposure. This generator drops fields that still
 * belong on server-only paths (`contracts`, `dependencies`,
 * `blacklistabilityReview`, mint-authority review evidence, `featuredContent`,
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
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SOURCE_JSON_REL = "shared/data/stablecoins/coins.generated.json";
const OUTPUT_JSON_REL = "shared/data/stablecoins/coins.client.generated.json";
const CLIENT_META_TS_REL = "shared/types/stablecoin-client-meta.ts";
const SOURCE_JSON_ABS = resolve(REPO_ROOT, SOURCE_JSON_REL);
const OUTPUT_JSON_ABS = resolve(REPO_ROOT, OUTPUT_JSON_REL);
const CLIENT_META_TS_ABS = resolve(REPO_ROOT, CLIENT_META_TS_REL);
const CLIENT_FIELDS_EXPORT = "STABLECOIN_CLIENT_META_FIELDS";
const BLACKLIST_STATUS_FIELD = "blacklistStatus";
const MINT_AUTHORITY_SUMMARY_FIELD = "mintAuthoritySummary";
const LIVE_RESERVE_ADAPTER_FIELD = "liveReserveAdapter";
const GENIUS_FIELD = "genius";
const GENIUS_CLIENT_FIELDS = [
  "applicability",
  "authorizationStatus",
  "issuerPathway",
  "issuerEntity",
  "issuerDomicile",
  "licensingRegulator",
  "stateRegulator",
  "reserveDisclosureUrl",
  "redemptionPolicyPresent",
  "references",
];

/**
 * Read the canonical field allowlist from `shared/types/stablecoin-client-meta.ts`.
 * Order there defines the key order in the emitted JSON so re-runs are
 * byte-identical while keeping TypeScript consumers and this generator on one
 * contract.
 */
export function readCanonicalClientFields(sourcePath = CLIENT_META_TS_ABS) {
  const sourceText = readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let fields = null;

  function unwrapExpression(expression) {
    let current = expression;
    while (
      ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  }

  function visit(node) {
    if (fields) {
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== CLIENT_FIELDS_EXPORT) {
          continue;
        }
        if (!declaration.initializer) {
          throw new Error(`[client-registry] ${CLIENT_FIELDS_EXPORT} has no initializer`);
        }
        const initializer = unwrapExpression(declaration.initializer);
        if (!ts.isArrayLiteralExpression(initializer)) {
          throw new Error(`[client-registry] ${CLIENT_FIELDS_EXPORT} must be an array literal`);
        }
        fields = initializer.elements.map((element, index) => {
          if (!ts.isStringLiteralLike(element)) {
            throw new Error(`[client-registry] ${CLIENT_FIELDS_EXPORT}[${index}] must be a string literal`);
          }
          return element.text;
        });
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (!fields || fields.length === 0) {
    throw new Error(`[client-registry] Could not find ${CLIENT_FIELDS_EXPORT} in ${CLIENT_META_TS_REL}`);
  }

  return fields;
}

export function projectCoin(coin, clientFields) {
  const slim = {};
  for (const field of clientFields) {
    if (Object.prototype.hasOwnProperty.call(coin, field)) {
      slim[field] = field === GENIUS_FIELD ? projectGeniusProfile(coin[field]) : coin[field];
    }
  }
  const blacklistStatus = projectBlacklistStatus(coin);
  if (blacklistStatus !== undefined) {
    slim[BLACKLIST_STATUS_FIELD] = blacklistStatus;
  }
  const mintAuthoritySummary = projectMintAuthoritySummary(coin);
  if (mintAuthoritySummary) {
    slim[MINT_AUTHORITY_SUMMARY_FIELD] = mintAuthoritySummary;
  }
  const liveReserveAdapter = projectLiveReserveAdapter(coin);
  if (liveReserveAdapter !== undefined) {
    slim[LIVE_RESERVE_ADAPTER_FIELD] = liveReserveAdapter;
  }
  return slim;
}

export function projectLiveReserveAdapter(coin) {
  const adapter = coin?.liveReservesConfig?.adapter;
  return typeof adapter === "string" && adapter.length > 0 ? adapter : undefined;
}

export function projectBlacklistStatus(coin) {
  const reviewedStatus = coin?.blacklistabilityReview?.reviewedStatus;
  if (
    typeof reviewedStatus === "boolean"
    || reviewedStatus === "possible"
    || reviewedStatus === "inherited"
  ) {
    return reviewedStatus;
  }

  return undefined;
}

export function projectGeniusProfile(profile) {
  if (profile === null) {
    return null;
  }
  if (!isPlainObject(profile)) {
    return undefined;
  }

  const projected = {};
  for (const field of GENIUS_CLIENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(profile, field)) {
      projected[field] = field === "references" ? projectLinks(profile[field]) : profile[field];
    }
  }
  return projected;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectLinks(links) {
  if (!Array.isArray(links)) {
    return undefined;
  }

  return links
    .filter(isPlainObject)
    .map((link) => {
      const { label, url } = link;
      return typeof label === "string" && typeof url === "string" ? { label, url } : null;
    })
    .filter((link) => link !== null);
}

function projectKeyCustodyAttestation(value) {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const { kind } = value;
  if (kind !== "mpc" && kind !== "hsm") {
    return undefined;
  }

  const sources = projectLinks(value.sources);
  if (!sources || sources.length === 0) {
    return undefined;
  }

  return { kind, sources };
}

function projectMintIncidents(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const incidents = value
    .filter(isPlainObject)
    .map((incident) => {
      const { date, summary } = incident;
      const sources = projectLinks(incident.sources);
      if (typeof date !== "string" || typeof summary !== "string" || !sources || sources.length === 0) {
        return null;
      }
      return { date, summary, sources };
    })
    .filter((incident) => incident !== null);

  return incidents.length > 0 ? incidents : undefined;
}

export function projectMintAuthoritySummary(coin) {
  const profile = coin?.mintAuthority;
  if (!isPlainObject(profile)) {
    return undefined;
  }

  const { mintPath, authorityPosture, confidence, inheritedFrom } = profile;
  if (typeof mintPath !== "string" || typeof authorityPosture !== "string" || typeof confidence !== "string") {
    return undefined;
  }

  const summary = { mintPath, authorityPosture, confidence };
  if (typeof inheritedFrom === "string") {
    summary.inheritedFrom = inheritedFrom;
  }

  const mintIncidents = projectMintIncidents(profile.mintIncidents);
  if (mintIncidents) {
    summary.mintIncidents = mintIncidents;
  }

  const controls = Array.isArray(profile.controls)
    ? profile.controls
        .filter(isPlainObject)
        .map((control) => {
          const {
            authorityType,
            directMintAbility,
            threshold,
            signerCount,
            timelockDelaySec,
            canRaiseCap,
            modulesOrGuardsStatus,
          } = control;
          if (typeof authorityType !== "string" || typeof directMintAbility !== "string") {
            return null;
          }
          // Cross-coin surfaces only score and classify: control labels stay on the
          // detail-page projection, and `canRaiseCap: "unknown"` is scoring-neutral,
          // so neither ships in this payload.
          const controlSummary = { authorityType, directMintAbility };
          if (typeof threshold === "number" && Number.isFinite(threshold)) controlSummary.threshold = threshold;
          if (typeof signerCount === "number" && Number.isFinite(signerCount)) controlSummary.signerCount = signerCount;
          if (typeof timelockDelaySec === "number" && Number.isFinite(timelockDelaySec)) {
            controlSummary.timelockDelaySec = timelockDelaySec;
          }
          if (canRaiseCap === true || canRaiseCap === false) {
            controlSummary.canRaiseCap = canRaiseCap;
          }
          if (typeof modulesOrGuardsStatus === "string") {
            controlSummary.modulesOrGuardsStatus = modulesOrGuardsStatus;
          }
          const keyCustodyAttestation = projectKeyCustodyAttestation(control.keyCustodyAttestation);
          if (keyCustodyAttestation) {
            controlSummary.keyCustodyAttestation = keyCustodyAttestation;
          }
          return controlSummary;
        })
        .filter((control) => control !== null)
    : [];

  if (controls.length > 0) {
    summary.controls = controls;
  }

  return summary;
}

export function validateProjection(slim, sourceCoin, index, clientFields) {
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
  for (const field of clientFields) {
    if (Object.prototype.hasOwnProperty.call(slim, field)) {
      const sourceValue = field === GENIUS_FIELD ? projectGeniusProfile(sourceCoin[field]) : sourceCoin[field];
      const slimValue = slim[field];
      if (JSON.stringify(sourceValue) !== JSON.stringify(slimValue)) {
        throw new Error(
          `[client-registry] entry ${index} (${slim.id}): field ${field} diverges from source`,
        );
      }
    }
  }
}

export function buildClientRegistryOutput({ sourceJsonPath = SOURCE_JSON_ABS, clientFields = readCanonicalClientFields() } = {}) {
  const rawJson = readFileSync(sourceJsonPath, "utf8");
  const parsed = JSON.parse(rawJson);

  if (!Array.isArray(parsed)) {
    throw new Error(`[client-registry] ${SOURCE_JSON_REL} is not a JSON array`);
  }

  const slimCoins = parsed.map((coin, index) => {
    const slim = projectCoin(coin, clientFields);
    validateProjection(slim, coin, index, clientFields);
    return slim;
  });

  return {
    output: `${JSON.stringify(slimCoins, null, 2)}\n`,
    slimCoins,
  };
}

export function runCli({ checkMode = process.argv.includes("--check") } = {}) {
  const { output, slimCoins } = buildClientRegistryOutput();

  if (checkMode) {
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
