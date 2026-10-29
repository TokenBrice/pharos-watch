#!/usr/bin/env tsx
/**
 * IR-5 — blocking guard for incident negative-review identity (PLAN §4.7).
 *
 * A review's key must name a compiled control or lane. The authored registry
 * stores either the legacy digest `controlKey` or the migrated authored tuple
 * `(assetId, routeId, controlId | controlIds | "*")`; the digest form is only
 * held for mint rows (no producer sets `authoredControlId` on mint facts yet)
 * and for retired rows, and the migration artefact must account for every row.
 * Orphaned digests are retired with a reason instead of silently contributing.
 *
 * The check reads the authoring metadata directly (the same three directories
 * the review-key migration generator compiles from) and reuses its authored
 * candidate map, so route/control identity has one derivation. Lane screening
 * certificates are D1 runtime state (IR-3b stores no committed artifact), so
 * `laneScreeningRefs` are checked structurally and per covered lane; the
 * certificate's existence and freshness stay IR-1c's admission rule.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import {
  CanonicalKeySchema,
  CanonicalTextSchema,
} from "../../shared/types/safety-schema-primitives";
import {
  V9AuthoredControlReviewScopeSchema,
  V9IncidentReviewRetirementSchema,
  V9IssuerSurfaceIncidentReviewScopeSchema,
  V9LaneScreeningRefSchema,
  V9NegativeIncidentReviewScopeSchema,
  V9ProviderIncidentReviewScopeSchema,
} from "../../shared/types/safety-score-v9-incidents";
import { normalizeDeploymentId } from "../../shared/types/deployment-id";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { INCIDENT_REVIEW_KEY_MIGRATION_PATH } from "../build-data/generate-safety-score-v9-incident-review-key-migration";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const INCIDENT_REVIEWS_PATH = "shared/data/safety-score-v9/incident-reviews-v1.json";

const COINS_DIR = "shared/data/stablecoins/coins";
const RISK_REVIEW_DIR = "shared/data/stablecoins/domains/risk-review";
const MINT_AUTHORITY_DIR = "shared/data/stablecoins/domains/mint-authority";

interface AssetInventory {
  readonly routeIds: Set<string>;
  readonly controlIdsByRoute: Map<string, Set<string>>;
  readonly controlIds: Set<string>;
  readonly mintLabels: Set<string>;
  readonly deploymentIds: Set<string>;
}

interface CoinMetadata {
  id?: unknown;
  contracts?: readonly { chain?: unknown; address?: unknown }[];
  deployments?: readonly { chain?: unknown; address?: unknown }[];
}

interface RiskReviewSidecar {
  id?: unknown;
  bridgeRouteRisk?: {
    routes?: readonly { id?: unknown }[];
    controls?: readonly { id?: unknown; routeRefs?: readonly unknown[] }[];
  };
}

interface MintAuthoritySidecar {
  id?: unknown;
  mintAuthority?: { controls?: readonly { label?: unknown; deploymentRefs?: readonly unknown[] }[] };
}

const ReviewScopeSchema = z.union([
  V9NegativeIncidentReviewScopeSchema,
  V9AuthoredControlReviewScopeSchema,
  V9IssuerSurfaceIncidentReviewScopeSchema,
  V9ProviderIncidentReviewScopeSchema,
]);

const ReviewIdentityRowSchema = z
  .object({
    reviewId: CanonicalKeySchema,
    // Provider-wide reviews have no asset id by construction (C3 M-6).
    assetId: CanonicalKeySchema.optional(),
    scope: ReviewScopeSchema,
    reviewedAt: CanonicalTextSchema,
    windowEndSec: z.number().int().nonnegative().safe(),
    retired: V9IncidentReviewRetirementSchema.optional(),
    laneScreeningRefs: z.array(V9LaneScreeningRefSchema).min(1).optional(),
  })
  .passthrough();
type ReviewIdentityRow = z.output<typeof ReviewIdentityRowSchema>;
type AuthoredControlScope = z.output<typeof V9AuthoredControlReviewScopeSchema>;

const MigrationRowSchema = z
  .object({
    reviewId: CanonicalKeySchema,
    assetId: CanonicalKeySchema,
    legacyControlKey: CanonicalKeySchema.nullable().optional(),
    resolution: z.enum(["lane", "control", "lane-aggregate", "mint-control", "deployment", "retired"]),
    authored: z
      .object({
        assetId: CanonicalKeySchema,
        routeId: z.string().optional(),
        controlId: z.string().nullable().optional(),
        controlIds: z.array(z.string()).optional(),
      })
      .passthrough()
      .nullable(),
    applied: z.enum(["authored", "legacy-blocked", "retired", "unchanged"]),
    digestMatch: z.boolean().optional(),
    stableReviewId: CanonicalKeySchema,
    reason: z.string().optional(),
  })
  .passthrough();
type MigrationRow = z.output<typeof MigrationRowSchema>;

const MigrationArtifactSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    rows: z.array(MigrationRowSchema),
  })
  .passthrough();

export interface IncidentReviewKeyFinding {
  readonly code: string;
  readonly reviewId: string | null;
  readonly detail: string;
}

export interface IncidentReviewKeyReport {
  readonly reviews: number;
  readonly live: number;
  readonly retired: number;
  readonly legacyDigestHeld: number;
  readonly findings: readonly IncidentReviewKeyFinding[];
}

type FindingEmitter = (code: string, reviewId: string | null, detail: string) => void;

function readJson(root: string, path: string): unknown {
  return JSON.parse(readFileSync(resolve(root, path), "utf8")) as unknown;
}

function sortedJsonFiles(root: string, dir: string): string[] {
  const absolute = resolve(root, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function addDeployment(inventory: AssetInventory, deploymentId: unknown): void {
  if (typeof deploymentId !== "string") return;
  const normalized = normalizeDeploymentId(deploymentId);
  if (normalized !== "") inventory.deploymentIds.add(normalized);
}

/**
 * Compile the reviewed control inventory from the authored metadata. Mirrors
 * `loadAssetControlMetadata` in the review-key migration generator: the digest
 * candidate map below reuses that generator's derivation, so reference and
 * resolution cannot drift apart.
 */
export function loadIncidentReviewInventory(root: string): Map<string, AssetInventory> {
  const assets = new Map<string, AssetInventory>();
  const inventoryOf = (assetId: string): AssetInventory => {
    const existing = assets.get(assetId);
    if (existing !== undefined) return existing;
    const created: AssetInventory = {
      routeIds: new Set(),
      controlIdsByRoute: new Map(),
      controlIds: new Set(),
      mintLabels: new Set(),
      deploymentIds: new Set(),
    };
    assets.set(assetId, created);
    return created;
  };
  for (const file of sortedJsonFiles(root, COINS_DIR)) {
    const coin = readJson(root, `${COINS_DIR}/${file}`) as CoinMetadata;
    if (typeof coin.id !== "string") continue;
    const inventory = inventoryOf(coin.id);
    for (const contract of [...(coin.contracts ?? []), ...(coin.deployments ?? [])]) {
      addDeployment(inventory, `${String(contract.chain)}:${String(contract.address)}`);
    }
  }
  for (const file of sortedJsonFiles(root, RISK_REVIEW_DIR)) {
    const sidecar = readJson(root, `${RISK_REVIEW_DIR}/${file}`) as RiskReviewSidecar;
    if (typeof sidecar.id !== "string") continue;
    const inventory = inventoryOf(sidecar.id);
    for (const route of sidecar.bridgeRouteRisk?.routes ?? []) {
      if (typeof route.id !== "string") continue;
      const normalized = normalizeDeploymentId(route.id);
      if (normalized !== "") inventory.routeIds.add(normalized);
    }
    for (const control of sidecar.bridgeRouteRisk?.controls ?? []) {
      if (typeof control.id !== "string" || control.id === "") continue;
      inventory.controlIds.add(control.id);
      for (const routeRef of control.routeRefs ?? []) {
        if (typeof routeRef !== "string") continue;
        const normalized = normalizeDeploymentId(routeRef);
        if (normalized === "") continue;
        inventory.routeIds.add(normalized);
        const contributors = inventory.controlIdsByRoute.get(normalized) ?? new Set<string>();
        contributors.add(control.id);
        inventory.controlIdsByRoute.set(normalized, contributors);
      }
    }
  }
  for (const file of sortedJsonFiles(root, MINT_AUTHORITY_DIR)) {
    const sidecar = readJson(root, `${MINT_AUTHORITY_DIR}/${file}`) as MintAuthoritySidecar;
    if (typeof sidecar.id !== "string") continue;
    const inventory = inventoryOf(sidecar.id);
    for (const control of sidecar.mintAuthority?.controls ?? []) {
      if (typeof control.label === "string" && control.label !== "") inventory.mintLabels.add(control.label);
      for (const deploymentRef of control.deploymentRefs ?? []) addDeployment(inventory, deploymentRef);
    }
  }
  return assets;
}

/** True when an asset-local authored control id names a compiled bridge control or mint control. */
function isAssetLocalControl(inventory: AssetInventory, controlId: string): boolean {
  return inventory.controlIds.has(controlId) || inventory.mintLabels.has(controlId);
}

interface Resolution {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Resolve one live review scope against the compiled inventory. Semantics
 * mirror IR-1a's `authoredControlScopeMatches`: `"*"` names the route (lane),
 * `controlIds` names contributors of that route, a bare `controlId` is exact,
 * and identity without a route is asset-local (mint inventory).
 */
function resolveReviewScope(
  scope: ReviewIdentityRow["scope"],
  assetId: string | undefined,
  inventoryByAsset: ReadonlyMap<string, AssetInventory>,
): Resolution {
  switch (scope.kind) {
    case "deployment": {
      const inventory = assetId === undefined ? undefined : inventoryByAsset.get(assetId);
      if (inventory === undefined) return { ok: false, detail: `deployment review names unknown asset ${String(assetId)}` };
      return inventory.deploymentIds.has(normalizeDeploymentId(scope.deploymentKey))
        ? { ok: true, detail: "" }
        : { ok: false, detail: `deploymentKey ${scope.deploymentKey} is not a reviewed deployment of ${String(assetId)}` };
    }
    case "issuer-surface": {
      if (assetId === undefined) return { ok: false, detail: "issuer-surface review requires an assetId" };
      const inventory = inventoryByAsset.get(assetId);
      if (inventory === undefined) return { ok: false, detail: `asset ${assetId} has no control metadata` };
      for (const routeId of scope.coveredRoutes) {
        if (!inventory.routeIds.has(normalizeDeploymentId(routeId))) {
          return { ok: false, detail: `covered route ${routeId} is not a reviewed route of ${assetId}` };
        }
      }
      for (const controlId of scope.coveredControls ?? []) {
        if (!isAssetLocalControl(inventory, controlId)) {
          return { ok: false, detail: `covered control ${controlId} is not a compiled control of ${assetId}` };
        }
      }
      return { ok: true, detail: "" };
    }
    case "provider": {
      for (const route of scope.coveredRoutes) {
        const inventory = inventoryByAsset.get(route.assetId);
        if (inventory === undefined) return { ok: false, detail: `covered asset ${route.assetId} has no control metadata` };
        if (!inventory.routeIds.has(normalizeDeploymentId(route.routeId))) {
          return { ok: false, detail: `covered route ${route.assetId}|${route.routeId} is not a reviewed route` };
        }
      }
      for (const control of scope.coveredControls ?? []) {
        const inventory = inventoryByAsset.get(control.assetId);
        if (inventory === undefined) return { ok: false, detail: `covered asset ${control.assetId} has no control metadata` };
        if (!isAssetLocalControl(inventory, control.controlId)) {
          return { ok: false, detail: `covered control ${control.assetId}|${control.controlId} is not a compiled control` };
        }
      }
      return { ok: true, detail: "" };
    }
    case "control": {
      if ("controlKey" in scope) return { ok: false, detail: "legacy digest scope is resolved separately" };
      const inventory = assetId === undefined ? undefined : inventoryByAsset.get(assetId);
      if (inventory === undefined) return { ok: false, detail: `asset ${String(assetId)} has no control metadata` };
      if (scope.controlIds !== undefined) {
        if (scope.routeId === undefined) return { ok: false, detail: "aggregate authored identity lacks a routeId" };
        const contributors = inventory.controlIdsByRoute.get(normalizeDeploymentId(scope.routeId));
        if (contributors === undefined) {
          return { ok: false, detail: `route ${scope.routeId} is not a reviewed route of ${String(assetId)}` };
        }
        for (const controlId of scope.controlIds) {
          if (!contributors.has(controlId)) {
            return { ok: false, detail: `control ${controlId} is not a compiled contributor of ${scope.routeId}` };
          }
        }
        return { ok: true, detail: "" };
      }
      const controlId = scope.controlId;
      if (controlId === undefined) return { ok: false, detail: "authored control identity lacks controlId and controlIds" };
      if (scope.routeId === undefined) {
        return isAssetLocalControl(inventory, controlId)
          ? { ok: true, detail: "" }
          : { ok: false, detail: `control ${controlId} is not a compiled control of ${String(assetId)}` };
      }
      const routeId = normalizeDeploymentId(scope.routeId);
      if (!inventory.routeIds.has(routeId)) {
        return { ok: false, detail: `route ${scope.routeId} is not a reviewed route of ${String(assetId)}` };
      }
      if (controlId === "*") return { ok: true, detail: "" };
      return inventory.controlIdsByRoute.get(routeId)?.has(controlId) === true
        ? { ok: true, detail: "" }
        : { ok: false, detail: `control ${controlId} is not a compiled control of ${scope.routeId}` };
    }
    default: {
      const unknownScope: { kind?: unknown } = scope;
      return { ok: false, detail: `unknown review scope ${String(unknownScope.kind)}` };
    }
  }
}

function stableKeyOf(value: { routeId?: string; controlId?: string; controlIds?: readonly string[] }): string {
  return [
    value.routeId ?? "",
    value.controlId ?? "",
    [...(value.controlIds ?? [])].sort().join("\u0000"),
    value.controlIds === undefined ? "" : "aggregate",
  ].join("\u0001");
}

function checkStableId(
  review: ReviewIdentityRow,
  row: MigrationRow,
  seenStableIds: Map<string, string>,
  emit: FindingEmitter,
): void {
  const { stableReviewId } = row;
  const previous = seenStableIds.get(stableReviewId);
  if (previous !== undefined) {
    emit("stable-id-duplicate", review.reviewId, `shares stable id ${stableReviewId} with ${previous}`);
  } else {
    seenStableIds.set(stableReviewId, review.reviewId);
  }
  if (review.retired !== undefined || review.scope.kind === "deployment" || row.resolution === "deployment") {
    if (stableReviewId !== review.reviewId) {
      emit("stable-id", review.reviewId, `retired/deployment identity must keep reviewId, got ${stableReviewId}`);
    }
    return;
  }
  const authoredRoute = row.authored?.routeId !== undefined && row.authored.routeId !== null;
  const expectedPrefix = authoredRoute ? "bridge:" : row.resolution === "mint-control" ? "mint:" : null;
  if (expectedPrefix === null) {
    if (!stableReviewId.includes(":")) {
      emit("stable-id", review.reviewId, "non-reviewId stable identity must be ':'-separated");
    }
    return;
  }
  const segments = stableReviewId.split(":");
  const assetId = review.assetId ?? row.assetId;
  if (!stableReviewId.startsWith(expectedPrefix)) {
    emit("stable-id", review.reviewId, `stable id ${stableReviewId} must start with ${expectedPrefix}`);
  } else if (segments[1] !== assetId) {
    emit("stable-id", review.reviewId, `stable id ${stableReviewId} does not carry asset segment ${assetId}`);
  } else if (!stableReviewId.endsWith(`:${review.windowEndSec}`)) {
    emit("stable-id", review.reviewId, `stable id ${stableReviewId} does not end at windowEndSec ${review.windowEndSec}`);
  }
}

function checkAuthoredScopeIdentity(
  review: ReviewIdentityRow,
  scope: AuthoredControlScope,
  row: MigrationRow,
  emit: FindingEmitter,
): void {
  if (row.applied !== "authored") {
    emit("migration-state", review.reviewId, `authored review is '${row.applied}' in the migration artefact`);
  }
  if (row.authored === null) {
    emit("migration-identity", review.reviewId, "authored review has no authored identity in the migration artefact");
    return;
  }
  const stored = stableKeyOf({
    routeId: scope.routeId,
    controlId: scope.controlIds === undefined ? scope.controlId : undefined,
    controlIds: scope.controlIds,
  });
  const migrated = stableKeyOf({
    routeId: row.authored.routeId,
    controlId: row.authored.controlIds === undefined ? row.authored.controlId ?? undefined : undefined,
    controlIds: row.authored.controlIds,
  });
  if (stored !== migrated) {
    emit("migration-identity", review.reviewId, "stored authored identity does not match the migration artefact");
  }
}

export function checkIncidentReviewKeys(root: string): IncidentReviewKeyReport {
  const findings: IncidentReviewKeyFinding[] = [];
  const emit: FindingEmitter = (code, reviewId, detail) => {
    findings.push({ code, reviewId, detail });
  };

  const envelope = readJson(root, INCIDENT_REVIEWS_PATH) as { negativeReviews?: unknown };
  if (!Array.isArray(envelope.negativeReviews)) {
    throw new Error(`${INCIDENT_REVIEWS_PATH} has no negativeReviews array`);
  }
  const reviews: ReviewIdentityRow[] = [];
  for (const [index, raw] of envelope.negativeReviews.entries()) {
    const parsed = ReviewIdentityRowSchema.safeParse(raw);
    if (!parsed.success) {
      emit("review-schema", null, `negativeReviews[${index}]: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
      continue;
    }
    reviews.push(parsed.data);
  }

  const inventoryByAsset = loadIncidentReviewInventory(root);
  const migration = MigrationArtifactSchema.parse(readJson(root, INCIDENT_REVIEW_KEY_MIGRATION_PATH));
  const migrationByReviewId = new Map<string, MigrationRow>();
  for (const [index, row] of migration.rows.entries()) {
    if (migrationByReviewId.has(row.reviewId)) {
      emit("migration-duplicate", row.reviewId, `migration rows[${index}] repeats reviewId`);
    }
    migrationByReviewId.set(row.reviewId, row);
  }

  const seenReviewIds = new Set<string>();
  const seenStableIds = new Map<string, string>();
  let live = 0;
  let retired = 0;
  let legacyDigestHeld = 0;

  for (const review of reviews) {
    const { reviewId } = review;
    if (seenReviewIds.has(reviewId)) emit("review-id-duplicate", reviewId, "reviewId is not unique");
    seenReviewIds.add(reviewId);

    const migrationRow = migrationByReviewId.get(reviewId);
    if (review.retired !== undefined) {
      retired += 1;
      if (migrationRow !== undefined) {
        if (migrationRow.applied !== "retired") {
          emit("migration-state", reviewId, `retired review is '${migrationRow.applied}' in the migration artefact`);
        }
        if ((migrationRow.reason ?? "").trim() === "") emit("retired-reason", reviewId, "migration retirement carries no reason");
        checkStableId(review, migrationRow, seenStableIds, emit);
      }
      continue;
    }
    live += 1;

    const scope = review.scope;
    const inventory = review.assetId === undefined ? undefined : inventoryByAsset.get(review.assetId);
    const legacyDigest = scope.kind === "control" && "controlKey" in scope;
    if (!legacyDigest) {
      if (scope.kind !== "provider") {
        if (review.assetId === undefined) {
          emit("unknown-asset", reviewId, "live review has no assetId");
        } else if (inventory === undefined) {
          emit("unknown-asset", reviewId, `asset ${review.assetId} has no compiled control metadata`);
        }
      }
      if (review.assetId !== undefined || scope.kind === "provider") {
        const resolution = resolveReviewScope(scope, review.assetId, inventoryByAsset);
        if (!resolution.ok) emit("orphan-key", reviewId, resolution.detail);
      }
    }

    if (legacyDigest) {
      legacyDigestHeld += 1;
      if (migrationRow === undefined) {
        emit("digest-key", reviewId, `legacy digest ${scope.controlKey} is absent from the migration artefact`);
      } else {
        if (migrationRow.applied !== "legacy-blocked") {
          emit("migration-state", reviewId, `live digest row is '${migrationRow.applied}' in the migration artefact`);
        }
        if (migrationRow.resolution !== "mint-control") {
          emit("digest-key", reviewId, `legacy digest ${scope.controlKey} is a '${migrationRow.resolution}' key; it must be authored or retired`);
        } else if (migrationRow.digestMatch !== true) {
          emit("digest-key-orphan", reviewId, `legacy digest ${scope.controlKey} did not re-derive from a compiled mint control`);
        }
        if (migrationRow.legacyControlKey !== scope.controlKey) {
          emit("migration-identity", reviewId, `migration key ${String(migrationRow.legacyControlKey)} != stored ${scope.controlKey}`);
        }
        if (migrationRow.assetId !== review.assetId) {
          emit("migration-identity", reviewId, `migration asset ${migrationRow.assetId} != stored ${String(review.assetId)}`);
        }
      }
    } else if (scope.kind === "control") {
      if (migrationRow !== undefined) checkAuthoredScopeIdentity(review, scope, migrationRow, emit);
    } else if (migrationRow !== undefined && scope.kind === "deployment") {
      if (migrationRow.applied !== "unchanged") {
        emit("migration-state", reviewId, `deployment review is '${migrationRow.applied}' in the migration artefact`);
      }
    } else if (migrationRow !== undefined && migrationRow.applied !== "authored") {
      emit("migration-state", reviewId, `${scope.kind} review is '${migrationRow.applied}' in the migration artefact`);
    }

    if (scope.kind === "provider") {
      if (review.laneScreeningRefs === undefined) {
        emit("coverage-ref-missing", reviewId, "provider review carries no lane screening references");
      } else {
        const coveredLanes = new Set(
          scope.coveredRoutes.map((route) => `${route.assetId}\u0000${normalizeDeploymentId(route.routeId)}`),
        );
        const referencedLanes = new Set<string>();
        for (const ref of review.laneScreeningRefs) {
          const lane = `${ref.assetId}\u0000${normalizeDeploymentId(ref.routeId)}`;
          if (!coveredLanes.has(lane)) {
            emit("coverage-ref-lane", reviewId, `lane screening reference ${ref.assetId}|${ref.routeId} is not a covered route`);
          }
          referencedLanes.add(lane);
        }
        for (const lane of coveredLanes) {
          if (!referencedLanes.has(lane)) {
            emit("coverage-ref-missing", reviewId, `covered lane ${lane.replace("\u0000", "|")} has no certificate reference`);
          }
        }
      }
    }

    if (migrationRow !== undefined) checkStableId(review, migrationRow, seenStableIds, emit);
  }

  for (const row of migration.rows) {
    if (!seenReviewIds.has(row.reviewId)) {
      emit("migration-row-extra", row.reviewId, "migration artefact names a review that does not exist");
    }
  }

  return { reviews: reviews.length, live, retired, legacyDigestHeld, findings };
}

export interface IncidentReviewKeyWriter {
  write(value: string): unknown;
}

export function runIncidentReviewKeyCheck(
  argv: readonly string[] = process.argv.slice(2),
  root: string = ROOT,
  stdout: IncidentReviewKeyWriter = process.stdout,
  stderr: IncidentReviewKeyWriter = process.stderr,
): number {
  if (argv.length > 0) {
    stderr.write(`Unknown argument: ${argv[0]}\n`);
    return 2;
  }
  let report: IncidentReviewKeyReport;
  try {
    report = checkIncidentReviewKeys(root);
  } catch (error) {
    stderr.write(`incident-review keys: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  stdout.write(
    `incident-review keys: ${report.reviews} reviews (${report.live} live, ${report.retired} retired, ` +
      `${report.legacyDigestHeld} legacy digest held) — ${report.findings.length} finding(s)\n`,
  );
  for (const finding of report.findings) {
    stdout.write(`  - [${finding.code}] ${finding.reviewId ?? "<registry>"}: ${finding.detail}\n`);
  }
  return report.findings.length > 0 ? 1 : 0;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  process.exitCode = runIncidentReviewKeyCheck();
}
