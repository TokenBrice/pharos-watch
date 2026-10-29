#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { V9AuthoredIncidentRegistryEnvelopeSchema, V9ReviewedIncidentRegistryEnvelopeSchema, V9ReviewedIncidentSchema } from "../../shared/types/safety-score-v9-incidents";
import { isProviderReview, projectIncidentReviews } from "../lib/safety-score-v9-incident-runtime";
import {
  canonicalizeReviewedRegistryDigest,
  expandReviewedRegistryReferences,
  reviewedRegistryDigestKey,
  reviewedRegistryEnvelopeDigest,
  reviewedRegistryTextKey,
  reviewedRegistryTupleKey,
} from "../../shared/lib/safety-score-v9/reviewed-registry";
import { isRecord } from "../../shared/lib/type-guards";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import { parseStrictCliArgs } from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REVIEW_TABLES = { sources: "sourceObservations", searchedSurfaces: "searchedSurfaceObservations" } as const;

// Provider-wide reviews carry their asset attribution inside `scope`, so they
// miss the attributed-row envelope check and are validated by their own schema.
const providerLaneKey = reviewedRegistryTupleKey("assetId", "routeId");
const providerControlKey = reviewedRegistryTupleKey("assetId", "controlId");

export function buildIncidentRuntime(value: unknown) {
  const authoredRows = isRecord(value) && Array.isArray(value.negativeReviews) ? value.negativeReviews : null;
  if (authoredRows === null) {
    // Let the authored envelope own the malformed-envelope error.
    V9AuthoredIncidentRegistryEnvelopeSchema.parse(value);
    throw new Error("Incident registry envelope requires a negativeReviews array");
  }
  const providerRows = authoredRows.filter(isProviderReview);
  const attributed = V9AuthoredIncidentRegistryEnvelopeSchema.parse({
    ...(value as Record<string, unknown>),
    negativeReviews: authoredRows.filter((row) => !isProviderReview(row)),
  });
  const envelope = V9ReviewedIncidentRegistryEnvelopeSchema.parse(expandReviewedRegistryReferences(
    attributed, "negativeReviews", REVIEW_TABLES));
  const expandedProviderRows = providerRows.length === 0 ? [] : expandReviewedRegistryReferences(
    { ...(value as Record<string, unknown>), negativeReviews: providerRows }, "negativeReviews", REVIEW_TABLES, isProviderReview,
  ).negativeReviews as unknown[];
  const reviews = [...(envelope.negativeReviews ?? []), ...expandedProviderRows];
  const canonical = canonicalizeReviewedRegistryDigest({ ...envelope, negativeReviews: reviews }, {
    incidents: reviewedRegistryDigestKey("incidentId"),
    "incidents.*.primarySources": reviewedRegistryDigestKey("url"),
    "incidents.*.remediation.sources": reviewedRegistryDigestKey("url"),
    "incidents.*.posture.controlKinds": reviewedRegistryTextKey,
    negativeReviews: reviewedRegistryDigestKey("reviewId"),
    "negativeReviews.*.sources": reviewedRegistryDigestKey("url"),
    "negativeReviews.*.scope.controlKinds": reviewedRegistryTextKey,
    // Authored identity arrays are canonical sets, not ordered prose: their
    // authored order must not become part of the build identity.
    "negativeReviews.*.scope.controlIds": reviewedRegistryTextKey,
    // Issuer-surface routes are plain ids; provider lanes are authored refs.
    "negativeReviews.*.scope.coveredRoutes": (row: unknown) => typeof row === "string" ? row : providerLaneKey(row),
    "negativeReviews.*.scope.coveredControls": (row: unknown) => typeof row === "string" ? row : providerControlKey(row),
    "negativeReviews.*.laneScreeningRefs": reviewedRegistryTupleKey("assetId", "routeId", "certificateId"),
  });
  return { schemaVersion: 1, digest: reviewedRegistryEnvelopeDigest("safety-score-v9.incident-reviews.v1", "payload", canonical),
    incidents: envelope.incidents.map((row) => V9ReviewedIncidentSchema.parse(row)),
    negativeReviews: reviews.flatMap(projectIncidentReviews) };
}

export function runCli(argv = process.argv.slice(2)): void {
  const { values } = parseStrictCliArgs(argv, { options: { check: { type: "boolean" } } });
  const value = JSON.parse(readFileSync(resolve(ROOT, "shared/data/safety-score-v9/incident-reviews-v1.json"), "utf8"));
  syncGeneratedArtifacts({ artifacts: [{ path: resolve(ROOT, "shared/data/safety-score-v9/incident-runtime-v1.generated.json"), contents: `${JSON.stringify(buildIncidentRuntime(value))}\n` }],
    check: values.check === true, staleMessage: "Safety Score incident runtime projection is stale.",
    currentMessage: "Safety Score incident runtime projection is current", writtenMessage: "Generated Safety Score incident runtime projection" });
}
if (isDirectRun(import.meta.url, process.argv[1])) runCli();
