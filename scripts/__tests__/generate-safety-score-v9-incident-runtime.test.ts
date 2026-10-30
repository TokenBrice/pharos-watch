import { describe, expect, it } from "vitest";
import source from "../../shared/data/safety-score-v9/incident-reviews-v1.json";
import {
  fanOutProviderIncidentReview,
  isProviderReview,
  projectNegativeIncidentReview,
  V9AttributedNegativeIncidentReviewSchema,
} from "../lib/safety-score-v9-incident-runtime";
import { readFileSync } from "node:fs";
import { buildIncidentRuntime } from "../build-data/generate-safety-score-v9-incident-runtime";
import { expandReviewedRegistryReferences } from "../../shared/lib/safety-score-v9/reviewed-registry";
import {
  V9AuthoredIncidentRegistryEnvelopeSchema,
  V9ProviderIncidentReviewSchema,
  V9RetirableNegativeIncidentReviewSchema,
} from "../../shared/types/safety-score-v9-incidents";
import { sha256Hex } from "../../shared/lib/sha256";
import { stableJsonStringifyV1 } from "../../shared/lib/stable-json";

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

const ASSET_A = "fixture-vault";
const ASSET_B = "fixture-other";

function providerScope(overrides: Record<string, unknown> = {}) {
  return { kind: "provider", providerKey: "layerzero", surface: "dvn-set",
    coveredRoutes: [
      { assetId: ASSET_B, routeId: ROUTE_BASE },
      { assetId: ASSET_A, routeId: ROUTE_ETH },
    ],
    ...overrides };
}

/** Provider-wide review: no top-level asset; one record speaks to several assets. */
function providerRow(overrides: Record<string, unknown> = {}) {
  return { reviewId: "provider:layerzero:fixture",
    scope: providerScope(),
    reviewedAt: REVIEWED_AT, reviewer: "Fixture reviewer",
    windowStartSec: WINDOW_END_SEC - 86_400, windowEndSec: WINDOW_END_SEC,
    conclusion: "no-known-incident",
    providerIncidents: [],
    ...overrides };
}

function authoredRow(overrides: { scope?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) {
  return negativeReview({ kind: "control", routeId: ROUTE_ETH, controlIds: ["z-admin", "a-upgrade"], ...overrides.scope },
    { reviewId: "bridge:fixture-vault:lane", ...overrides.extra });
}

function issuerRow(overrides: { scope?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) {
  return negativeReview({ kind: "issuer-surface", coveredRoutes: [ROUTE_ETH, ROUTE_BASE], ...overrides.scope },
    { reviewId: "issuer:fixture-vault", ...overrides.extra });
}

/** The v10.38 legacy arm: a digest-keyed row that may be retired instead of deleted. */
const LEGACY_REVIEW = V9RetirableNegativeIncidentReviewSchema.parse(withEvidence(negativeReview(
  { kind: "control", controlKey: "mint-meta:fixture-vault:54ae2376eb1fab2ff54" })));

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
    expect(() => projectNegativeIncidentReview({ ...LEGACY_REVIEW, searchedSurfaces: [] })).toThrow();
    expect(() => projectNegativeIncidentReview({ ...LEGACY_REVIEW, windowEndSec: Number.MAX_SAFE_INTEGER })).toThrow();
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

  it("carries authored identity and retirement through the projection", () => {
    const legacy = projectNegativeIncidentReview(LEGACY_REVIEW);
    expect(legacy).not.toHaveProperty("retired");
    expect(legacy).not.toHaveProperty("laneScreeningRefs");
    expect(legacy.scope).toEqual(LEGACY_REVIEW.scope);

    const retiredLegacy = projectNegativeIncidentReview({ ...LEGACY_REVIEW,
      retired: { reviewedAt: "2026-10-08", reviewer: "Fixture reviewer", reason: "Lane re-authored" } });
    expect(retiredLegacy.retired).toEqual({ reviewedAt: "2026-10-08", reviewer: "Fixture reviewer", reason: "Lane re-authored" });

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

  it("fans a provider-wide review out to one row per covered asset before expansion", () => {
    expect(providerRow()).not.toHaveProperty("assetId");
    const rows = fanOutProviderIncidentReview(providerRow());
    expect(rows.map((row) => row.assetId)).toEqual([ASSET_B, ASSET_A]);
    expect(rows.map((row) => row.reviewId)).toEqual(["provider:layerzero:fixture", "provider:layerzero:fixture"]);
    expect(rows[0]!.scope).toEqual({ kind: "provider", providerKey: "layerzero", surface: "dvn-set",
      coveredRoutes: [{ assetId: ASSET_B, routeId: ROUTE_BASE }] });
    expect(rows[1]!.scope).toEqual({ kind: "provider", providerKey: "layerzero", surface: "dvn-set",
      coveredRoutes: [{ assetId: ASSET_A, routeId: ROUTE_ETH }] });
    expect(rows[0]).not.toHaveProperty("laneScreeningRefs");
    expect(rows[0]).not.toHaveProperty("coveredControls");
    expect(rows[0]).not.toHaveProperty("sources");

    const runtime = buildIncidentRuntime(referencedEnvelope([providerRow()]));
    expect(runtime.negativeReviews.map((row) => `${row.assetId}\u0000${row.reviewId}`)).toEqual([
      `${ASSET_B}\u0000provider:layerzero:fixture`,
      `${ASSET_A}\u0000provider:layerzero:fixture`,
    ]);
    expect(runtime.negativeReviews.every((row) => row.sources.length > 0)).toBe(true);
    // A provider-wide row is not an attributed row; it never projects as one.
    expect(() => projectNegativeIncidentReview(withEvidence(providerRow()))).toThrow();
  });

  it("narrows per-asset OQ-1 exemptions and keeps the runtime row admissible", () => {
    const disclosure = {
      incidentKey: "kelpdao-dvn-2026-04-18",
      class: "verifier-compromise",
      surface: "dvn-set",
      occurredAt: "2026-04-18",
      exposureStartSec: Date.parse("2026-04-18T00:00:00Z") / 1_000,
      exposureEndSec: Date.parse("2026-04-25T00:00:00Z") / 1_000,
      affectedRoutes: [],
      sourceUrls: ["https://example.com/status"],
      exemptions: [ASSET_B, ASSET_A].map((assetId) => ({
        assetId,
        routeId: assetId === ASSET_A ? ROUTE_ETH : ROUTE_BASE,
        kind: "deployed-after-exposure",
        creationTxHash: `0x${"1".repeat(64)}`,
        creationBlock: 300,
        creationTimestampSec: Date.parse("2026-05-01T00:00:00Z") / 1_000,
      })),
    };
    const rows = fanOutProviderIncidentReview(providerRow({ providerIncidents: [disclosure] }));
    expect(rows.map((row) => (row.providerIncidents as { exemptions: { assetId: string }[] }[])[0]!.exemptions
      .map((exemption) => exemption.assetId))).toEqual([[ASSET_B], [ASSET_A]]);
    // The per-asset runtime row must re-admit the strict provider schema: a
    // global exemption list would make every covered asset quarantine.
    const runtime = buildIncidentRuntime(referencedEnvelope([providerRow({ providerIncidents: [disclosure] })]));
    for (const row of runtime.negativeReviews) {
      expect(row.providerIncidents).toHaveLength(1);
      expect(row.providerIncidents![0]!.exemptions).toHaveLength(1);
      expect(row.providerIncidents![0]!.exemptions[0]!.assetId).toBe(row.assetId);
      expect(Object.keys(row).sort()).toEqual([
        "assetId", "providerIncidents", "reviewId", "reviewedAt", "scope", "sources", "windowEndSec", "windowStartSec",
      ]);
    }
  });

  it("fails closed on provider coverage it cannot admit", () => {
    expect(() => buildIncidentRuntime(referencedEnvelope([providerRow({ providerIncidents: undefined })])))
      .toThrow(/providerIncidents/);
    expect(() => buildIncidentRuntime(referencedEnvelope([providerRow({
      laneScreeningRefs: [{ assetId: ASSET_A, routeId: ROUTE_ETH, certificateId: "lane-cert-pending:ethereum" }],
    })]))).toThrow();
    expect(() => buildIncidentRuntime(referencedEnvelope([providerRow({
      scope: providerScope({ coveredControls: [{ assetId: ASSET_A, controlId: "a-dvn-set" }] }),
    })]))).toThrow();
    expect(() => buildIncidentRuntime(referencedEnvelope([{ ...providerRow(), assetId: ASSET_A }])))
      .toThrow(/must not name an asset/);
  });

  it("rejects a digest-stored or incomplete authored control identity", () => {
    expect(() => projectNegativeIncidentReview(withEvidence(negativeReview({ kind: "control", routeId: ROUTE_ETH }))))
      .toThrow(/requires controlId or controlIds/);
    expect(() => projectNegativeIncidentReview(withEvidence(negativeReview(
      { kind: "control", routeId: ROUTE_ETH, controlId: "*", controlKey: "mint-meta:fixture-vault:54" })))).toThrow();
    expect(() => fanOutProviderIncidentReview(providerRow({
      scope: providerScope({ providerKey: "stargate" }),
    }))).toThrow();
  });

  it("keeps the build identity independent of authored identity-array order", () => {
    const ordered = referencedEnvelope([providerRow(), authoredRow(), issuerRow()]);
    const shuffled = referencedEnvelope([
      providerRow({
        scope: providerScope({
          coveredRoutes: [
            { assetId: ASSET_A, routeId: ROUTE_ETH },
            { assetId: ASSET_B, routeId: ROUTE_BASE },
          ],
        }),
      }),
      authoredRow({ scope: { controlIds: ["a-upgrade", "z-admin"] } }),
      issuerRow({ scope: { coveredRoutes: [ROUTE_BASE, ROUTE_ETH] } }),
    ]);
    const runtime = buildIncidentRuntime(ordered);
    expect(buildIncidentRuntime(shuffled).digest).toBe(runtime.digest);
    expect(buildIncidentRuntime(shuffled).negativeReviews).toEqual(runtime.negativeReviews);
    expect(buildIncidentRuntime(referencedEnvelope([
      providerRow({ scope: providerScope({ coveredRoutes: [{ assetId: ASSET_A, routeId: ROUTE_ETH }] }) }),
    ])).digest).not.toBe(buildIncidentRuntime(referencedEnvelope([providerRow()])).digest);
  });

  it("reproduces the build identity from the admitted schemas for every record kind", () => {
    const envelope = referencedEnvelope([providerRow(), authoredRow(), issuerRow()]);
    const authored = V9AuthoredIncidentRegistryEnvelopeSchema.parse(envelope);
    const fannedRows = authored.negativeReviews.flatMap((row) =>
      isProviderReview(row) ? fanOutProviderIncidentReview(row) : [row]);
    const expandedRows = expandReviewedRegistryReferences({ ...authored, negativeReviews: fannedRows }, "negativeReviews", {
      sources: "sourceObservations", searchedSurfaces: "searchedSurfaceObservations",
    }).negativeReviews as Record<string, unknown>[];
    const expected = {
      schemaVersion: 1,
      incidents: [],
      negativeReviews: expandedRows.map((row) => {
        if (!isProviderReview(row)) return V9AttributedNegativeIncidentReviewSchema.parse(row);
        const authoredProvider = { ...row };
        delete authoredProvider.assetId;
        // The digest covers the fanned registry, so the fan-out attribution is part of it.
        return { ...V9ProviderIncidentReviewSchema.parse(authoredProvider), assetId: row.assetId };
      }).sort((left, right) => left.reviewId < right.reviewId ? -1 : left.reviewId > right.reviewId ? 1 : 0),
    };
    expect(buildIncidentRuntime(envelope).digest)
      .toBe(sha256Hex(stableJsonStringifyV1({ domain: "safety-score-v9.incident-reviews.v1", payload: expected })));
  });
});
