#!/usr/bin/env node
/**
 * IR-2a/IR-2b — deterministic digest-key -> authored-identity migration for
 * negative incident reviews (PLAN §4.7, ImplIncidentReviews §3.2).
 *
 * The authored registry stored `scope.controlKey` as a compiler-chosen digest.
 * Every digest names an authored payload (`{controlIds, routeId}`, a single
 * `{controlId, routeId}`, a bare route id, or a mint control), so this generator
 * recomputes the candidate keys from the authoring metadata and emits one row
 * per review with the stable authored identity that IR-2b writes back.
 *
 * Application rules (confirmed with IR-1a/IR-1b, 2026-10-29):
 * - route fallback (`bridge-control-key.v1`) -> `{routeId, controlId: "*"}`;
 * - structured single control (`structured-bridge-control-key.v1`) and any
 *   one-id aggregate -> `{routeId, controlId: <id>}`;
 * - merged aggregate (>1 ids) -> `{routeId, controlIds: [...]}`;
 * - mint rows stay on the legacy `controlKey`: no producer sets
 *   `authoredControlId` on mint facts yet, so an authored mint scope would
 *   resolve nothing and regress 59 closures;
 * - the 23 measured orphan digests are retired with an explicit reason and keep
 *   their legacy scope (a retired row routes and evidences nothing);
 * - deployment-scope rows keep `deploymentKey` identity;
 * - `reviewId` is never rewritten: evidence source ids embed it, so keeping it
 *   holds evidence identity stable while the scope bytes change.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDeploymentId } from "../../shared/types/deployment-id";
import { compareText, domainDigest } from "../../shared/lib/safety-score-v9/primitives";
import { CanonicalKeySchema } from "../../shared/types/safety-schema-primitives";
import { V9AuthoredIncidentRegistryEnvelopeSchema } from "../../shared/types/safety-score-v9-incidents";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import { parseStrictCliArgs } from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const INCIDENT_REVIEWS_PATH = "shared/data/safety-score-v9/incident-reviews-v1.json";
export const INCIDENT_REVIEW_KEY_MIGRATION_PATH =
  "shared/data/safety-score-v9/incident-review-key-migration-v1.generated.json";
export const REVIEW_KEY_MIGRATION_RETIRED_AT = "2026-10-29";
export const REVIEW_KEY_MIGRATION_REVIEWER = "IR-2b review-key migration 2026-10-29";

export type IncidentReviewMigrationResolution =
  | "lane"
  | "control"
  | "lane-aggregate"
  | "mint-control"
  | "deployment"
  | "retired";

/** How the migration row applies to the authored registry. */
export type IncidentReviewMigrationApplication =
  | "authored"
  | "unchanged"
  | "retired"
  | "legacy-blocked";

export interface IncidentReviewAuthoredIdentity {
  readonly assetId: string;
  readonly routeId?: string;
  readonly controlId?: string;
  readonly controlIds?: readonly string[];
}

export interface IncidentReviewKeyMigrationRow {
  readonly reviewId: string;
  readonly assetId: string;
  readonly legacyControlKey: string | null;
  readonly resolution: IncidentReviewMigrationResolution;
  readonly authored: IncidentReviewAuthoredIdentity | null;
  /** The digest-derived control still resolves to the authored payload. */
  readonly digestMatch: boolean;
  /** An authored payload exists but is not exposed by the compiled inventory. */
  readonly collidesWithCurrentCandidate: boolean;
  readonly applied: IncidentReviewMigrationApplication;
  readonly reason: string;
  /**
   * IR-1b's `CanonicalKeySchema` rejects `|`, so the stable id proposal is
   * colon-separated. Review ids are not rewritten in this migration; this
   * column states the format IR-2b/IR-5 must use if a rewrite is ever made.
   */
  readonly stableReviewId: string;
}

export interface IncidentReviewKeyMigrationArtifact {
  readonly schemaVersion: 2;
  readonly generatedFrom: {
    readonly reviews: string;
    readonly metadata: string;
    readonly adjudications: number;
  };
  readonly counts: Record<IncidentReviewMigrationResolution, number> & {
    readonly total: number;
    readonly mapped: number;
    readonly orphans: number;
    readonly collisions: number;
    readonly authoredApplied: number;
    readonly legacyBlocked: number;
    readonly digestKeysRemaining: number;
  };
  readonly rows: readonly IncidentReviewKeyMigrationRow[];
}

interface BridgeRouteMetadata {
  readonly id: string;
}

interface BridgeControlMetadata {
  readonly id: string;
  readonly routeRefs: readonly string[];
}

interface MintControlMetadata {
  readonly chain?: string;
  readonly address?: string;
  readonly label: string;
  readonly role?: string;
  readonly authorityType?: string;
  readonly directMintAbility?: string;
  readonly deploymentRefs?: readonly string[];
}

interface AssetControlMetadata {
  routes: readonly BridgeRouteMetadata[];
  bridgeControls: readonly BridgeControlMetadata[];
  mintControls: readonly MintControlMetadata[];
}

type AuthoredCandidate =
  | { readonly resolution: "lane"; readonly routeId: string }
  | { readonly resolution: "control"; readonly routeId: string; readonly controlId: string }
  | { readonly resolution: "lane-aggregate"; readonly routeId: string; readonly controlIds: readonly string[] }
  | { readonly resolution: "mint-control"; readonly label: string };

interface OrphanAdjudication {
  readonly collision: boolean;
  readonly reason: string;
}

const COLLISION_REASON =
  "legacy digest matches an authored route payload that the current compiled inventory no longer exposes " +
  "(compiler form drift/pooling); silent reattachment is the ambiguous-collision case, so the row is retired " +
  "instead of guessed";
const UNRESOLVABLE_REASON =
  "legacy digest matches no authored route/control payload in the current metadata; the row is retired " +
  "pending re-authoring from the review's own dated sources";

/** The 23 orphan digests measured in ImplIncidentReviews §2.3 (7 assets). */
export const INCIDENT_REVIEW_ORPHAN_ADJUDICATIONS: Readonly<Record<string, OrphanAdjudication>> = {
  "bridge-meta:xaut-tether:284ba273ecdb59273a55": { collision: true, reason: COLLISION_REASON },
  "bridge-meta:xaut-tether:4d4db4969a662d733c2c": { collision: true, reason: COLLISION_REASON },
  "bridge-meta:xaut-tether:4ebf9e8cb50586aefc25": { collision: true, reason: COLLISION_REASON },
  "bridge-meta:xaut-tether:192828da1c6e153a0f9d": { collision: true, reason: COLLISION_REASON },
  "bridge-meta:xaut-tether:6630f9c3e319e1faac38": { collision: true, reason: COLLISION_REASON },
  "bridge-meta:xaut-tether:66b599e67b597f0855eb": { collision: true, reason: COLLISION_REASON },
  "bridge-meta:xaut-tether:7676b5e9b7a9cd2ac172": { collision: true, reason: COLLISION_REASON },
  "bridge-meta:xaut-tether:a5f7bbcc0dd163fffddd": { collision: true, reason: COLLISION_REASON },
  "bridge-meta:xaut-tether:99e75344bf30ad320735": { collision: true, reason: COLLISION_REASON },
  "bridge-meta:susn-noon:e90548557db339c203a9": { collision: true, reason: COLLISION_REASON },
  "bridge-meta:susn-noon:dbc56c37539c35008bd6": { collision: true, reason: COLLISION_REASON },
  "bridge-meta:sbc-brale:70825a54738bc73c302d": { collision: false, reason: UNRESOLVABLE_REASON },
  "bridge-meta:strusd-tori:ec270e98932034bcdfd3": { collision: false, reason: UNRESOLVABLE_REASON },
  "bridge-meta:strusd-tori:5a39c4f7ebf555b40726": { collision: false, reason: UNRESOLVABLE_REASON },
  "bridge-meta:strusd-tori:76952eacfb618563f1eb": { collision: false, reason: UNRESOLVABLE_REASON },
  "bridge-meta:frnt-wyoming:4d6e1d0818a8786951a8": { collision: false, reason: UNRESOLVABLE_REASON },
  "bridge-meta:frnt-wyoming:88b9a814d837bd3e0ad7": { collision: false, reason: UNRESOLVABLE_REASON },
  "bridge-meta:frnt-wyoming:f24fed2b41c4100b0120": { collision: false, reason: UNRESOLVABLE_REASON },
  "bridge-meta:frnt-wyoming:4c927204737dd291992a": { collision: false, reason: UNRESOLVABLE_REASON },
  "bridge-meta:frnt-wyoming:6c88728c63d66afb3aca": { collision: false, reason: UNRESOLVABLE_REASON },
  "bridge-meta:syrupusdg-maple:4e75fee958913edd757b": { collision: false, reason: UNRESOLVABLE_REASON },
  "bridge-meta:syrupusdg-maple:a0fd4144c59659be18f3": { collision: false, reason: UNRESOLVABLE_REASON },
  "bridge-meta:gldon-ondo:aa4f8cd10fdfe386155a": { collision: false, reason: UNRESOLVABLE_REASON },
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function sortedDirEntries(path: string, suffix: string): string[] {
  return readdirSync(path)
    .filter((name) => name.endsWith(suffix))
    .sort(compareText);
}

function loadAssetControlMetadata(root: string): Map<string, AssetControlMetadata> {
  const assets = new Map<string, AssetControlMetadata>();
  const record = (id: string): AssetControlMetadata => {
    const existing = assets.get(id) ?? { routes: [], bridgeControls: [], mintControls: [] };
    assets.set(id, existing);
    return existing;
  };
  const coinsDir = resolve(root, "shared/data/stablecoins/coins");
  for (const file of sortedDirEntries(coinsDir, ".json")) {
    const coin = readJson(resolve(coinsDir, file)) as Record<string, unknown>;
    if (typeof coin.id === "string") record(coin.id);
  }
  const profileDir = resolve(root, "shared/data/stablecoins/domains/risk-review");
  for (const file of sortedDirEntries(profileDir, ".json")) {
    const sidecar = readJson(resolve(profileDir, file)) as Record<string, unknown>;
    if (typeof sidecar.id !== "string") continue;
    const entry = record(sidecar.id);
    const profile = sidecar.bridgeRouteRisk as
      | { routes?: readonly BridgeRouteMetadata[]; controls?: readonly BridgeControlMetadata[] }
      | undefined;
    if (profile) {
      entry.routes = profile.routes ?? [];
      entry.bridgeControls = profile.controls ?? [];
    }
  }
  const mintDir = resolve(root, "shared/data/stablecoins/domains/mint-authority");
  for (const file of sortedDirEntries(mintDir, ".json")) {
    const sidecar = readJson(resolve(mintDir, file)) as Record<string, unknown>;
    if (typeof sidecar.id !== "string") continue;
    const mint = sidecar.mintAuthority as { controls?: readonly MintControlMetadata[] } | undefined;
    record(sidecar.id).mintControls = mint?.controls ?? [];
  }
  return assets;
}

function bridgeControlKey(assetId: string, routeId: string): string {
  return `bridge-meta:${assetId}:${domainDigest("safety-score-v9.bridge-control-key.v1", routeId).slice(0, 20)}`;
}

function structuredControlKey(assetId: string, controlId: string, routeId: string): string {
  return `bridge-meta:${assetId}:${domainDigest(
    "safety-score-v9.structured-bridge-control-key.v1",
    { controlId, routeId },
  ).slice(0, 20)}`;
}

function structuredRouteAggregateKey(assetId: string, routeId: string, controlIds: readonly string[]): string {
  return `bridge-meta:${assetId}:${domainDigest(
    "safety-score-v9.structured-bridge-route-control-key.v1",
    { controlIds, routeId },
  ).slice(0, 20)}`;
}

function mintControlKey(assetId: string, control: MintControlMetadata): string {
  return `mint-meta:${assetId}:${domainDigest("safety-score-v9.mint-control-key.v1", {
    chain: control.chain ?? null,
    address: control.address?.toLowerCase() ?? null,
    label: control.label,
    role: control.role,
    authorityType: control.authorityType,
    directMintAbility: control.directMintAbility,
    deploymentRefs: [...(control.deploymentRefs ?? [])].map(normalizeDeploymentId).sort(compareText),
  }).slice(0, 20)}`;
}

/** Recompute every authored key form the compiler can emit, keyed by digest key. */
export function buildAuthoredCandidates(
  assetId: string,
  metadata: AssetControlMetadata,
): Map<string, AuthoredCandidate> {
  const candidates = new Map<string, AuthoredCandidate>();
  const add = (key: string, candidate: AuthoredCandidate): void => {
    if (candidates.has(key)) {
      throw new Error(`Incident review migration candidate collision for ${assetId}: ${key}`);
    }
    candidates.set(key, candidate);
  };
  const routeIds = metadata.routes.map((route) => normalizeDeploymentId(route.id));
  for (const routeId of routeIds) {
    if (routeId === "") continue;
    add(bridgeControlKey(assetId, routeId), { resolution: "lane", routeId });
  }
  for (const control of metadata.bridgeControls) {
    const controlRouteIds = [...new Set(control.routeRefs.map(normalizeDeploymentId).filter((id) => id !== ""))];
    for (const routeId of controlRouteIds) {
      add(structuredControlKey(assetId, control.id, routeId), {
        resolution: "control",
        routeId,
        controlId: control.id,
      });
    }
  }
  for (const routeId of routeIds) {
    if (routeId === "") continue;
    const controlIds = metadata.bridgeControls
      .filter((control) => control.routeRefs.some((ref) => normalizeDeploymentId(ref) === routeId))
      .map((control) => control.id)
      .sort(compareText);
    if (controlIds.length === 0) continue;
    // IR-0 emits `authoredControlId: <id>` for a one-id lane and the id set only
    // above one, so a one-id aggregate must migrate to the single form.
    add(structuredRouteAggregateKey(assetId, routeId, controlIds), controlIds.length === 1
      ? { resolution: "control", routeId, controlId: controlIds[0]! }
      : { resolution: "lane-aggregate", routeId, controlIds });
  }
  for (const control of metadata.mintControls) {
    add(mintControlKey(assetId, control), { resolution: "mint-control", label: control.label });
  }
  return candidates;
}

function authoredIdentity(assetId: string, candidate: AuthoredCandidate): IncidentReviewAuthoredIdentity {
  if (candidate.resolution === "mint-control") return { assetId, controlId: candidate.label };
  if (candidate.resolution === "lane-aggregate") {
    return { assetId, routeId: candidate.routeId, controlIds: candidate.controlIds };
  }
  if (candidate.resolution === "control") {
    return { assetId, routeId: candidate.routeId, controlId: candidate.controlId };
  }
  return { assetId, routeId: candidate.routeId, controlId: "*" };
}

/**
 * Re-derive the legacy digest key from a migrated authored identity. An equal
 * digest proves the rewrite cannot change which compiled control resolves.
 */
export function legacyControlKeyForAuthored(
  assetId: string,
  identity: IncidentReviewAuthoredIdentity,
  metadata: ReadonlyMap<string, AssetControlMetadata>,
): string | null {
  if (identity.routeId === undefined) {
    if (identity.controlId === undefined || identity.controlId === "*") return null;
    const control = (metadata.get(assetId)?.mintControls ?? []).find((entry) => entry.label === identity.controlId);
    return control ? mintControlKey(assetId, control) : null;
  }
  const routeId = normalizeDeploymentId(identity.routeId);
  if (identity.controlIds !== undefined) {
    return structuredRouteAggregateKey(assetId, routeId, [...identity.controlIds]);
  }
  if (identity.controlId === "*") return bridgeControlKey(assetId, routeId);
  return identity.controlId === undefined ? null : structuredControlKey(assetId, identity.controlId, routeId);
}

function canonicalReviewId(candidate: string, reviewId: string): string {
  if (!CanonicalKeySchema.safeParse(candidate).success) {
    throw new Error(`Incident review migration produced a non-canonical review id for ${reviewId}: ${candidate}`);
  }
  return candidate;
}

/** Route ids/mint labels can carry uppercase, slashes or spaces; keys cannot. */
function canonicalKeySegment(value: string): string {
  const lowered = value.toLowerCase();
  const slug = lowered.replace(/[^a-z0-9._:-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (slug === lowered && slug !== "") return slug;
  const suffix = domainDigest("safety-score-v9.incident-review-key-segment.v1", value).slice(0, 8);
  return `${slug === "" ? "value" : slug}-${suffix}`;
}

function stableReviewIdFor(
  reviewId: string,
  assetId: string,
  windowEndSec: number,
  row: Pick<IncidentReviewKeyMigrationRow, "resolution" | "authored">,
): string {
  if (row.authored?.routeId !== undefined) {
    const controlId = row.authored.controlId ?? "lane";
    return canonicalReviewId(
      `bridge:${canonicalKeySegment(assetId)}:${canonicalKeySegment(row.authored.routeId)}:${canonicalKeySegment(controlId)}:${windowEndSec}`,
      reviewId,
    );
  }
  if (row.resolution === "mint-control" && row.authored?.controlId !== undefined) {
    return canonicalReviewId(
      `mint:${canonicalKeySegment(assetId)}:${canonicalKeySegment(row.authored.controlId)}:${windowEndSec}`,
      reviewId,
    );
  }
  return canonicalReviewId(reviewId, reviewId);
}

export function buildIncidentReviewKeyMigration(
  root: string,
  reviewsValue: unknown = readJson(resolve(root, INCIDENT_REVIEWS_PATH)),
): IncidentReviewKeyMigrationArtifact {
  const authored = V9AuthoredIncidentRegistryEnvelopeSchema.parse(reviewsValue);
  const metadata = loadAssetControlMetadata(root);
  const rows: IncidentReviewKeyMigrationRow[] = [];
  for (const review of authored.negativeReviews) {
    const assetId = review.assetId;
    const stableReviewId = (resolution: IncidentReviewMigrationResolution, authoredValue: IncidentReviewAuthoredIdentity | null) =>
      stableReviewIdFor(review.reviewId, assetId, review.windowEndSec, { resolution, authored: authoredValue });
    if (review.scope.kind === "deployment") {
      rows.push({
        reviewId: review.reviewId,
        assetId,
        legacyControlKey: null,
        resolution: "deployment",
        authored: { assetId },
        digestMatch: true,
        collidesWithCurrentCandidate: false,
        applied: "unchanged",
        reason: "deployment-scope review keeps its deploymentKey identity (ImplIncidentReviews §3.2)",
        stableReviewId: review.reviewId,
      });
      continue;
    }
    if (!("controlKey" in review.scope)) {
      // Idempotent re-run on the applied registry: derive the same row from the
      // authored identity. Legacy provenance is re-derived; a one-id lane
      // authored under the aggregate namespace lands on the single-form digest,
      // which selects the same compiled fact (asserted below).
      const scope = review.scope;
      const resolution: IncidentReviewMigrationResolution = scope.controlIds !== undefined
        ? "lane-aggregate"
        : scope.routeId === undefined
          ? "mint-control"
          : scope.controlId === "*"
            ? "lane"
            : "control";
      const identity: IncidentReviewAuthoredIdentity = {
        assetId,
        ...(scope.routeId === undefined ? {} : { routeId: scope.routeId }),
        ...(scope.controlId === undefined ? {} : { controlId: scope.controlId }),
        ...(scope.controlIds === undefined ? {} : { controlIds: scope.controlIds }),
      };
      rows.push({
        reviewId: review.reviewId,
        assetId,
        legacyControlKey: legacyControlKeyForAuthored(assetId, identity, metadata),
        resolution,
        authored: identity,
        digestMatch: true,
        collidesWithCurrentCandidate: false,
        applied: resolution === "mint-control" ? "legacy-blocked" : "authored",
        reason: "authored identity already applied; legacy digest key re-derived from metadata",
        stableReviewId: stableReviewId(resolution, identity),
      });
      continue;
    }
    const legacyControlKey = review.scope.controlKey;
    const adjudication = INCIDENT_REVIEW_ORPHAN_ADJUDICATIONS[legacyControlKey];
    if (adjudication !== undefined) {
      rows.push({
        reviewId: review.reviewId,
        assetId,
        legacyControlKey,
        resolution: "retired",
        authored: null,
        digestMatch: false,
        collidesWithCurrentCandidate: adjudication.collision,
        applied: "retired",
        reason: adjudication.reason,
        stableReviewId: review.reviewId,
      });
      continue;
    }
    const candidates = buildAuthoredCandidates(assetId, metadata.get(assetId) ?? {
      routes: [],
      bridgeControls: [],
      mintControls: [],
    });
    const candidate = candidates.get(legacyControlKey);
    if (candidate === undefined) {
      throw new Error(
        `Incident review ${review.reviewId} has no authored candidate for ${legacyControlKey}; add an explicit adjudication`,
      );
    }
    const identity = authoredIdentity(assetId, candidate);
    const mintBlocked = candidate.resolution === "mint-control";
    rows.push({
      reviewId: review.reviewId,
      assetId,
      legacyControlKey,
      resolution: candidate.resolution,
      authored: identity,
      digestMatch: true,
      collidesWithCurrentCandidate: false,
      applied: mintBlocked ? "legacy-blocked" : "authored",
      reason: mintBlocked
        ? `mint-meta digest recomputed from mintAuthority control "${candidate.label}"; ` +
          "authored mint scope held on the legacy key until the mint fact carries authoredControlId"
        : candidate.resolution === "lane-aggregate"
          ? `structured route digest recomputed from route ${candidate.routeId} and ${candidate.controlIds.length} control ids`
          : candidate.resolution === "control"
            ? `structured control digest recomputed from route ${candidate.routeId} and control ${candidate.controlId}`
            : `route-fallback digest recomputed from route ${candidate.routeId}`,
      stableReviewId: stableReviewId(candidate.resolution, identity),
    });
  }
  rows.sort((left, right) => compareText(left.reviewId, right.reviewId));
  const countOf = (resolution: IncidentReviewMigrationResolution): number =>
    rows.filter((row) => row.resolution === resolution).length;
  const appliedCount = (applied: IncidentReviewMigrationApplication): number =>
    rows.filter((row) => row.applied === applied).length;
  const counts = {
    lane: countOf("lane"),
    control: countOf("control"),
    "lane-aggregate": countOf("lane-aggregate"),
    "mint-control": countOf("mint-control"),
    deployment: countOf("deployment"),
    retired: countOf("retired"),
    total: rows.length,
    mapped: rows.filter((row) => row.resolution !== "retired").length,
    orphans: countOf("retired"),
    collisions: rows.filter((row) => row.collidesWithCurrentCandidate).length,
    authoredApplied: appliedCount("authored"),
    legacyBlocked: appliedCount("legacy-blocked"),
    digestKeysRemaining: appliedCount("legacy-blocked") + countOf("retired"),
  };
  if (counts.total !== authored.negativeReviews.length) {
    throw new Error(
      `Incident review migration rows ${counts.total} do not cover ${authored.negativeReviews.length} reviews`,
    );
  }
  return {
    schemaVersion: 2,
    generatedFrom: {
      reviews: INCIDENT_REVIEWS_PATH,
      metadata: "shared/data/stablecoins/coins + domains/risk-review + domains/mint-authority",
      adjudications: Object.keys(INCIDENT_REVIEW_ORPHAN_ADJUDICATIONS).length,
    },
    counts,
    rows,
  };
}

/** Every applied authored row must re-derive the legacy digest key exactly. */
export function assertMigrationPreservesLegacyKeys(root: string, artifact: IncidentReviewKeyMigrationArtifact): void {
  const metadata = loadAssetControlMetadata(root);
  const failures: string[] = [];
  for (const row of artifact.rows) {
    if (row.applied === "retired" || row.applied === "legacy-blocked" || row.applied === "unchanged") {
      if (row.applied === "retired" && row.digestMatch) failures.push(`${row.reviewId}: retired row claims a digest match`);
      continue;
    }
    if (row.authored === null) {
      failures.push(`${row.reviewId}: ${row.resolution} row has no authored identity`);
      continue;
    }
    const derived = legacyControlKeyForAuthored(row.assetId, row.authored, metadata);
    // A one-contributor lane compiles with `authoredControlId: <id>`; the digest
    // namespace it was authored under may be either the aggregate or the single
    // form. Both select the same fact, so both digests are outcome-equivalent.
    const oneIdAggregate = row.authored.routeId !== undefined && row.authored.controlId !== undefined
      && row.authored.controlId !== "*" && row.authored.controlIds === undefined
      ? structuredRouteAggregateKey(row.assetId, normalizeDeploymentId(row.authored.routeId), [row.authored.controlId])
      : null;
    if (derived !== row.legacyControlKey && oneIdAggregate !== row.legacyControlKey) {
      failures.push(`${row.reviewId}: derived ${derived} != legacy ${row.legacyControlKey}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Incident review migration is not legacy-key preserving:\n${failures.slice(0, 10).join("\n")}`);
  }
}

function scopeForAuthored(identity: IncidentReviewAuthoredIdentity): Record<string, unknown> {
  if (identity.routeId === undefined) {
    if (identity.controlId === undefined) throw new Error("Authored mint identity lacks a control id");
    return { kind: "control", controlId: identity.controlId };
  }
  if (identity.controlIds !== undefined) {
    return { kind: "control", routeId: identity.routeId, controlIds: [...identity.controlIds] };
  }
  return { kind: "control", routeId: identity.routeId, controlId: identity.controlId ?? "*" };
}

/**
 * Apply the migration to the authored registry value. Only `scope` and
 * `retired` change; provenance, windows, sources, surfaces and `reviewId` are
 * preserved byte-for-byte (key order aside).
 */
export function applyIncidentReviewMigration(reviewsValue: unknown, artifact: IncidentReviewKeyMigrationArtifact): Record<string, unknown> {
  const envelope = reviewsValue as Record<string, unknown> & { negativeReviews?: unknown[] };
  const byId = new Map(artifact.rows.map((row) => [row.reviewId, row]));
  const negativeReviews = (envelope.negativeReviews ?? []).map((row) => {
    const review = row as Record<string, unknown> & { reviewId?: unknown };
    const migration = typeof review.reviewId === "string" ? byId.get(review.reviewId) : undefined;
    if (migration === undefined) {
      throw new Error(`Incident review ${String(review.reviewId)} is missing from the key migration`);
    }
    if (migration.applied === "retired") {
      return { ...review, retired: { reviewedAt: REVIEW_KEY_MIGRATION_RETIRED_AT, reviewer: REVIEW_KEY_MIGRATION_REVIEWER, reason: migration.reason } };
    }
    if (migration.applied !== "authored") return review;
    if (migration.authored === null) throw new Error(`Applied review ${String(review.reviewId)} lacks an authored identity`);
    return { ...review, scope: scopeForAuthored(migration.authored) };
  });
  // Preserve the authored row order: the registry does not require review-id
  // ordering, and reordering would rewrite the whole file for no semantic gain.
  return { ...envelope, negativeReviews };
}

export function runCli(argv = process.argv.slice(2)): void {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      check: { type: "boolean" },
      "assert-equivalent": { type: "boolean" },
      apply: { type: "boolean" },
    },
  });
  const reviewsValue = readJson(resolve(ROOT, INCIDENT_REVIEWS_PATH));
  const artifact = buildIncidentReviewKeyMigration(ROOT, reviewsValue);
  if (values["assert-equivalent"] === true || values.check === true || values.apply === true) {
    assertMigrationPreservesLegacyKeys(ROOT, artifact);
    process.stdout.write(
      `Incident review migration preserves every applied legacy key (${artifact.counts.authoredApplied} authored, ` +
        `${artifact.counts.legacyBlocked} mint held, ${artifact.counts.orphans} retired, ` +
        `${artifact.counts.collisions} collisions)\n`,
    );
  }
  if (values.apply === true) {
    const next = applyIncidentReviewMigration(reviewsValue, artifact);
    writeFileSync(resolve(ROOT, INCIDENT_REVIEWS_PATH), `${JSON.stringify(next, null, 2)}\n`);
    process.stdout.write("Applied Safety Score incident review key migration\n");
  }
  syncGeneratedArtifacts({
    artifacts: [{
      path: resolve(ROOT, INCIDENT_REVIEW_KEY_MIGRATION_PATH),
      contents: `${JSON.stringify(artifact)}\n`,
    }],
    check: values.check === true,
    staleMessage: "Safety Score incident review key migration is stale.",
    currentMessage: "Safety Score incident review key migration is current",
    writtenMessage: "Generated Safety Score incident review key migration",
  });
}

if (isDirectRun(import.meta.url, process.argv[1])) runCli();
