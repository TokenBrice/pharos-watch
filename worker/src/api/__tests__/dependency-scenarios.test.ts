import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DependencyScenarioArtifactSchema, DependencyScenariosResponseSchema, dependencyScenarioFreshness, DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC, DEPENDENCY_SCENARIOS_CACHE_PREFIX } from "@shared/types/dependency-scenarios";
import type { DependencyScenarioArtifact } from "@shared/types/dependency-scenarios";
import { mockD1 } from "@shared/test-utils/mock-d1";

const loadIdentity = vi.hoisted(() => vi.fn());
vi.mock("../../lib/safety-score-active-source", () => ({ loadActiveSafetyScoreIdentity: loadIdentity }));
import { handleDependencyScenarios } from "../dependency-scenarios";
function artifact(): DependencyScenarioArtifact {
  return {
    schemaVersion: 2, sourcePublicationGenerationId: "accepted-1", sourceBaseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`, methodologyVersion: "9.98", evaluationBuildDigest: "b".repeat(64), computedAtSec: 1000,
    cohort: { rootIds: ["root"], selection: "A1 publication-bound direct USD" },
    scenarios: [{ id: "root:mint-control-compromise", rootId: "root", shock: { kind: "mint-control-compromise", assetId: "root" }, assumptions: ["Compromised mint authority"], failures: [], results: [
      { assetId: "root", publishedScore: 80, publishedGrade: "B", publishedRatingStatus: "rated", publishedPartialEvidence: null, modeledScore: 40, modeledGrade: "D", modeledRatingStatus: "rated", modeledPartialEvidence: null, deltaScore: -40, minHop: 0, roles: [] },
      { assetId: "child", publishedScore: 70, publishedGrade: "C", publishedRatingStatus: "rated", publishedPartialEvidence: null, modeledScore: null, modeledGrade: "NR", modeledRatingStatus: "not-rated", modeledPartialEvidence: null, deltaScore: null, minHop: 1, roles: ["control-operator"] },
    ] }],
  };
}
function database(value: string | null = JSON.stringify(artifact())) {
  const key = `${DEPENDENCY_SCENARIOS_CACHE_PREFIX}artifact:fixture`;
  return mockD1([
    { match: "SELECT value FROM cache", matchBinds: [`${DEPENDENCY_SCENARIOS_CACHE_PREFIX}latest`], rows: value === null ? [] : [{ value: key }] },
    ...(value === null ? [] : [{ match: "SELECT value FROM cache", matchBinds: [key], rows: [{ value }] }]),
  ]);
}
describe("dependency scenario artifact and freshness", () => {
  it("preserves valid NR and rejects inconsistent score deltas or invented NR scores", () => {
    expect(DependencyScenarioArtifactSchema.parse(artifact()).scenarios[0]!.results[1]!.modeledScore).toBeNull();
    const invalid = artifact();
    invalid.scenarios[0]!.results[0]!.deltaScore = 0;
    expect(DependencyScenarioArtifactSchema.safeParse(invalid).success).toBe(false);
    invalid.scenarios[0]!.results[0]!.deltaScore = -40;
    invalid.scenarios[0]!.results[1]!.modeledScore = 0;
    expect(DependencyScenarioArtifactSchema.safeParse(invalid).success).toBe(false);
  });
  it("requires the root, unique rows, and a shock tied to the selected root", () => {
    const invalid = artifact();
    invalid.scenarios[0]!.results.shift();
    expect(DependencyScenarioArtifactSchema.safeParse(invalid).success).toBe(false);
    const duplicate = artifact();
    duplicate.scenarios[0]!.results.push(duplicate.scenarios[0]!.results[0]!);
    expect(DependencyScenarioArtifactSchema.safeParse(duplicate).success).toBe(false);
    const wrongRoot = artifact();
    wrongRoot.scenarios[0]!.shock.assetId = "another-root";
    expect(DependencyScenarioArtifactSchema.safeParse(wrongRoot).success).toBe(false);
  });
  it("accepts the freshness-budget boundary but never calls another generation current", () => {
    expect(dependencyScenarioFreshness(artifact(), "accepted-1", 1000 + DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC)).toEqual({ status: "current", reason: null, ageSec: DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC, budgetSec: DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC, sourcePublicationGenerationId: "accepted-1", acceptedPublicationGenerationId: "accepted-1" });
    expect(dependencyScenarioFreshness(artifact(), "accepted-2", 1100)).toMatchObject({ status: "earlier-generation", reason: "source-generation-mismatch", ageSec: 100, sourcePublicationGenerationId: "accepted-1", acceptedPublicationGenerationId: "accepted-2" });
    expect(dependencyScenarioFreshness(artifact(), "accepted-1", 1001 + DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC)).toMatchObject({ status: "stale", reason: "artifact-outside-freshness-budget" });
    expect(dependencyScenarioFreshness(artifact(), "accepted-2", 1001 + DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC)).toMatchObject({ status: "stale", reason: "artifact-outside-freshness-budget" });
    expect(dependencyScenarioFreshness(artifact(), "accepted-1", 999)).toMatchObject({ status: "unavailable", reason: "artifact-clock-in-future" });
    expect(dependencyScenarioFreshness(null, "accepted-1", 1100)).toMatchObject({ status: "unavailable", reason: "artifact-unavailable", ageSec: null });
    expect(dependencyScenarioFreshness(artifact(), null, 1100)).toMatchObject({ status: "unavailable", reason: "accepted-publication-unavailable", ageSec: 100 });
  });
  it("rejects a response that labels another generation as current or exposes expired rows as readable", () => {
    const value = artifact();
    const earlier = dependencyScenarioFreshness(value, "accepted-2", 1100);
    expect(DependencyScenariosResponseSchema.safeParse({ artifact: value, freshness: { ...earlier, status: "current", reason: null } }).success).toBe(false);
    expect(DependencyScenariosResponseSchema.safeParse({ artifact: value, freshness: { ...earlier, ageSec: earlier.budgetSec + 1 } }).success).toBe(false);
    expect(DependencyScenariosResponseSchema.safeParse({ artifact: null, freshness: { ...earlier, status: "current", reason: null } }).success).toBe(false);
  });
});
describe("dependency scenario read handler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_100_000);
    loadIdentity.mockReset();
    loadIdentity.mockResolvedValue({ kind: "v9", safetyScoreIdentity: { publicationGenerationId: "accepted-1" } });
  });
  afterEach(() => vi.useRealTimers());
  it("serves accepted modeled rows without intermediary caching", async () => {
    const response = await handleDependencyScenarios(database());
    const body = DependencyScenariosResponseSchema.parse(await response.json());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.freshness).toMatchObject({ status: "current", reason: null, ageSec: 100 });
    expect(body.artifact?.scenarios[0]?.results[1]).toMatchObject({ modeledScore: null, modeledGrade: "NR" });
  });
  it("preserves modeled technical null separately from NR and refuses stale schema bytes", async () => {
    const value = artifact();
    const row = value.scenarios[0]!.results[1]!;
    row.modeledGrade = null;
    row.modeledRatingStatus = "pipeline-gap";
    row.modeledPartialEvidence = {
      reasonCode: "partial-evidence-pipeline-gap", excludedPillars: ["backing", "exit"], causes: ["A"],
    };
    const body = DependencyScenariosResponseSchema.parse(await (await handleDependencyScenarios(database(JSON.stringify(value)))).json());
    expect(body.artifact?.scenarios[0]?.results[1]).toMatchObject({
      modeledGrade: null, modeledScore: null, modeledRatingStatus: "pipeline-gap", deltaScore: null,
    });
    const oldBytes = { ...value, schemaVersion: 1 };
    const rejected = await (await handleDependencyScenarios(database(JSON.stringify(oldBytes)))).json();
    expect(rejected).toMatchObject({ artifact: null, freshness: { status: "unavailable" } });
  });
  it("returns earlier-generation when accepted publication advances, including held publications", async () => {
    loadIdentity.mockResolvedValue({ kind: "held", safetyScoreIdentity: { publicationGenerationId: "accepted-2" } });
    const body = DependencyScenariosResponseSchema.parse(await (await handleDependencyScenarios(database())).json());
    expect(body.freshness).toMatchObject({ status: "earlier-generation", reason: "source-generation-mismatch", ageSec: 100 });
  });
  it("returns unavailable for missing or malformed artifacts, never a false current result", async () => {
    const missing = await (await handleDependencyScenarios(database(null))).json();
    expect(missing).toMatchObject({ artifact: null, freshness: { status: "unavailable", reason: "artifact-unavailable", ageSec: null } });
    const malformed = await (await handleDependencyScenarios(database("not-json"))).json();
    expect(malformed).toMatchObject({ artifact: null, freshness: { status: "unavailable", reason: "artifact-read-failed", ageSec: null } });
  });
  it("keeps a valid artifact noncurrent when accepted publication cannot be read", async () => {
    loadIdentity.mockResolvedValue({ kind: "error", safetyScoreIdentity: null });
    const body = DependencyScenariosResponseSchema.parse(await (await handleDependencyScenarios(database())).json());
    expect(body.freshness).toMatchObject({ status: "unavailable", reason: "accepted-publication-unavailable", ageSec: 100 });
  });
});
