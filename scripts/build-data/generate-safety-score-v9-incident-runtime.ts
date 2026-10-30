#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { V9AuthoredIncidentRegistryEnvelopeSchema, V9ReviewedIncidentRegistryEnvelopeSchema, V9ReviewedIncidentSchema } from "../../shared/types/safety-score-v9-incidents";
import {
  fanOutProviderIncidentReview,
  isProviderReview,
  projectNegativeIncidentReview,
  projectProviderIncidentRow,
} from "../lib/safety-score-v9-incident-runtime";
import {
  canonicalizeReviewedRegistryDigest,
  expandReviewedRegistryReferences,
  reviewedRegistryDigestKey,
  reviewedRegistryEnvelopeDigest,
  reviewedRegistryTextKey,
  reviewedRegistryTupleKey,
} from "../../shared/lib/safety-score-v9/reviewed-registry";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import { parseStrictCliArgs } from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REVIEW_TABLES = { sources: "sourceObservations", searchedSurfaces: "searchedSurfaceObservations" } as const;

// Issuer-surface routes are plain ids; provider lanes are authored refs.
const providerLaneKey = reviewedRegistryTupleKey("assetId", "routeId");

export function buildIncidentRuntime(value: unknown) {
  const authored = V9AuthoredIncidentRegistryEnvelopeSchema.parse(value);
  // A provider-wide review becomes one asset-attributed row per covered asset
  // before reference expansion; every row the expander sees carries its asset.
  const rows = authored.negativeReviews.flatMap((row) =>
    isProviderReview(row) ? fanOutProviderIncidentReview(row) : [row]);
  const envelope = V9ReviewedIncidentRegistryEnvelopeSchema.parse(expandReviewedRegistryReferences(
    { ...authored, negativeReviews: rows }, "negativeReviews", REVIEW_TABLES));
  const reviews = envelope.negativeReviews ?? [];
  const canonical = canonicalizeReviewedRegistryDigest(envelope, {
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
    "negativeReviews.*.scope.coveredRoutes": (row: unknown) => typeof row === "string" ? row : providerLaneKey(row),
  });
  return { schemaVersion: 1, digest: reviewedRegistryEnvelopeDigest("safety-score-v9.incident-reviews.v1", "payload", canonical),
    incidents: envelope.incidents.map((row) => V9ReviewedIncidentSchema.parse(row)),
    negativeReviews: reviews.map((row) =>
      isProviderReview(row) ? projectProviderIncidentRow(row) : projectNegativeIncidentReview(row)) };
}

export function runCli(argv = process.argv.slice(2)): void {
  const { values } = parseStrictCliArgs(argv, { options: { check: { type: "boolean" } } });
  const value = JSON.parse(readFileSync(resolve(ROOT, "shared/data/safety-score-v9/incident-reviews-v1.json"), "utf8"));
  syncGeneratedArtifacts({ artifacts: [{ path: resolve(ROOT, "shared/data/safety-score-v9/incident-runtime-v1.generated.json"), contents: `${JSON.stringify(buildIncidentRuntime(value))}\n` }],
    check: values.check === true, staleMessage: "Safety Score incident runtime projection is stale.",
    currentMessage: "Safety Score incident runtime projection is current", writtenMessage: "Generated Safety Score incident runtime projection" });
}
if (isDirectRun(import.meta.url, process.argv[1])) runCli();
