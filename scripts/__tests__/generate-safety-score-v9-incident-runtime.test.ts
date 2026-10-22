import { describe, expect, it } from "vitest";
import source from "../../shared/data/safety-score-v9/incident-reviews-v1.json";
import { projectNegativeIncidentReview } from "../lib/safety-score-v9-incident-runtime";
import { readFileSync } from "node:fs";
import { buildIncidentRuntime } from "../build-data/generate-safety-score-v9-incident-runtime";
import { expandReviewedRegistryReferences } from "../../shared/lib/safety-score-v9/reviewed-registry";
import { V9ReviewedIncidentRegistrySchema } from "../../shared/types/safety-score-v9-incidents";

const expanded = expandReviewedRegistryReferences(source, "negativeReviews", {
  sources: "sourceObservations", searchedSurfaces: "searchedSurfaceObservations",
});
const reviews = V9ReviewedIncidentRegistrySchema.parse(expanded).negativeReviews!;

function holderExitIncident() {
  return {
    incidentId: "fixture-holder-exit",
    assetId: "fixture-vault",
    domain: "peg",
    kind: "holder-exit-impairment",
    occurredAt: "2026-03-22",
    status: "mitigated",
    scope: { kind: "holder-exit" },
    posture: { treatment: "peg-multiplier-only" },
    reviewedAt: "2026-10-21",
    reviewer: "Fixture reviewer",
    primarySources: [{
      label: "Historical withdrawal terms",
      url: "https://example.com/withdrawals",
      publishedAt: "2026-03-22",
    }],
    finding: "A mandatory withdrawal haircut reduced the exiting holder claim.",
    remediation: {
      state: "in-progress",
      lastVerifiedAt: "2026-06-11",
      summary: "Initial recovery was distributed; complete recovery remains unproved.",
      sources: [{
        label: "Recovery distribution",
        url: "https://example.com/recovery",
        publishedAt: "2026-06-11",
      }],
    },
  };
}

function authoredIncidents(incidents: unknown[]) {
  return {
    schemaVersion: 1,
    incidents,
    negativeReviews: [],
    sourceObservations: [],
    searchedSurfaceObservations: [],
  };
}

describe("incident runtime projection", () => {
  it("fails closed on missing research surfaces and future observations", () => {
    expect(() => projectNegativeIncidentReview({ ...reviews[0], searchedSurfaces: [] })).toThrow();
    expect(() => projectNegativeIncidentReview({ ...reviews[0], windowEndSec: Number.MAX_SAFE_INTEGER })).toThrow();
  });

  it("reproduces the generated runtime bytes from the admitted authored registry", () => {
    const runtime = readFileSync(new URL("../../shared/data/safety-score-v9/incident-runtime-v1.generated.json", import.meta.url), "utf8");
    expect(`${JSON.stringify(buildIncidentRuntime(source))}\n`).toBe(runtime);
  });

  it("preserves original positive-event clocks, scope and remediation", () => {
    const incident = holderExitIncident();
    expect(buildIncidentRuntime(authoredIncidents([incident])).incidents).toEqual([incident]);
    expect(() => buildIncidentRuntime(authoredIncidents([{
      ...incident, primarySources: [{ ...incident.primarySources[0], publishedAt: "2027-01-01" }],
    }]))).toThrow();
    expect(() => buildIncidentRuntime(authoredIncidents([{
      ...incident, status: "resolved", resolvedAt: "2026-06-11",
    }]))).toThrow();
  });

  it("carries an explicit holder loss and its witness without deriving losses from prose", () => {
    const base = holderExitIncident();
    const loss = { ...base, realizedHolderLossPct: 2.95 };
    const projected = buildIncidentRuntime(authoredIncidents([loss]));
    expect(projected.incidents).toEqual([loss]);
    const unquantified = { ...base, finding: "A 2.95% discount was quoted; the holder-claim denominator is unproved." };
    const withoutLoss = buildIncidentRuntime(authoredIncidents([unquantified]));
    expect(withoutLoss.incidents).toEqual([unquantified]);
    expect(withoutLoss.incidents[0]).not.toHaveProperty("realizedHolderLossPct");
    expect(projected.digest).not.toBe(buildIncidentRuntime(authoredIncidents([base])).digest);
  });

  it("preserves reference order and exact observations, not URL-only identity", () => {
    const first = { url: "https://example.com/source", excerpt: "First observation" };
    const second = { ...first, excerpt: "Independently dated observation" };
    const authored = { schemaVersion: 1, entries: [{ assetId: "fixture", sourcesRefs: ["second", "first", "first:2"] }],
      sourceObservations: [{ id: "first", value: first }, { id: "second", value: second }, { id: "first:2", value: first }] };
    expect(expandReviewedRegistryReferences(authored, "entries", { sources: "sourceObservations" }))
      .toEqual({ schemaVersion: 1, entries: [{ assetId: "fixture", sources: [second, first, first] }] });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(authored.sourceObservations)).toBe(true);
  });

  it("rejects missing or duplicate references and duplicate table IDs without an inline fallback", () => {
    const authored = { entries: [{ assetId: "fixture", sourcesRefs: ["source"] }],
      sourceObservations: [{ id: "source", value: { url: "https://example.com/source" } }] };
    for (const refs of [["missing"], ["source", "source"]]) {
      expect(() => expandReviewedRegistryReferences({ ...authored, entries: [{ assetId: "fixture", sourcesRefs: refs }] },
        "entries", { sources: "sourceObservations" })).toThrow(/observation reference/);
    }
    expect(() => expandReviewedRegistryReferences({ ...authored, sourceObservations: [...authored.sourceObservations, ...authored.sourceObservations] },
      "entries", { sources: "sourceObservations" })).toThrow(/Duplicate observation reference/);
    expect(() => expandReviewedRegistryReferences({ ...authored, entries: [{ ...authored.entries[0], sources: [] }] },
      "entries", { sources: "sourceObservations" })).toThrow(/not inline/);
  });

  it("rejects even unused duplicate table IDs during offline envelope generation", () => {
    const duplicates = [{ id: "unused", value: {} }, { id: "unused", value: {} }];
    expect(() => expandReviewedRegistryReferences({ entries: [], sourceObservations: duplicates },
      "entries", { sources: "sourceObservations" })).toThrow(/Duplicate observation reference: unused/);
    expect(() => buildIncidentRuntime({ ...source, sourceObservations: [...source.sourceObservations, ...duplicates] }))
      .toThrow(/Duplicate observation reference: unused/);
  });
});
