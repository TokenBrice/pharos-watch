import { describe, expect, it } from "vitest";
import source from "../../shared/data/safety-score-v9/incident-reviews-v1.json";
import { projectNegativeIncidentReview, V9AdmittedNegativeIncidentReviewSchema } from "../lib/safety-score-v9-incident-runtime";
import { readFileSync } from "node:fs";
import { buildIncidentRuntime } from "../build-data/generate-safety-score-v9-incident-runtime";
import { expandReviewedRegistryReferences } from "../../shared/lib/safety-score-v9/reviewed-registry";
import { V9ReviewedIncidentRegistryEnvelopeSchema, V9ReviewedIncidentRegistrySchema } from "../../shared/types/safety-score-v9-incidents";
import { sha256Hex } from "../../shared/lib/sha256";
import { stableJsonStringifyV1 } from "../../shared/lib/stable-json";

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

const REVIEWED_AT = "2026-10-07T14:00:00Z";
const WINDOW_END_SEC = Date.parse(REVIEWED_AT) / 1_000;
const ROUTE_ETH = "ethereum:0x1111111111111111111111111111111111111111";
const ROUTE_BASE = "base:0x2222222222222222222222222222222222222222";
const SURFACE_IDS = ["surface:issuer", "surface:events", "surface:tracker"] as const;

function reviewSurfaces() {
  return [
    { kind: "issuer-status", url: "https://example.com/status", finding: "Issuer status and announcements searched." },
    { kind: "explorer-events", url: "https://example.com/events", finding: "Exact lane logs and emergency state searched." },
    { kind: "incident-tracker", url: "https://example.com/tracker", finding: "Incident trackers searched." },
  ];
}

function reviewSources() {
  return [{ label: "Primary status", url: "https://example.com/status", observedAt: REVIEWED_AT,
    location: "Status archive", excerpt: "Operational" }];
}

function negativeReview(scope: unknown, extra: Record<string, unknown> = {}) {
  return { reviewId: "authored:fixture", assetId: "fixture-vault", scope, reviewedAt: REVIEWED_AT,
    reviewer: "Fixture reviewer", windowStartSec: WINDOW_END_SEC - 86_400, windowEndSec: WINDOW_END_SEC,
    conclusion: "no-known-incident", ...extra };
}

function withEvidence(row: Record<string, unknown>) {
  return { ...row, searchedSurfaces: reviewSurfaces(), sources: reviewSources() };
}

function providerRow(overrides: { scope?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) {
  return negativeReview({ kind: "provider", providerKey: "layerzero", surface: "dvn-set",
    coveredRoutes: [ROUTE_ETH, ROUTE_BASE], coveredControls: ["z-dvn-set", "a-dvn-set"], ...overrides.scope },
  { reviewId: "provider:layerzero:fixture",
    laneScreeningRefs: [
      { routeId: ROUTE_ETH, certificateId: "cert:eth" },
      { routeId: ROUTE_BASE, certificateId: "cert:base" },
    ],
    ...overrides.extra });
}

function authoredRow(overrides: { scope?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) {
  return negativeReview({ kind: "control", routeId: ROUTE_ETH, controlIds: ["z-admin", "a-upgrade"], ...overrides.scope },
    { reviewId: "bridge:fixture-vault:lane", ...overrides.extra });
}

function issuerRow(overrides: { scope?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) {
  return negativeReview({ kind: "issuer-surface", coveredRoutes: [ROUTE_ETH, ROUTE_BASE], ...overrides.scope },
    { reviewId: "issuer:fixture-vault", ...overrides.extra });
}

/** The authored envelope replaces inline observations with file-local references. */
function referencedEnvelope(rows: readonly Record<string, unknown>[]) {
  return {
    schemaVersion: 1,
    incidents: [],
    negativeReviews: rows.map((row) => ({ ...row, sourcesRefs: ["source:status"], searchedSurfacesRefs: [...SURFACE_IDS] })),
    sourceObservations: [{ id: "source:status", value: reviewSources()[0]! }],
    searchedSurfaceObservations: SURFACE_IDS.map((id, index) => ({ id, value: reviewSurfaces()[index]! })),
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

  it("carries authored identity, retirement and lane certificate references through the projection", () => {
    const legacy = projectNegativeIncidentReview(reviews[0]);
    expect(legacy).not.toHaveProperty("retired");
    expect(legacy).not.toHaveProperty("laneScreeningRefs");
    expect(legacy.scope).toEqual(reviews[0]!.scope);

    const provider = projectNegativeIncidentReview(withEvidence(providerRow()));
    expect(provider.scope).toEqual({ kind: "provider", providerKey: "layerzero", surface: "dvn-set",
      coveredRoutes: [ROUTE_BASE, ROUTE_ETH], coveredControls: ["a-dvn-set", "z-dvn-set"] });
    expect(provider.laneScreeningRefs).toEqual([
      { routeId: ROUTE_BASE, certificateId: "cert:base" },
      { routeId: ROUTE_ETH, certificateId: "cert:eth" },
    ]);
    expect(provider).not.toHaveProperty("retired");

    const authored = projectNegativeIncidentReview(withEvidence(authoredRow()));
    expect(authored.scope).toEqual({ kind: "control", routeId: ROUTE_ETH, controlIds: ["a-upgrade", "z-admin"] });
    expect(authored).not.toHaveProperty("laneScreeningRefs");

    const issuer = projectNegativeIncidentReview(withEvidence(issuerRow()));
    expect(issuer.scope).toEqual({ kind: "issuer-surface", coveredRoutes: [ROUTE_BASE, ROUTE_ETH] });

    const retired = projectNegativeIncidentReview(withEvidence(authoredRow({
      scope: { controlIds: undefined, controlId: "*" },
      extra: { retired: { reviewedAt: "2026-10-08", reviewer: "Fixture reviewer", reason: "Lane re-authored" } },
    })));
    expect(retired.retired).toEqual({ reviewedAt: "2026-10-08", reviewer: "Fixture reviewer", reason: "Lane re-authored" });
  });

  it("fails closed on provider coverage it cannot witness", () => {
    const withoutRefs: Record<string, unknown> = withEvidence(providerRow());
    delete withoutRefs.laneScreeningRefs;
    expect(() => projectNegativeIncidentReview(withoutRefs)).toThrow();

    expect(() => projectNegativeIncidentReview(withEvidence({
      ...providerRow(), laneScreeningRefs: [{ routeId: ROUTE_ETH, certificateId: "cert:eth" }],
    }))).toThrow(/lane screening certificate reference/);
    expect(() => projectNegativeIncidentReview(withEvidence({
      ...providerRow(), laneScreeningRefs: [
        { routeId: ROUTE_ETH, certificateId: "cert:eth" },
        { routeId: ROUTE_BASE, certificateId: "cert:base" },
        { routeId: "polygon:0x3333333333333333333333333333333333333333", certificateId: "cert:extra" },
      ],
    }))).toThrow(/only name covered routes/);
  });

  it("rejects a digest-stored or incomplete authored control identity", () => {
    expect(() => projectNegativeIncidentReview(withEvidence(negativeReview({ kind: "control", routeId: ROUTE_ETH }))))
      .toThrow(/requires controlId or controlIds/);
    expect(() => projectNegativeIncidentReview(withEvidence(negativeReview(
      { kind: "control", routeId: ROUTE_ETH, controlId: "*", controlKey: "mint-meta:fixture-vault:54" })))).toThrow();
    expect(() => projectNegativeIncidentReview(withEvidence(providerRow({ scope: { providerKey: "stargate" } }))))
      .toThrow();
  });

  it("keeps the build identity independent of authored identity-array order", () => {
    const ordered = referencedEnvelope([providerRow(), authoredRow(), issuerRow()]);
    const shuffled = referencedEnvelope([
      providerRow({ scope: { coveredRoutes: [ROUTE_BASE, ROUTE_ETH], coveredControls: ["a-dvn-set", "z-dvn-set"] },
        extra: { laneScreeningRefs: [
          { routeId: ROUTE_BASE, certificateId: "cert:base" },
          { routeId: ROUTE_ETH, certificateId: "cert:eth" },
        ] } }),
      authoredRow({ scope: { controlIds: ["a-upgrade", "z-admin"] } }),
      issuerRow({ scope: { coveredRoutes: [ROUTE_BASE, ROUTE_ETH] } }),
    ]);
    const runtime = buildIncidentRuntime(ordered);
    expect(buildIncidentRuntime(shuffled).digest).toBe(runtime.digest);
    expect(buildIncidentRuntime(shuffled).negativeReviews).toEqual(runtime.negativeReviews);
    expect(buildIncidentRuntime(referencedEnvelope([providerRow({ scope: { coveredControls: ["a-dvn-set"] } })]))
      .digest).not.toBe(buildIncidentRuntime(referencedEnvelope([providerRow()])).digest);
  });

  it("reproduces the build identity from the admitted schemas for every record kind", () => {
    const envelope = referencedEnvelope([providerRow(), authoredRow(), issuerRow()]);
    const expandedRows = V9ReviewedIncidentRegistryEnvelopeSchema.parse(expandReviewedRegistryReferences(envelope, "negativeReviews", {
      sources: "sourceObservations", searchedSurfaces: "searchedSurfaceObservations",
    })).negativeReviews!;
    const expected = {
      schemaVersion: 1,
      incidents: [],
      negativeReviews: expandedRows
        .map((row) => V9AdmittedNegativeIncidentReviewSchema.parse(row))
        .sort((left, right) => left.reviewId < right.reviewId ? -1 : left.reviewId > right.reviewId ? 1 : 0),
    };
    expect(buildIncidentRuntime(envelope).digest)
      .toBe(sha256Hex(stableJsonStringifyV1({ domain: "safety-score-v9.incident-reviews.v1", payload: expected })));
  });
});
