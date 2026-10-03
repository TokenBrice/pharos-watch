// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DependencyScenarioArtifact, DependencyScenariosResponse } from "@shared/types/dependency-scenarios";
import { projectDependencyGraph } from "@shared/types/dependency-graph";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { DependencyExposureResults } from "./dependency-exposure-results";
import { selectDependencyScenario, DependencyScenarioChange } from "./dependency-scenario-view";

const query = vi.hoisted(() => ({ data: undefined as DependencyScenariosResponse | undefined, isError: false, nowSec: 1000 }));
vi.mock("@/hooks/use-dependency-scenarios", () => ({ useDependencyScenarios: () => query }));
afterEach(() => { cleanup(); query.data = undefined; query.isError = false; });

function response(): DependencyScenariosResponse {
  const row: DependencyScenarioArtifact["scenarios"][number]["results"][number] = { assetId: "root", publishedScore: 80, publishedGrade: "B", publishedRatingStatus: "rated", publishedPartialEvidence: null, modeledScore: 20, modeledGrade: "F", modeledRatingStatus: "rated", modeledPartialEvidence: null, deltaScore: -60, minHop: 0, roles: [] };
  return { artifact: { schemaVersion: 2, sourcePublicationGenerationId: "pub", sourceBaseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`, methodologyVersion: "10.01", evaluationBuildDigest: "b".repeat(64), computedAtSec: 900, cohort: { rootIds: ["root"], selection: "Top direct exposure" }, scenarios: [
    { id: "limit", rootId: "root", shock: { kind: "score-limit", assetId: "root", dimension: "final", limit: 20 }, assumptions: ["Final score capped at 20."], results: [row, { ...row, assetId: "dependent", minHop: 1 }], failures: [] },
    { id: "mint", rootId: "root", shock: { kind: "mint-control-compromise", assetId: "root" }, assumptions: ["Reviewed mint authority compromised."], results: [{ ...row, modeledRatingStatus: "not-rated", modeledScore: null, modeledGrade: "NR", deltaScore: null }, { ...row, assetId: "dependent", modeledRatingStatus: "not-rated", modeledScore: null, modeledGrade: "NR", deltaScore: null, minHop: 1 }], failures: [] },
  ] }, freshness: { status: "current", reason: null, ageSec: 100, budgetSec: 7200, sourcePublicationGenerationId: "pub", acceptedPublicationGenerationId: "pub" } };
}
function surface(roots = ["root"]) {
  const full = makeReportCardsV9Response({ cards: [makeV9Card({ id: "root" }), makeV9Card({ id: "dependent" })] });
  full.safetyScoreIdentity.publicationGenerationId = "pub";
  full.publicationHealth.acceptedPublicationGenerationId = "pub";
  const publication = projectDependencyGraph(full);
  const totals = { knownUsd: 100, complete: true, overlapUsd: 0, excludedSupplyUnknownIds: [], unknownShareEdgeCount: 0, integrityFlag: false };
  return <DependencyExposureResults publication={publication} roots={roots} result={{ rows: [{ id: "dependent", minHop: 1, share: 1, band: "material", exposureUsd: 100, supplyUnknown: false, scoreUnknown: false, paths: [] }], direct: totals, indirect: totals, reached: 1, bandCounts: { material: 1, minor: 0, trace: 0, unknown: 0 } }} options={[]} inspectedId={null} onInspect={() => {}} networkUpdated={false} held={false} />;
}

describe("modeled dependency results", () => {
  it("changes the modeled grade and assumptions with the selected scenario, including NR", () => {
    query.data = response();
    render(surface());
    const panel = screen.getByRole("region", { name: "Modeled Safety Score results" });
    expect(within(panel).getAllByText("B → F")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Scenario type"), { target: { value: "mint" } });
    expect(within(panel).getAllByText("B → NR")).toHaveLength(2);
    expect(within(panel).getByText("Reviewed mint authority compromised.")).toBeTruthy();
    expect(within(panel).queryByText("Final score capped at 20.")).toBeNull();
    expect(screen.getAllByText("Modeled NR · change unavailable")).toHaveLength(3);
  });
  it("keeps technical null grades distinct from NR and shows partial causes without numeric deltas", () => {
    query.data = response();
    const rows = query.data.artifact!.scenarios[0].results;
    rows[0] = { ...rows[0], modeledRatingStatus: "pipeline-gap", modeledScore: null, modeledGrade: null, deltaScore: null,
      modeledPartialEvidence: { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: ["backing", "exit"], causes: ["A"] } };
    rows[1] = { ...rows[1], publishedRatingStatus: "pipeline-gap", publishedGrade: null, publishedScore: null, deltaScore: null,
      publishedPartialEvidence: { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: ["backing", "exit"], causes: ["A"] },
      modeledPartialEvidence: { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: ["exit"], causes: ["B"] } };
    render(surface());
    const panel = screen.getByRole("region", { name: "Modeled Safety Score results" });
    expect(within(panel).getByText("B → Pipeline gap")).toBeTruthy();
    expect(within(panel).getByText("Pipeline gap → F")).toBeTruthy();
    expect(within(panel).getByText(/Modeled Pipeline gap.*pipeline unavailable \(A\)/)).toBeTruthy();
    expect(within(panel).getByText(/Modeled F.*Partial evidence: pipeline gap.*public data awaiting curation \(B\)/)).toBeTruthy();
    expect(within(panel).queryByText(/Modeled NR|-60.00 points/)).toBeNull();
  });
  it.each(["stale", "unavailable"] as const)("withholds all modeled scores and grades when %s", status => {
    query.data = response(); query.data.freshness.status = status; query.data.freshness.reason = "artifact-outside-freshness-budget";
    render(surface());
    expect(screen.getByRole("status").textContent).toMatch(/Modeled results (stale|unavailable)/);
    expect(screen.queryByText("B → F")).toBeNull();
    expect(screen.queryByText(/-60.00 points/)).toBeNull();
  });
  it("shows earlier-generation numbers only with their explicit publication and age disclosure", () => {
    query.data = response();
    query.data.freshness.status = "earlier-generation";
    query.data.freshness.acceptedPublicationGenerationId = "new";
    render(surface());
    expect(screen.getByRole("status").textContent).toBe("Modeled on publication pub, 1 minute ago; the current publication is newer");
    expect(screen.getAllByText("B → F")).toHaveLength(2);
    expect(screen.getAllByText("Modeled F · -60.00 points")).toHaveLength(3);
    const selection = selectDependencyScenario(query.data, ["root"], "", "new", false, 1000);
    expect(selection.current).toBe(false);
    expect(selection.showNumbers).toBe(true);
  });
  it("does not claim publication ordering when the current artifact differs from the displayed map", () => {
    query.data = response();
    query.data.artifact!.sourcePublicationGenerationId = "newer-artifact";
    query.data.freshness.sourcePublicationGenerationId = "newer-artifact";
    query.data.freshness.acceptedPublicationGenerationId = "newer-artifact";
    render(surface());
    expect(screen.getByRole("status").textContent).toBe("The displayed map publication differs from the modeled publication newer-artifact");
    expect(screen.getAllByText("B → F")).toHaveLength(2);
    expect(screen.queryByText(/the current publication is newer/)).toBeNull();
    const selection = selectDependencyScenario(query.data, ["root"], "", "pub", false, 1000);
    expect(selection.current).toBe(false);
    expect(selection.showNumbers).toBe(true);
  });
  it("only adds the modeled column for roots with artifact rows", () => {
    query.data = response();
    const view = render(surface(["outside"]));
    expect(screen.queryByRole("columnheader", { name: "Modeled Safety Score change" })).toBeNull();
    view.rerender(surface());
    expect(screen.getAllByRole("columnheader", { name: "Modeled Safety Score change" })).toHaveLength(2);
  });
  it("fails closed on elapsed budget, a failed refetch and a future artifact clock", () => {
    const data = response();
    for (const selected of [selectDependencyScenario(data, ["root"], "", "pub", false, 8101), selectDependencyScenario(data, ["root"], "", "pub", true, 1000), selectDependencyScenario(data, ["root"], "", "pub", false, 899)]) {
      expect(selected.showNumbers).toBe(false);
      const view = render(<DependencyScenarioChange selection={selected} assetId="dependent" />);
      expect(view.container.textContent).not.toContain("-60");
      view.unmount();
    }
  });
});
