#!/usr/bin/env node

/**
 * Build-time projections of `shared/data/stablecoins/coins.generated.json`
 * into compact browser- and Worker-facing JSON consumed by
 * `shared/lib/stablecoins/client-registry.ts`, the compliance route, and the
 * bundled Telegram Mini App catalog.
 *
 * The browser registry is split into one small canonical list and one
 * on-demand detail JSON per coin. The list is intentionally limited to
 * identity, lifecycle, filtering, and compact badge fields; evidence-heavy
 * metadata is loaded only when a detail surface asks for it.
 *
 * Modes:
 *   node scripts/build-data/build-client-registry.mjs           # write files
 *   node scripts/build-data/build-client-registry.mjs --check   # CI guard
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { parseSourceFile } from "../lib/ts-ast.mts";

/** @typedef {import("../../shared/types/stablecoin-client-meta").StablecoinClientMeta} StablecoinClientMeta */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SOURCE_JSON_REL = "shared/data/stablecoins/coins.generated.json";
const CANONICAL_ORDER_JSON_REL = "shared/data/stablecoins/canonical-order.json";
const LISTING_DECISIONS_JSON_REL = "shared/data/stablecoins/listing-decisions.json";
const LIST_OUTPUT_JSON_REL = "shared/data/stablecoins/coins.client.list.generated.json";
const DETAIL_OUTPUT_DIR_REL = "shared/data/stablecoins/coins.client.detail";
const COMPLIANCE_OUTPUT_JSON_REL = "shared/data/stablecoins/coins.compliance.generated.json";
const TELEGRAM_MINI_APP_OUTPUT_JSON_REL = "shared/data/stablecoins/coins.telegram-mini-app.generated.json";
const WORKER_RUNTIME_OUTPUT_JSON_REL = "shared/data/stablecoins/coins.worker-runtime.generated.json";
const CLIENT_META_TS_REL = "shared/types/stablecoin-client-meta.ts";
const SOURCE_JSON_ABS = resolve(REPO_ROOT, SOURCE_JSON_REL);
const CANONICAL_ORDER_JSON_ABS = resolve(REPO_ROOT, CANONICAL_ORDER_JSON_REL);
const LISTING_DECISIONS_JSON_ABS = resolve(REPO_ROOT, LISTING_DECISIONS_JSON_REL);
const LIST_OUTPUT_JSON_ABS = resolve(REPO_ROOT, LIST_OUTPUT_JSON_REL);
const DETAIL_OUTPUT_DIR_ABS = resolve(REPO_ROOT, DETAIL_OUTPUT_DIR_REL);
const COMPLIANCE_OUTPUT_JSON_ABS = resolve(REPO_ROOT, COMPLIANCE_OUTPUT_JSON_REL);
const TELEGRAM_MINI_APP_OUTPUT_JSON_ABS = resolve(REPO_ROOT, TELEGRAM_MINI_APP_OUTPUT_JSON_REL);
const WORKER_RUNTIME_OUTPUT_JSON_ABS = resolve(REPO_ROOT, WORKER_RUNTIME_OUTPUT_JSON_REL);
const CLIENT_META_TS_ABS = resolve(REPO_ROOT, CLIENT_META_TS_REL);
const CLIENT_LIST_FIELDS_EXPORT = "STABLECOIN_CLIENT_LIST_FIELDS";
const CLIENT_DETAIL_FIELDS_EXPORT = "STABLECOIN_CLIENT_DETAIL_FIELDS";
const GENIUS_CLIENT_FIELDS_EXPORT = "GENIUS_CLIENT_PROFILE_FIELDS";
const GENIUS_COMPLIANCE_FIELDS_EXPORT = "GENIUS_COMPLIANCE_PROFILE_FIELDS";
const BLACKLIST_STATUS_FIELD = "blacklistStatus";
const MINT_AUTHORITY_SUMMARY_FIELD = "mintAuthoritySummary";
const MINT_AUTHORITY_STATUS_FIELD = "mintAuthorityStatus";
const MICA_COMPLIANCE_FIELDS = [
  "status",
  "tokenType",
  "authorizationType",
  "competentAuthority",
  "authorizedEntity",
  "significant",
  "references",
];
const LIVE_RESERVE_ADAPTER_FIELD = "liveReserveAdapter";
const GENIUS_FIELD = "genius";
const LISTING_CLASS_FIELD = "listingClass";
const CHAIN_IDS_FIELD = "chainIds";
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
  const { sourceFile } = parseSourceFile(sourcePath);
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
  return readStringLiteralArrayExport(CLIENT_LIST_FIELDS_EXPORT, sourcePath);
}

export function readCanonicalClientDetailFields(sourcePath = CLIENT_META_TS_ABS) {
  return readStringLiteralArrayExport(CLIENT_DETAIL_FIELDS_EXPORT, sourcePath);
}

export function readGeniusClientFields(sourcePath = CLIENT_META_TS_ABS) {
  return readStringLiteralArrayExport(GENIUS_CLIENT_FIELDS_EXPORT, sourcePath);
}

export function readGeniusComplianceFields(sourcePath = CLIENT_META_TS_ABS) {
  return readStringLiteralArrayExport(GENIUS_COMPLIANCE_FIELDS_EXPORT, sourcePath);
}

const DEFAULT_GENIUS_CLIENT_FIELDS = readGeniusClientFields();
const DEFAULT_GENIUS_COMPLIANCE_FIELDS = readGeniusComplianceFields();

function projectRawCoin(coin, clientFields, geniusClientFields = DEFAULT_GENIUS_CLIENT_FIELDS) {
  const projected = {};
  for (const field of clientFields) {
    if (Object.prototype.hasOwnProperty.call(coin, field)) {
      projected[field] = field === GENIUS_FIELD ? projectGeniusProfile(coin[field], geniusClientFields) : coin[field];
    }
  }
  return projected;
}

/** @returns {Partial<StablecoinClientMeta>} */
export function projectCoin(coin, clientFields, geniusClientFields = DEFAULT_GENIUS_CLIENT_FIELDS) {
  const projected = projectRawCoin(coin, clientFields, geniusClientFields);
  const blacklistStatus = projectBlacklistStatus(coin);
  if (blacklistStatus !== undefined) projected[BLACKLIST_STATUS_FIELD] = blacklistStatus;
  const mintAuthoritySummary = projectMintAuthoritySummary(coin);
  if (mintAuthoritySummary) projected[MINT_AUTHORITY_SUMMARY_FIELD] = mintAuthoritySummary;
  const liveReserveAdapter = projectLiveReserveAdapter(coin);
  if (liveReserveAdapter !== undefined) projected[LIVE_RESERVE_ADAPTER_FIELD] = liveReserveAdapter;
  return projected;
}

export function projectChainIds(coin) {
  const chains = new Set();
  for (const deployment of [...(coin?.contracts ?? []), ...(coin?.tradedContracts ?? [])]) {
    if (typeof deployment?.chain === "string" && deployment.chain.length > 0) {
      chains.add(deployment.chain);
    }
  }
  return [...chains].sort();
}

function projectEffectiveMechanismArchetype(coin, sourceById) {
  if (coin?.archetypeOverride === true || !coin?.variantOf) {
    return coin?.mechanismArchetype;
  }
  return sourceById?.get(coin.variantOf)?.mechanismArchetype ?? coin.mechanismArchetype;
}

export function projectListCoin(coin, listFields, listingClass, sourceById) {
  const projected = projectRawCoin(coin, listFields);
  for (const field of listFields) {
    if (projected[field] === null) delete projected[field];
  }
  const mechanismArchetype = projectEffectiveMechanismArchetype(coin, sourceById);
  if (mechanismArchetype !== undefined) projected.mechanismArchetype = mechanismArchetype;
  projected[CHAIN_IDS_FIELD] = projectChainIds(coin);
  projected[LISTING_CLASS_FIELD] = listingClass;
  const blacklistStatus = projectBlacklistStatus(coin);
  if (blacklistStatus !== undefined) projected[BLACKLIST_STATUS_FIELD] = blacklistStatus;
  const custodyModel = coin?.custodyModel;
  if (typeof custodyModel === "string") projected.custodyModel = custodyModel;
  const mintAuthoritySummary = projectMintAuthoritySummary(coin);
  if (mintAuthoritySummary) {
    projected[MINT_AUTHORITY_SUMMARY_FIELD] = {
      mintPath: mintAuthoritySummary.mintPath,
      authorityPosture: mintAuthoritySummary.authorityPosture,
      confidence: mintAuthoritySummary.confidence,
      ...(mintAuthoritySummary.inheritedFrom ? { inheritedFrom: mintAuthoritySummary.inheritedFrom } : {}),
    };
  }
  const liveReserveAdapter = projectLiveReserveAdapter(coin);
  if (liveReserveAdapter !== undefined) projected[LIVE_RESERVE_ADAPTER_FIELD] = liveReserveAdapter;
  const mintAuthorityStatus = projectMintAuthorityStatus(coin);
  if (mintAuthorityStatus !== undefined) projected[MINT_AUTHORITY_STATUS_FIELD] = mintAuthorityStatus;
  const yieldType = coin?.yieldConfig?.yieldType;
  if (typeof yieldType === "string") projected.yieldType = yieldType;
  return projected;
}

export function projectDetailCoin(coin, detailFields, geniusComplianceFields = DEFAULT_GENIUS_COMPLIANCE_FIELDS) {
  return {
    id: coin.id,
    ...projectCoin(coin, detailFields, geniusComplianceFields),
  };
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

export function projectMicaProfile(profile) {
  if (!isPlainObject(profile)) return undefined;
  return projectRawCoin(profile, MICA_COMPLIANCE_FIELDS);
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
function hasActiveMultisigMintControl(summary) {
  return (summary.controls ?? []).some(
    (control) =>
      (control.authorityType === "safe" || control.authorityType === "multisig") &&
      control.directMintAbility !== "none",
  );
}

function hasDirectNonMultisigMintControl(summary) {
  return (summary.controls ?? []).some(
    (control) =>
      control.directMintAbility === "direct" &&
      control.authorityType !== "safe" &&
      control.authorityType !== "multisig",
  );
}

export function projectMintAuthorityStatus(coin) {
  const summary = projectMintAuthoritySummary(coin);
  if (!summary) return undefined;
  if (summary.mintPath === "wrapped-or-variant-inherited") return "inherited-authority";
  if (
    summary.mintPath === "immutable-user-collateralized" &&
    (summary.authorityPosture === "none-resolved" || summary.authorityPosture === "none-resolved-mint")
  ) {
    return "no-privileged-mint";
  }
  if (summary.mintPath === "bridge-or-oft-synthetic") return "bridge-mint";
  if (hasActiveMultisigMintControl(summary)) return "multisig-mint";
  if (
    summary.mintPath === "issuer-direct-mint" ||
    summary.mintPath === "offchain-attested-minter" ||
    hasDirectNonMultisigMintControl(summary)
  ) {
    return "issuer-or-backend-mint";
  }
  return "governed-mint";
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

function readCanonicalOrder(sourcePath = CANONICAL_ORDER_JSON_ABS) {
  const parsed = JSON.parse(readFileSync(sourcePath, "utf8"));
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) {
    throw new Error(`[client-registry] ${CANONICAL_ORDER_JSON_REL} is not a string array`);
  }
  return parsed;
}

function orderSourceCoins(parsed, canonicalOrder) {
  const sourceById = new Map(parsed.map((coin) => [coin.id, coin]));
  const ordered = canonicalOrder.map((id) => {
    const coin = sourceById.get(id);
    if (!coin) {
      throw new Error(`[client-registry] ${CANONICAL_ORDER_JSON_REL} references unknown stablecoin ID: ${id}`);
    }
    return coin;
  });
  if (ordered.length !== parsed.length) {
    throw new Error(
      `[client-registry] ${CANONICAL_ORDER_JSON_REL} covers ${ordered.length}/${parsed.length} stablecoins`,
    );
  }
  return ordered;
}

export function validateListProjection(slim, sourceCoin, index, listFields, listingClass, sourceById) {
  const fieldsToValidate = listFields.filter((field) => field !== "mechanismArchetype");
  validateProjection(slim, sourceCoin, index, fieldsToValidate);
  if (slim.mechanismArchetype !== projectEffectiveMechanismArchetype(sourceCoin, sourceById)) {
    throw new Error(`[client-registry] entry ${index} (${slim.id}): field mechanismArchetype diverges from source`);
  }
  if (!Array.isArray(slim[CHAIN_IDS_FIELD]) || JSON.stringify(slim[CHAIN_IDS_FIELD]) !== JSON.stringify(projectChainIds(sourceCoin))) {
    throw new Error(`[client-registry] entry ${index} (${slim.id}): chainIds diverge from source`);
  }
  if (slim[LISTING_CLASS_FIELD] !== listingClass) {
    throw new Error(`[client-registry] entry ${index} (${slim.id}): listingClass diverges from source`);
  }
  for (const field of ["custodyModel", BLACKLIST_STATUS_FIELD]) {
    const expected = field === BLACKLIST_STATUS_FIELD ? projectBlacklistStatus(sourceCoin) : sourceCoin[field];
    if (JSON.stringify(slim[field]) !== JSON.stringify(expected)) {
      throw new Error(`[client-registry] entry ${index} (${slim.id}): field ${field} diverges from source`);
    }
  }
  if (slim[MINT_AUTHORITY_STATUS_FIELD] !== projectMintAuthorityStatus(sourceCoin)) {
    throw new Error(`[client-registry] entry ${index} (${slim.id}): field ${MINT_AUTHORITY_STATUS_FIELD} diverges from source`);
  }
  const summary = projectMintAuthoritySummary(sourceCoin);
  const expectedSummary = summary
    ? {
        mintPath: summary.mintPath,
        authorityPosture: summary.authorityPosture,
        confidence: summary.confidence,
        ...(summary.inheritedFrom ? { inheritedFrom: summary.inheritedFrom } : {}),
      }
    : undefined;
  if (JSON.stringify(slim[MINT_AUTHORITY_SUMMARY_FIELD]) !== JSON.stringify(expectedSummary)) {
    throw new Error(`[client-registry] entry ${index} (${slim.id}): field ${MINT_AUTHORITY_SUMMARY_FIELD} diverges from source`);
  }
  if (slim[LIVE_RESERVE_ADAPTER_FIELD] !== projectLiveReserveAdapter(sourceCoin)) {
    throw new Error(`[client-registry] entry ${index} (${slim.id}): field ${LIVE_RESERVE_ADAPTER_FIELD} diverges from source`);
  }
  if (slim.yieldType !== sourceCoin?.yieldConfig?.yieldType) {
    throw new Error(`[client-registry] entry ${index} (${slim.id}): field yieldType diverges from source`);
  }
}

export function buildClientRegistryOutput({
  sourceJsonPath = SOURCE_JSON_ABS,
  canonicalOrderJsonPath = CANONICAL_ORDER_JSON_ABS,
  listingDecisionsJsonPath = LISTING_DECISIONS_JSON_ABS,
  clientFields = readCanonicalClientFields(),
  detailFields = readCanonicalClientDetailFields(),
} = {}) {
  const rawJson = readFileSync(sourceJsonPath, "utf8");
  const parsed = JSON.parse(rawJson);
  const canonicalOrder = readCanonicalOrder(canonicalOrderJsonPath);
  const listingClassById = readListingClassById(listingDecisionsJsonPath);
  const sourceById = new Map(parsed.map((coin) => [coin.id, coin]));
  const orderedCoins = orderSourceCoins(parsed, canonicalOrder);
  const listCoins = orderedCoins.map((coin, index) => {
    const listingClass = listingClassById.get(coin.id);
    if (!listingClass) {
      throw new Error(`[client-registry] entry ${index} (${coin.id}): missing listing decision`);
    }
    const list = projectListCoin(coin, clientFields, listingClass, sourceById);
    validateListProjection(list, coin, index, clientFields, listingClass, sourceById);
    return list;
  });
  const detailCoins = orderedCoins.map((coin) => projectDetailCoin(coin, detailFields));
  const detailOutputs = detailCoins.map((detail) => ({
    id: detail.id,
    output: `${JSON.stringify(detail, null, 2)}\n`,
    detail,
  }));

  return {
    output: `${JSON.stringify(listCoins)}\n`,
    listOutput: `${JSON.stringify(listCoins)}\n`,
    slimCoins: listCoins,
    listCoins,
    detailCoins,
    detailOutputs,
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

  const complianceEntries = [];
  const geniusEntries = [];
  parsed.forEach((coin, index) => {
    const genius = projectGeniusProfile(coin.genius, geniusComplianceFields);
    const mica = projectMicaProfile(coin.mica);
    if ((!genius || !isPlainObject(genius)) && (!mica || !isPlainObject(mica))) {
      return;
    }
    const entry = { id: coin.id };
    if (genius && isPlainObject(genius)) {
      entry.genius = genius;
      validateGeniusComplianceProjection(entry, coin, index, geniusComplianceFields);
      geniusEntries.push({ id: coin.id, genius });
    }
    if (mica && isPlainObject(mica)) {
      entry.mica = mica;
    }
    complianceEntries.push(entry);
  });

  return {
    output: `${JSON.stringify(complianceEntries, null, 2)}\n`,
    complianceEntries,
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

export function projectWorkerRuntimeCoin(coin, index) {
  if (typeof coin?.id !== "string" || coin.id.length === 0) {
    throw new Error(`[client-registry] Worker runtime entry ${index}: invalid or missing id`);
  }
  if (typeof coin.symbol !== "string" || coin.symbol.length === 0) {
    throw new Error(`[client-registry] Worker runtime entry ${index} (${coin.id}): invalid or missing symbol`);
  }
  if (typeof coin.name !== "string" || coin.name.length === 0) {
    throw new Error(`[client-registry] Worker runtime entry ${index} (${coin.id}): invalid or missing name`);
  }
  if (typeof coin.flags?.pegCurrency !== "string" || coin.flags.pegCurrency.length === 0) {
    throw new Error(`[client-registry] Worker runtime entry ${index} (${coin.id}): invalid or missing flags.pegCurrency`);
  }

  // Telegram alert/preset/recap modules read name and peg currency; keeping
  // them here lets the five-minute Telegram lane run without the full registry.
  const projected = {
    id: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    pegCurrency: coin.flags.pegCurrency,
    governance: coin.flags.governance,
  };
  if (typeof coin.geckoId === "string" && coin.geckoId.length > 0) {
    projected.geckoId = coin.geckoId;
  }
  if (coin.flags.navToken === true) {
    projected.navToken = true;
  }
  if (typeof coin.commodityOunces === "number") {
    projected.commodityOunces = coin.commodityOunces;
  }
  if (Object.prototype.hasOwnProperty.call(coin, "status")) {
    projected.status = coin.status;
  }
  if (Array.isArray(coin.contracts)) {
    projected.contracts = coin.contracts.map(({ chain, address, decimals }) => ({ chain, address, decimals }));
  }
  if (Array.isArray(coin.tradedContracts)) {
    projected.tradedContracts = coin.tradedContracts.map(({ chain, address, decimals }) => ({
      chain,
      address,
      decimals,
    }));
  }
  if (
    (coin.status == null || coin.status === "active")
    && isPlainObject(coin.liveReservesConfig)
    && !coin.liveReservesConfig.suspended
  ) {
    const { adapter, breakerScope } = coin.liveReservesConfig;
    if (typeof adapter === "string" && adapter.length > 0) {
      projected.liveReserveCircuitSource = `live-reserves:${
        typeof breakerScope === "string" && breakerScope.length > 0 ? breakerScope : adapter
      }`;
    }
  }
  return projected;
}

export function buildWorkerRuntimeRegistryOutput({
  sourceJsonPath = SOURCE_JSON_ABS,
  canonicalOrderJsonPath = CANONICAL_ORDER_JSON_ABS,
} = {}) {
  const rawJson = readFileSync(sourceJsonPath, "utf8");
  const parsed = JSON.parse(rawJson);
  const canonicalOrder = JSON.parse(readFileSync(canonicalOrderJsonPath, "utf8"));

  if (!Array.isArray(parsed)) {
    throw new Error(`[client-registry] ${SOURCE_JSON_REL} is not a JSON array`);
  }
  if (!Array.isArray(canonicalOrder) || canonicalOrder.some((id) => typeof id !== "string")) {
    throw new Error(`[client-registry] ${CANONICAL_ORDER_JSON_REL} is not a string array`);
  }

  const sourceById = new Map(parsed.map((coin) => [coin.id, coin]));
  const runtimeCoins = canonicalOrder.map((id, index) => {
    const coin = sourceById.get(id);
    if (!coin) {
      throw new Error(`[client-registry] ${CANONICAL_ORDER_JSON_REL} references unknown stablecoin ID: ${id}`);
    }
    return projectWorkerRuntimeCoin(coin, index);
  });
  if (runtimeCoins.length !== parsed.length) {
    throw new Error(
      `[client-registry] ${CANONICAL_ORDER_JSON_REL} covers ${runtimeCoins.length}/${parsed.length} stablecoins`,
    );
  }
  return {
    output: `${JSON.stringify(runtimeCoins, null, 2)}\n`,
    runtimeCoins,
  };
}

function detailOutputPath(id) {
  return resolve(DETAIL_OUTPUT_DIR_ABS, `${id}.generated.json`);
}

export function runCli({ checkMode = process.argv.includes("--check") } = {}) {
  const { output, listCoins, detailOutputs } = buildClientRegistryOutput();
  const { output: complianceOutput, geniusEntries } = buildComplianceRegistryOutput();
  const { output: telegramMiniAppOutput, searchableCoins } = buildTelegramMiniAppCatalogOutput();
  const { output: workerRuntimeOutput, runtimeCoins } = buildWorkerRuntimeRegistryOutput();

  if (checkMode) {
    const currentList = existsSync(LIST_OUTPUT_JSON_ABS) ? readFileSync(LIST_OUTPUT_JSON_ABS, "utf8") : "";
    const currentCompliance = existsSync(COMPLIANCE_OUTPUT_JSON_ABS)
      ? readFileSync(COMPLIANCE_OUTPUT_JSON_ABS, "utf8")
      : "";
    const currentTelegramMiniApp = existsSync(TELEGRAM_MINI_APP_OUTPUT_JSON_ABS)
      ? readFileSync(TELEGRAM_MINI_APP_OUTPUT_JSON_ABS, "utf8")
      : "";
    const currentWorkerRuntime = existsSync(WORKER_RUNTIME_OUTPUT_JSON_ABS)
      ? readFileSync(WORKER_RUNTIME_OUTPUT_JSON_ABS, "utf8")
      : "";
    const detailIsStale = detailOutputs.some(({ id, output: expected }) => {
      const path = detailOutputPath(id);
      return !existsSync(path) || readFileSync(path, "utf8") !== expected;
    });
    if (
      currentList !== output ||
      detailIsStale ||
      currentCompliance !== complianceOutput ||
      currentTelegramMiniApp !== telegramMiniAppOutput ||
      currentWorkerRuntime !== workerRuntimeOutput
    ) {
      console.error(
        `${LIST_OUTPUT_JSON_REL}, ${DETAIL_OUTPUT_DIR_REL}, ${COMPLIANCE_OUTPUT_JSON_REL}, ${TELEGRAM_MINI_APP_OUTPUT_JSON_REL}, or ${WORKER_RUNTIME_OUTPUT_JSON_REL} is stale. Run: node scripts/build-data/build-client-registry.mjs`,
      );
      process.exit(1);
    }
    console.log(`${LIST_OUTPUT_JSON_REL}: client list is current (${listCoins.length} entries, ${output.length} bytes)`);
    console.log(
      `${DETAIL_OUTPUT_DIR_REL}: client details are current (${detailOutputs.length} entries, ${detailOutputs.reduce((sum, entry) => sum + entry.output.length, 0)} bytes)`,
    );
    console.log(
      `${COMPLIANCE_OUTPUT_JSON_REL}: compliance registry is current (${geniusEntries.length} GENIUS entries, ${complianceOutput.length} bytes)`,
    );
    console.log(
      `${TELEGRAM_MINI_APP_OUTPUT_JSON_REL}: Mini App catalog is current (${searchableCoins.length} entries, ${telegramMiniAppOutput.length} bytes)`,
    );
    console.log(
      `${WORKER_RUNTIME_OUTPUT_JSON_REL}: Worker runtime registry is current (${runtimeCoins.length} entries, ${workerRuntimeOutput.length} bytes)`,
    );
  } else {
    mkdirSync(dirname(LIST_OUTPUT_JSON_ABS), { recursive: true });
    writeFileSync(LIST_OUTPUT_JSON_ABS, output, "utf8");
    mkdirSync(DETAIL_OUTPUT_DIR_ABS, { recursive: true });
    for (const { id, output: detailOutput } of detailOutputs) {
      writeFileSync(detailOutputPath(id), detailOutput, "utf8");
    }
    mkdirSync(dirname(COMPLIANCE_OUTPUT_JSON_ABS), { recursive: true });
    writeFileSync(COMPLIANCE_OUTPUT_JSON_ABS, complianceOutput, "utf8");
    mkdirSync(dirname(TELEGRAM_MINI_APP_OUTPUT_JSON_ABS), { recursive: true });
    writeFileSync(TELEGRAM_MINI_APP_OUTPUT_JSON_ABS, telegramMiniAppOutput, "utf8");
    mkdirSync(dirname(WORKER_RUNTIME_OUTPUT_JSON_ABS), { recursive: true });
    writeFileSync(WORKER_RUNTIME_OUTPUT_JSON_ABS, workerRuntimeOutput, "utf8");
    console.log(`${LIST_OUTPUT_JSON_REL}: wrote client list (${listCoins.length} entries, ${output.length} bytes)`);
    console.log(
      `${DETAIL_OUTPUT_DIR_REL}: wrote client details (${detailOutputs.length} entries, ${detailOutputs.reduce((sum, entry) => sum + entry.output.length, 0)} bytes)`,
    );
    console.log(
      `${COMPLIANCE_OUTPUT_JSON_REL}: wrote compliance registry (${geniusEntries.length} GENIUS entries, ${complianceOutput.length} bytes)`,
    );
    console.log(
      `${TELEGRAM_MINI_APP_OUTPUT_JSON_REL}: wrote Mini App catalog (${searchableCoins.length} entries, ${telegramMiniAppOutput.length} bytes)`,
    );
    console.log(
      `${WORKER_RUNTIME_OUTPUT_JSON_REL}: wrote Worker runtime registry (${runtimeCoins.length} entries, ${workerRuntimeOutput.length} bytes)`,
    );
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCli();
}
