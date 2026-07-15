#!/usr/bin/env node

/**
 * Build-time projection of `shared/data/stablecoins/coins.generated.json`
 * into slim client-facing JSON consumed by
 * `shared/lib/stablecoins/client-registry.ts`, the compliance route, and the
 * bundled Telegram Mini App catalog.
 *
 * Client surfaces read a curated subset of the full generated registry fields
 * for routing, labels, filtering, classification, reserve coverage summaries,
 * mint-authority coverage classification, and portfolio exposure. This generator
 * drops fields that still belong on server-only paths (`contracts`, `dependencies`,
 * `blacklistabilityReview`, mint-authority review evidence, `featuredContent`,
 * obituary prose, etc.) and emits an array with deterministic key ordering.
 *
 * The output files are checked in (not generated at runtime) so Next.js client
 * bundles can `import` them directly without runtime fetches.
 *
 * Modes:
 *   node scripts/build-data/build-client-registry.mjs           # write file
 *   node scripts/build-data/build-client-registry.mjs --check   # CI guard
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

/** @typedef {import("../../shared/types/stablecoin-client-meta").StablecoinClientMeta} StablecoinClientMeta */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SOURCE_JSON_REL = "shared/data/stablecoins/coins.generated.json";
const LISTING_DECISIONS_JSON_REL = "shared/data/stablecoins/listing-decisions.json";
const OUTPUT_JSON_REL = "shared/data/stablecoins/coins.client.generated.json";
const COMPLIANCE_OUTPUT_JSON_REL = "shared/data/stablecoins/coins.compliance.generated.json";
const TELEGRAM_MINI_APP_OUTPUT_JSON_REL = "shared/data/stablecoins/coins.telegram-mini-app.generated.json";
const CLIENT_META_TS_REL = "shared/types/stablecoin-client-meta.ts";
const SOURCE_JSON_ABS = resolve(REPO_ROOT, SOURCE_JSON_REL);
const LISTING_DECISIONS_JSON_ABS = resolve(REPO_ROOT, LISTING_DECISIONS_JSON_REL);
const OUTPUT_JSON_ABS = resolve(REPO_ROOT, OUTPUT_JSON_REL);
const COMPLIANCE_OUTPUT_JSON_ABS = resolve(REPO_ROOT, COMPLIANCE_OUTPUT_JSON_REL);
const TELEGRAM_MINI_APP_OUTPUT_JSON_ABS = resolve(REPO_ROOT, TELEGRAM_MINI_APP_OUTPUT_JSON_REL);
const CLIENT_META_TS_ABS = resolve(REPO_ROOT, CLIENT_META_TS_REL);
const CLIENT_FIELDS_EXPORT = "STABLECOIN_CLIENT_META_FIELDS";
const GENIUS_CLIENT_FIELDS_EXPORT = "GENIUS_CLIENT_PROFILE_FIELDS";
const GENIUS_COMPLIANCE_FIELDS_EXPORT = "GENIUS_COMPLIANCE_PROFILE_FIELDS";
const BLACKLIST_STATUS_FIELD = "blacklistStatus";
const MINT_AUTHORITY_SUMMARY_FIELD = "mintAuthoritySummary";
const LIVE_RESERVE_ADAPTER_FIELD = "liveReserveAdapter";
const GENIUS_FIELD = "genius";
const LISTING_CLASS_FIELD = "listingClass";
const LISTING_CLASS_VALUES = new Set([
  "core-stablecoin",
  "cash-equivalent",
  "stablecoin-variant",
  "stable-value-investment",
  "excluded",
]);

function readListingClassById(sourcePath = LISTING_DECISIONS_JSON_ABS) {
  const parsed = JSON.parse(readFileSync(sourcePath, "utf8"));
  if (!isPlainObject(parsed?.listingClassById)) {
    throw new Error(`[client-registry] ${LISTING_DECISIONS_JSON_REL} has no listingClassById map`);
  }
  const byId = new Map();
  for (const [id, listingClass] of Object.entries(parsed.listingClassById)) {
    if (!LISTING_CLASS_VALUES.has(listingClass)) {
      throw new Error(`[client-registry] invalid listing class for ${id} in ${LISTING_DECISIONS_JSON_REL}`);
    }
    byId.set(id, listingClass);
  }
  return byId;
}

/**
 * Read the canonical field allowlist from `shared/types/stablecoin-client-meta.ts`.
 * Order there defines the key order in the emitted JSON so re-runs are
 * byte-identical while keeping TypeScript consumers and this generator on one
 * contract.
 */
function readStringLiteralArrayExport(exportName, sourcePath = CLIENT_META_TS_ABS) {
  const sourceText = readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let fields = null;

  function unwrapExpression(expression) {
    let current = expression;
    while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
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
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== exportName) {
          continue;
        }
        if (!declaration.initializer) {
          throw new Error(`[client-registry] ${exportName} has no initializer`);
        }
        const initializer = unwrapExpression(declaration.initializer);
        if (!ts.isArrayLiteralExpression(initializer)) {
          throw new Error(`[client-registry] ${exportName} must be an array literal`);
        }
        fields = initializer.elements.map((element, index) => {
          if (!ts.isStringLiteralLike(element)) {
            throw new Error(`[client-registry] ${exportName}[${index}] must be a string literal`);
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
    throw new Error(`[client-registry] Could not find ${exportName} in ${CLIENT_META_TS_REL}`);
  }

  return fields;
}

export function readCanonicalClientFields(sourcePath = CLIENT_META_TS_ABS) {
  return readStringLiteralArrayExport(CLIENT_FIELDS_EXPORT, sourcePath);
}

export function readGeniusClientFields(sourcePath = CLIENT_META_TS_ABS) {
  return readStringLiteralArrayExport(GENIUS_CLIENT_FIELDS_EXPORT, sourcePath);
}

export function readGeniusComplianceFields(sourcePath = CLIENT_META_TS_ABS) {
  return readStringLiteralArrayExport(GENIUS_COMPLIANCE_FIELDS_EXPORT, sourcePath);
}

const DEFAULT_GENIUS_CLIENT_FIELDS = readGeniusClientFields();
const DEFAULT_GENIUS_COMPLIANCE_FIELDS = readGeniusComplianceFields();

/** @returns {Partial<StablecoinClientMeta>} */
export function projectCoin(coin, clientFields, geniusClientFields = DEFAULT_GENIUS_CLIENT_FIELDS) {
  const slim = {};
  for (const field of clientFields) {
    if (Object.prototype.hasOwnProperty.call(coin, field)) {
      slim[field] = field === GENIUS_FIELD ? projectGeniusProfile(coin[field], geniusClientFields) : coin[field];
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
  if (typeof reviewedStatus === "boolean" || reviewedStatus === "possible" || reviewedStatus === "inherited") {
    return reviewedStatus;
  }

  return undefined;
}

export function projectGeniusProfile(profile, geniusClientFields = DEFAULT_GENIUS_CLIENT_FIELDS) {
  if (profile === null) {
    return null;
  }
  if (!isPlainObject(profile)) {
    return undefined;
  }

  const projected = {};
  for (const field of geniusClientFields) {
    if (Object.prototype.hasOwnProperty.call(profile, field)) {
      projected[field] = projectGeniusField(field, profile[field]);
    }
  }
  return projected;
}

function projectGeniusField(field, value) {
  if (field === "references") {
    return projectLinks(value);
  }
  if (field === "applicabilityBasis" || field === "foreignExceptionEvidence") {
    return projectGeniusEvidence(value);
  }
  if (field === "negativeEvidenceReview") {
    return projectGeniusNegativeEvidenceReview(value);
  }
  return value;
}

function projectGeniusEvidence(value) {
  if (!isPlainObject(value) || typeof value.summary !== "string") {
    return undefined;
  }

  const projected = { summary: value.summary };
  const references = projectLinks(value.references);
  if (references && references.length > 0) {
    projected.references = references;
  }
  return projected;
}

function projectGeniusNegativeEvidenceReview(value) {
  if (!isPlainObject(value) || typeof value.summary !== "string") {
    return undefined;
  }

  const sourcesChecked = Array.isArray(value.sourcesChecked)
    ? value.sourcesChecked.filter((source) => typeof source === "string" && source.length > 0)
    : [];
  if (sourcesChecked.length === 0) {
    return undefined;
  }

  const projected = {
    sourcesChecked,
    summary: value.summary,
  };
  if (typeof value.reviewer === "string") {
    projected.reviewer = value.reviewer;
  }
  if (typeof value.reviewedAt === "string") {
    projected.reviewedAt = value.reviewedAt;
  }
  const references = projectLinks(value.references);
  if (references && references.length > 0) {
    projected.references = references;
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
      if (typeof label !== "string" || typeof url !== "string") {
        return null;
      }
      const projected = { label, url };
      if (typeof link.sourceKind === "string") {
        projected.sourceKind = link.sourceKind;
      }
      if (typeof link.sourceDate === "string") {
        projected.sourceDate = link.sourceDate;
      }
      if (typeof link.accessedAt === "string") {
        projected.accessedAt = link.accessedAt;
      }
      return projected;
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
      const { date, status, resolvedAt, summary } = incident;
      const sources = projectLinks(incident.sources);
      if (
        typeof date !== "string" ||
        (status !== "active" && status !== "resolved") ||
        typeof summary !== "string" ||
        !sources ||
        sources.length === 0
      ) {
        return null;
      }
      return {
        date,
        status,
        ...(typeof resolvedAt === "string" ? { resolvedAt } : {}),
        summary,
        sources,
      };
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
          // detail-page projection, while cap mutability must remain available for
          // the Mint Authority bounds component.
          const controlSummary = { authorityType, directMintAbility };
          if (typeof threshold === "number" && Number.isFinite(threshold)) controlSummary.threshold = threshold;
          if (typeof signerCount === "number" && Number.isFinite(signerCount)) controlSummary.signerCount = signerCount;
          if (typeof timelockDelaySec === "number" && Number.isFinite(timelockDelaySec)) {
            controlSummary.timelockDelaySec = timelockDelaySec;
          }
          if (canRaiseCap === true || canRaiseCap === false || canRaiseCap === "unknown") {
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

export function validateProjection(
  slim,
  sourceCoin,
  index,
  clientFields,
  geniusClientFields = DEFAULT_GENIUS_CLIENT_FIELDS,
) {
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
      const sourceValue =
        field === GENIUS_FIELD ? projectGeniusProfile(sourceCoin[field], geniusClientFields) : sourceCoin[field];
      const slimValue = slim[field];
      if (JSON.stringify(sourceValue) !== JSON.stringify(slimValue)) {
        throw new Error(`[client-registry] entry ${index} (${slim.id}): field ${field} diverges from source`);
      }
    }
  }
}

export function validateGeniusComplianceProjection(
  entry,
  sourceCoin,
  index,
  geniusComplianceFields = DEFAULT_GENIUS_COMPLIANCE_FIELDS,
) {
  if (typeof entry.id !== "string" || entry.id.length === 0) {
    throw new Error(`[client-registry] compliance entry ${index}: invalid or missing id`);
  }
  if (entry.id !== sourceCoin.id) {
    throw new Error(
      `[client-registry] compliance entry ${index} (${entry.id}): id diverges from source ${sourceCoin.id}`,
    );
  }

  const sourceValue = projectGeniusProfile(sourceCoin.genius, geniusComplianceFields);
  if (JSON.stringify(sourceValue) !== JSON.stringify(entry.genius)) {
    throw new Error(`[client-registry] compliance entry ${index} (${entry.id}): genius profile diverges from source`);
  }
}

export function buildClientRegistryOutput({
  sourceJsonPath = SOURCE_JSON_ABS,
  listingDecisionsJsonPath = LISTING_DECISIONS_JSON_ABS,
  clientFields = readCanonicalClientFields(),
  geniusClientFields = DEFAULT_GENIUS_CLIENT_FIELDS,
} = {}) {
  const rawJson = readFileSync(sourceJsonPath, "utf8");
  const parsed = JSON.parse(rawJson);
  const listingClassById = readListingClassById(listingDecisionsJsonPath);

  if (!Array.isArray(parsed)) {
    throw new Error(`[client-registry] ${SOURCE_JSON_REL} is not a JSON array`);
  }

  const slimCoins = parsed.map((coin, index) => {
    const slim = projectCoin(coin, clientFields, geniusClientFields);
    const listingClass = listingClassById.get(coin.id);
    if (!listingClass) {
      throw new Error(`[client-registry] entry ${index} (${coin.id}): missing listing decision`);
    }
    slim[LISTING_CLASS_FIELD] = listingClass;
    validateProjection(slim, coin, index, clientFields, geniusClientFields);
    return slim;
  });

  return {
    output: `${JSON.stringify(slimCoins, null, 2)}\n`,
    slimCoins,
  };
}

export function buildComplianceRegistryOutput({
  sourceJsonPath = SOURCE_JSON_ABS,
  geniusComplianceFields = DEFAULT_GENIUS_COMPLIANCE_FIELDS,
} = {}) {
  const rawJson = readFileSync(sourceJsonPath, "utf8");
  const parsed = JSON.parse(rawJson);

  if (!Array.isArray(parsed)) {
    throw new Error(`[client-registry] ${SOURCE_JSON_REL} is not a JSON array`);
  }

  const geniusEntries = [];
  parsed.forEach((coin, index) => {
    const genius = projectGeniusProfile(coin.genius, geniusComplianceFields);
    if (!genius || !isPlainObject(genius)) {
      return;
    }
    const entry = { id: coin.id, genius };
    validateGeniusComplianceProjection(entry, coin, index, geniusComplianceFields);
    geniusEntries.push(entry);
  });

  return {
    output: `${JSON.stringify(geniusEntries, null, 2)}\n`,
    geniusEntries,
  };
}

export function buildTelegramMiniAppCatalogOutput({ sourceJsonPath = SOURCE_JSON_ABS } = {}) {
  const rawJson = readFileSync(sourceJsonPath, "utf8");
  const parsed = JSON.parse(rawJson);

  if (!Array.isArray(parsed)) {
    throw new Error(`[client-registry] ${SOURCE_JSON_REL} is not a JSON array`);
  }

  const searchableCoins = parsed
    .filter((coin) => !["frozen", "quarantined", "delisted"].includes(coin.status ?? "active"))
    .map((coin, index) => {
      if (
        typeof coin.id !== "string" ||
        typeof coin.symbol !== "string" ||
        typeof coin.name !== "string" ||
        typeof coin.flags?.pegCurrency !== "string"
      ) {
        throw new Error(`[client-registry] Mini App catalog entry ${index} has invalid metadata`);
      }
      return {
        stablecoinId: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        peg: coin.flags.pegCurrency,
        status: coin.status ?? "active",
      };
    });

  return {
    output: `${JSON.stringify(searchableCoins, null, 2)}\n`,
    searchableCoins,
  };
}

export function runCli({ checkMode = process.argv.includes("--check") } = {}) {
  const { output, slimCoins } = buildClientRegistryOutput();
  const { output: complianceOutput, geniusEntries } = buildComplianceRegistryOutput();
  const { output: telegramMiniAppOutput, searchableCoins } = buildTelegramMiniAppCatalogOutput();

  if (checkMode) {
    const current = existsSync(OUTPUT_JSON_ABS) ? readFileSync(OUTPUT_JSON_ABS, "utf8") : "";
    const currentCompliance = existsSync(COMPLIANCE_OUTPUT_JSON_ABS)
      ? readFileSync(COMPLIANCE_OUTPUT_JSON_ABS, "utf8")
      : "";
    const currentTelegramMiniApp = existsSync(TELEGRAM_MINI_APP_OUTPUT_JSON_ABS)
      ? readFileSync(TELEGRAM_MINI_APP_OUTPUT_JSON_ABS, "utf8")
      : "";
    if (
      current !== output ||
      currentCompliance !== complianceOutput ||
      currentTelegramMiniApp !== telegramMiniAppOutput
    ) {
      console.error(
        `${OUTPUT_JSON_REL}, ${COMPLIANCE_OUTPUT_JSON_REL}, or ${TELEGRAM_MINI_APP_OUTPUT_JSON_REL} is stale. Run: node scripts/build-data/build-client-registry.mjs`,
      );
      process.exit(1);
    }
    console.log(`${OUTPUT_JSON_REL}: client registry is current (${slimCoins.length} entries, ${output.length} bytes)`);
    console.log(
      `${COMPLIANCE_OUTPUT_JSON_REL}: compliance registry is current (${geniusEntries.length} GENIUS entries, ${complianceOutput.length} bytes)`,
    );
    console.log(
      `${TELEGRAM_MINI_APP_OUTPUT_JSON_REL}: Mini App catalog is current (${searchableCoins.length} entries, ${telegramMiniAppOutput.length} bytes)`,
    );
  } else {
    mkdirSync(dirname(OUTPUT_JSON_ABS), { recursive: true });
    writeFileSync(OUTPUT_JSON_ABS, output, "utf8");
    mkdirSync(dirname(COMPLIANCE_OUTPUT_JSON_ABS), { recursive: true });
    writeFileSync(COMPLIANCE_OUTPUT_JSON_ABS, complianceOutput, "utf8");
    mkdirSync(dirname(TELEGRAM_MINI_APP_OUTPUT_JSON_ABS), { recursive: true });
    writeFileSync(TELEGRAM_MINI_APP_OUTPUT_JSON_ABS, telegramMiniAppOutput, "utf8");
    console.log(`${OUTPUT_JSON_REL}: wrote client registry (${slimCoins.length} entries, ${output.length} bytes)`);
    console.log(
      `${COMPLIANCE_OUTPUT_JSON_REL}: wrote compliance registry (${geniusEntries.length} GENIUS entries, ${complianceOutput.length} bytes)`,
    );
    console.log(
      `${TELEGRAM_MINI_APP_OUTPUT_JSON_REL}: wrote Mini App catalog (${searchableCoins.length} entries, ${telegramMiniAppOutput.length} bytes)`,
    );
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCli();
}
