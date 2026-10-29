#!/usr/bin/env node
/**
 * IR-2a — deterministic digest-key -> authored-identity migration for negative
 * incident reviews (PLAN §4.7, ImplIncidentReviews §3.2).
 *
 * The authored registry stores `scope.controlKey` as a compiler-chosen digest:
 * `bridge-meta:<asset>:<digest>` or `mint-meta:<asset>:<digest>`. Every digest
 * names an authored payload (`{controlIds, routeId}`, a bare deployment id, or
 * a mint control), so this generator recomputes the candidate keys from the
 * authoring metadata and emits one row per review with the stable
 * `(assetId, routeId, controlId|controlIds[])` identity that IR-2b writes back.
 *
 * Determinism: reviews x metadata x the adjudication table below. The
 * adjudication table exists only for the 23 orphan digests measured in
 * ImplIncidentReviews §2.3 — 11 ambiguous collisions (the digest matches an
 * authored payload the compiled inventory no longer exposes) and 12
 * unresolvable digests. They are retired instead of auto-reattached: silent
 * reattachment is unsafe for collisions, and any new closure would move scores
 * in a migration that PLAN §4.7 requires to be 0 movers. An unadjudicated
 * digest that matches nothing fails closed.
 */
import { readFileSync, readdirSync } from "node:fs";
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
export const INCIDENT_REVIEW_KEY_MIGRATION_PATH =
  "shared/data/safety-score-v9/incident-review-key-migration-v1.generated.json";

export type IncidentReviewMigrationResolution =
  | "lane-aggregate"
  | "lane"
  | "mint-control"
  | "deployment"
  | "retired";

export interface IncidentReviewAuthoredIdentity {
  readonly assetId: string;
  readonly routeId: string | null;
  readonly controlId: string | null;
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
  readonly reason: string;
  /**
   * IR-1b's `CanonicalKeySchema` rejects `|`, so the stable id proposal is
   * colon-separated: `bridge:<asset>:<routeId>:<controlId|lane>:<windowEndSec>`.
   * Mint/deployment/retired rows keep the already-canonical legacy reviewId.
   */
  readonly stableReviewId: string;
}

export interface IncidentReviewKeyMigrationArtifact {
  readonly schemaVersion: 1;
  readonly generatedFrom: {
    readonly reviews: string;
    readonly metadata: string;
    readonly adjudications: number;
  };
  readonly counts: Record<IncidentReviewMigrationResolution, number> & {
    readonly total: number;
    readonly orphans: number;
    readonly collisions: number;
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
  | { readonly resolution: "lane-aggregate"; readonly routeId: string; readonly controlIds: readonly string[] }
  | { readonly resolution: "mint-control"; readonly label: string };

interface OrphanAdjudication {
  readonly collision: boolean;
  readonly reason: string;
}

/**
 * The 23 orphan digests measured in ImplIncidentReviews §2.3 (7 assets). Both
 * classes are retired: the 11 collisions because no deterministic rule can
 * prove the review named the payload the digest now hits, the 12 unresolvable
 * because no authored payload exists at all. Re-authoring is IR-2b's explicit
 * per-row decision from the review's own dated sources, not a migration default.
 */
const COLLISION_REASON =
  "legacy digest matches an authored route payload that the current compiled inventory no longer exposes " +
  "(compiler form drift/pooling); silent reattachment is the ambiguous-collision case, so the row is retired " +
  "pending IR-2b re-authoring against the exact lane";
const UNRESOLVABLE_REASON =
  "legacy digest matches no authored route/control payload in the current metadata; the row is retired " +
  "pending IR-2b re-authoring from the review's own dated sources";

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
    if (typeof coin.id !== "string") continue;
    record(coin.id);
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
    const entry = record(sidecar.id);
    const mint = sidecar.mintAuthority as { controls?: readonly MintControlMetadata[] } | undefined;
    entry.mintControls = mint?.controls ?? [];
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
    const existing = candidates.get(key);
    // Distinct payloads sharing a truncated digest would make the migration
    // ambiguous; throw instead of picking one deterministically-but-arbitrarily.
    if (existing !== undefined) {
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
        resolution: "lane",
        routeId,
      });
    }
  }
  for (const routeId of routeIds) {
    if (routeId === "") continue;
    const controlIds = metadata.bridgeControls
      .filter((control) => control.routeRefs.some((ref) => normalizeDeploymentId(ref) === routeId))
      .map((control) => control.id)
      .sort(compareText);
    if (controlIds.length > 0) {
      add(structuredRouteAggregateKey(assetId, routeId, controlIds), {
        resolution: "lane-aggregate",
        routeId,
        controlIds,
      });
    }
  }
  for (const control of metadata.mintControls) {
    add(mintControlKey(assetId, control), { resolution: "mint-control", label: control.label });
  }
  return candidates;
}

function authoredIdentity(assetId: string, candidate: AuthoredCandidate): IncidentReviewAuthoredIdentity {
  if (candidate.resolution === "mint-control") {
    return { assetId, routeId: null, controlId: candidate.label };
  }
  if (candidate.resolution === "lane-aggregate") {
    return { assetId, routeId: candidate.routeId, controlId: null, controlIds: candidate.controlIds };
  }
  return { assetId, routeId: candidate.routeId, controlId: null };
}

/**
 * Re-derive the legacy digest key from a migrated authored identity. Used by the
 * migration-only equivalence harness: an equal digest proves the rewrite cannot
 * change which compiled control the review resolves to.
 */
export function legacyControlKeyForAuthored(
  assetId: string,
  identity: IncidentReviewAuthoredIdentity,
  metadata: ReadonlyMap<string, AssetControlMetadata>,
): string | null {
  if (identity.routeId === null && identity.controlId !== null) {
    const control = (metadata.get(assetId)?.mintControls ?? []).find((entry) => entry.label === identity.controlId);
    if (!control) return null;
    return mintControlKey(assetId, control);
  }
  if (identity.routeId === null) return null;
  const routeId = normalizeDeploymentId(identity.routeId);
  if (identity.controlIds !== undefined) {
    return structuredRouteAggregateKey(assetId, routeId, [...identity.controlIds]);
  }
  return bridgeControlKey(assetId, routeId);
}

function canonicalReviewId(candidate: string, reviewId: string): string {
  if (!CanonicalKeySchema.safeParse(candidate).success) {
    throw new Error(`Incident review migration produced a non-canonical review id for ${reviewId}: ${candidate}`);
  }
  return candidate;
}

/** Whitespace/slash/uppercase route ids and mint labels must not leak into a canonical key. */
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
  if ((row.resolution === "lane" || row.resolution === "lane-aggregate") && row.authored?.routeId != null) {
    const controlId = row.authored.controlId ?? "lane";
    return canonicalReviewId(
      `bridge:${canonicalKeySegment(assetId)}:${canonicalKeySegment(row.authored.routeId)}:${canonicalKeySegment(controlId)}:${windowEndSec}`,
      reviewId,
    );
  }
  return canonicalReviewId(reviewId, reviewId);
}

export function buildIncidentReviewKeyMigration(
  root: string,
  reviewsValue: unknown = readJson(resolve(root, "shared/data/safety-score-v9/incident-reviews-v1.json")),
): IncidentReviewKeyMigrationArtifact {
  const authored = V9AuthoredIncidentRegistryEnvelopeSchema.parse(reviewsValue);
  const metadata = loadAssetControlMetadata(root);
  const rows: IncidentReviewKeyMigrationRow[] = [];
  for (const review of authored.negativeReviews) {
    const assetId = review.assetId;
    if (review.scope.kind === "deployment") {
      rows.push({
        reviewId: review.reviewId,
        assetId,
        legacyControlKey: null,
        resolution: "deployment",
        authored: { assetId, routeId: null, controlId: null },
        digestMatch: true,
        collidesWithCurrentCandidate: false,
        reason: "deployment-scope review keeps its deploymentKey identity (ImplIncidentReviews §3.2)",
        stableReviewId: review.reviewId,
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
      // Fail closed: a digest nobody has adjudicated must never be guessed.
      throw new Error(
        `Incident review ${review.reviewId} has no authored candidate for ${legacyControlKey}; add an explicit adjudication`,
      );
    }
    rows.push({
      reviewId: review.reviewId,
      assetId,
      legacyControlKey,
      resolution: candidate.resolution,
      authored: authoredIdentity(assetId, candidate),
      digestMatch: true,
      collidesWithCurrentCandidate: false,
      reason:
        candidate.resolution === "mint-control"
          ? `mint-meta digest recomputed from mintAuthority control "${candidate.label}"`
          : candidate.resolution === "lane-aggregate"
            ? `structured route digest recomputed from route ${candidate.routeId} and ${candidate.controlIds.length} control ids`
            : `route-fallback digest recomputed from route ${candidate.routeId}`,
      stableReviewId: stableReviewIdFor(review.reviewId, assetId, review.windowEndSec, {
        resolution: candidate.resolution,
        authored: authoredIdentity(assetId, candidate),
      }),
    });
  }
  rows.sort((left, right) => compareText(left.reviewId, right.reviewId));
  const countOf = (resolution: IncidentReviewMigrationResolution): number =>
    rows.filter((row) => row.resolution === resolution).length;
  const adjudications = Object.keys(INCIDENT_REVIEW_ORPHAN_ADJUDICATIONS).length;
  const counts = {
    "lane-aggregate": countOf("lane-aggregate"),
    lane: countOf("lane"),
    "mint-control": countOf("mint-control"),
    deployment: countOf("deployment"),
    retired: countOf("retired"),
    total: rows.length,
    orphans: countOf("retired"),
    collisions: rows.filter((row) => row.collidesWithCurrentCandidate).length,
  };
  if (counts.total !== authored.negativeReviews.length) {
    throw new Error(
      `Incident review migration rows ${counts.total} do not cover ${authored.negativeReviews.length} reviews`,
    );
  }
  return {
    schemaVersion: 1,
    generatedFrom: {
      reviews: "shared/data/safety-score-v9/incident-reviews-v1.json",
      metadata: "shared/data/stablecoins/coins + domains/risk-review + domains/mint-authority",
      adjudications,
    },
    counts,
    rows,
  };
}

/** Every auto-migrated row must re-derive the legacy digest key exactly. */
export function assertMigrationPreservesLegacyKeys(root: string, artifact: IncidentReviewKeyMigrationArtifact): void {
  const metadata = loadAssetControlMetadata(root);
  const failures: string[] = [];
  for (const row of artifact.rows) {
    if (row.resolution === "retired") {
      if (row.digestMatch) failures.push(`${row.reviewId}: retired row claims a digest match`);
      continue;
    }
    if (row.authored === null) {
      failures.push(`${row.reviewId}: ${row.resolution} row has no authored identity`);
      continue;
    }
    if (row.resolution === "deployment") continue;
    const derived = legacyControlKeyForAuthored(row.assetId, row.authored, metadata);
    if (derived !== row.legacyControlKey) {
      failures.push(`${row.reviewId}: derived ${derived} != legacy ${row.legacyControlKey}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Incident review migration is not legacy-key preserving:\n${failures.slice(0, 10).join("\n")}`);
  }
}

export function runCli(argv = process.argv.slice(2)): void {
  const { values } = parseStrictCliArgs(argv, {
    options: { check: { type: "boolean" }, "assert-equivalent": { type: "boolean" } },
  });
  const artifact = buildIncidentReviewKeyMigration(ROOT);
  if (values["assert-equivalent"] === true || values.check === true) {
    assertMigrationPreservesLegacyKeys(ROOT, artifact);
    process.stdout.write(
      `Incident review migration preserves every legacy key (${artifact.counts.total - artifact.counts.orphans} mapped, ` +
        `${artifact.counts.orphans} retired, ${artifact.counts.collisions} collisions)\n`,
    );
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
