#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { V9ReviewedIncidentRegistryEnvelopeSchema, V9ReviewedIncidentSchema } from "../../shared/types/safety-score-v9-incidents";
import { projectNegativeIncidentReview } from "../lib/safety-score-v9-incident-runtime";
import { canonicalizeReviewedRegistryDigest, reviewedRegistryDigestKey, reviewedRegistryEnvelopeDigest } from "../../shared/lib/safety-score-v9/reviewed-registry";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import { parseStrictCliArgs } from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));


export function buildIncidentRuntime(value: unknown) {
  const envelope = V9ReviewedIncidentRegistryEnvelopeSchema.parse(value);
  const canonical = canonicalizeReviewedRegistryDigest(envelope, {
    incidents: reviewedRegistryDigestKey("incidentId"),
    "incidents.*.primarySources": reviewedRegistryDigestKey("url"),
    "incidents.*.remediation.sources": reviewedRegistryDigestKey("url"),
    "incidents.*.posture.controlKinds": (row) => typeof row === "string" ? row : "",
    negativeReviews: reviewedRegistryDigestKey("reviewId"),
    "negativeReviews.*.sources": reviewedRegistryDigestKey("url"),
    "negativeReviews.*.scope.controlKinds": (row) => typeof row === "string" ? row : "",
  });
  return { schemaVersion: 1, digest: reviewedRegistryEnvelopeDigest("safety-score-v9.incident-reviews.v1", "payload", canonical),
    incidents: envelope.incidents.map((row) => V9ReviewedIncidentSchema.parse(row)),
    negativeReviews: (envelope.negativeReviews ?? []).map(projectNegativeIncidentReview) };
}

export function runCli(argv = process.argv.slice(2)): void {
  const { values } = parseStrictCliArgs(argv, { options: { check: { type: "boolean" } } });
  const value = JSON.parse(readFileSync(resolve(ROOT, "shared/data/safety-score-v9/incident-reviews-v1.json"), "utf8"));
  syncGeneratedArtifacts({ artifacts: [{ path: resolve(ROOT, "shared/data/safety-score-v9/incident-runtime-v1.generated.json"), contents: `${JSON.stringify(buildIncidentRuntime(value))}\n` }],
    check: values.check === true, staleMessage: "Safety Score incident runtime projection is stale.",
    currentMessage: "Safety Score incident runtime projection is current", writtenMessage: "Generated Safety Score incident runtime projection" });
}
if (isDirectRun(import.meta.url, process.argv[1])) runCli();
