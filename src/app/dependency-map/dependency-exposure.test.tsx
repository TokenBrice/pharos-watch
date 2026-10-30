// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { computeDependencyExposure, useDependencyExposureMode } from "@/hooks/use-dependency-exposure-mode";
import { readDependencyExposureUrl, resetDependencyExposureUrl, writeDependencyExposureUrl } from "@/lib/dependency-exposure-url";
import { DependencyExposureResults } from "./dependency-exposure-results";
import { DependencyExposureWorkspace, useDependencyExposureWorkspace } from "./dependency-exposure-workspace";
import type { DependencyGraphResponse } from "@shared/types/dependency-graph";
import { projectDependencyGraph } from "@shared/types/dependency-graph";
import { DependencyHero } from "./dependency-hero";
import { buildDependencyHubsModel } from "@shared/lib/dependency-hubs-model";
vi.mock("@/hooks/use-dependency-scenarios", () => ({ useDependencyScenarios: () => ({ data: undefined, isError: false }) }));

function publication() {
  return projectDependencyGraph(makeReportCardsV9Response({ cards: [makeV9Card({ id: "root" }), makeV9Card({ id: "known", supply: { circulatingUsdAtEvaluation: 1000, asOfSec: 100, generationId: "supply-1" } }), makeV9Card({ id: "unknown", supply: undefined })], dependencyGraph: { edges: [
    { from: "root", to: "known", kind: "basket", weight: 0.4, materiality: "basket-weighted", upstreamScore: 80 },
    { from: "root", to: "unknown", kind: "serial", weight: null, materiality: "serial", upstreamScore: 80 },
  ] } }));
}
const roots = ["root"];

describe("Exposure mode", () => {
  it("distinguishes unpublished USD from a published zero and qualifies partial known totals", () => {
    const data = publication();
    data.nodes.forEach(node => { node.circulatingUsdAtEvaluation = null; });
    const view = render(<DependencyExposureResults result={computeDependencyExposure(data, roots)} publication={data} roots={roots} options={[]} inspectedId={null} onInspect={() => {}} networkUpdated={false} held={false} />);
    const headline = screen.getByRole("heading", { level: 3 });
    expect(headline.textContent).not.toMatch(/\$/);
    expect(headline.textContent).toContain("direct USD unavailable");
    expect(headline.textContent).toContain("indirect USD unavailable");
    data.nodes.find(node => node.id === "known")!.circulatingUsdAtEvaluation = 0;
    view.rerender(<DependencyExposureResults result={computeDependencyExposure(data, roots)} publication={data} roots={roots} options={[]} inspectedId={null} onInspect={() => {}} networkUpdated={false} held={false} />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toContain("direct $0.00 (known supply only)");
    data.nodes.find(node => node.id === "known")!.circulatingUsdAtEvaluation = 1000;
    view.rerender(<DependencyExposureResults result={computeDependencyExposure(data, roots)} publication={data} roots={roots} options={[]} inspectedId={null} onInspect={() => {}} networkUpdated={false} held={false} />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toContain("direct $400.00 (known supply only)");
  });
  it("shows published Pipeline gap and partial causes without changing known structural exposure", () => {
    const data = publication();
    const gap = data.nodes.find(node => node.id === "known")!;
    gap.ratingStatus = "pipeline-gap";
    gap.grade = null;
    gap.score = null;
    gap.partialEvidence = { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: ["backing", "exit"], causes: ["A"] };
    gap.pillars!.backing = { score: null, aggregationDisposition: "excluded-a-b" };
    gap.pillars!.exit = { score: null, aggregationDisposition: "excluded-a-b" };
    const partial = data.nodes.find(node => node.id === "unknown")!;
    partial.partialEvidence = { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: ["exit"], causes: ["B"] };
    partial.pillars!.exit = { score: null, aggregationDisposition: "excluded-a-b" };
    render(<DependencyExposureResults result={computeDependencyExposure(data, roots)} publication={data} roots={roots} options={[]} inspectedId={null} onInspect={() => {}} networkUpdated={false} held={false} />);
    const table = screen.getByRole("table");
    expect(within(table).getByText(/Pipeline gap · fewer than two pillars available/)).toBeTruthy();
    expect(within(table).getByText("Backing and Exit excluded · data pipeline unavailable")).toBeTruthy();
    expect(within(table).getByText(/Exit excluded.*awaiting curation/)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3 }).textContent).toContain("$400.00 (known supply only)");
    expect(within(table).queryByText("NR")).toBeNull();
  });

  it("keeps the map and root picker available before choosing roots, without reporting empty reach", async () => {
    window.history.replaceState(null, "", "/dependency-map/");
    const data = publication();
    const cards = data.nodes.map(card => ({ id: card.id, name: card.id, symbol: card.id, grade: card.grade, ratingStatus: card.ratingStatus, partialEvidence: card.partialEvidence }));
    const mcapMap = new Map([["known", 1000]]);
    const model = buildDependencyHubsModel({ cards, edges: data.edges, mcapMap });
    function Harness() {
      const workspace = useDependencyExposureWorkspace(data);
      return <DependencyHero workspace={workspace} model={model} cards={cards} dependencyEdges={data.edges} mcapMap={mcapMap} methodologyVersion={data.methodologyVersion} publishedAt={data.updatedAt} />;
    }
    render(<Harness />);
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Exposure$/ }));
    expect(screen.getByRole("button", { name: /^Explore$/ })).toBeTruthy();
    expect(screen.getByRole("figure", { name: /Dependency graph showing/ })).toBeTruthy();
    expect(screen.getByLabelText("Add upstream coin")).toBeTruthy();
    expect(screen.getByText("Choose one or more upstream coins to trace exposure")).toBeTruthy();
    expect(screen.queryByText(/No mapped downstream exposure found/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Add upstream coin"), { target: { value: "unknown" } });
    fireEvent.click(screen.getByRole("button", { name: "Trace exposure" }));
    expect(screen.getByText(/No mapped downstream exposure found/)).toBeTruthy();
    expect(screen.queryByText("Choose one or more upstream coins to trace exposure")).toBeNull();
  });
  it("round-trips repeated roots and resets only owned URL keys", () => {
    const search = "?focus=a&type=wrapper&limit=20&trace=b&campaign=keep";
    const written = writeDependencyExposureUrl(search, { mode: "exposure", roots: ["a", "b"] });
    expect(readDependencyExposureUrl(written)).toEqual({ mode: "exposure", roots: ["a", "b"] });
    expect(new URLSearchParams(resetDependencyExposureUrl(written)).toString()).toBe(new URLSearchParams(search).toString());
    const params = new URLSearchParams(written);
    for (const [key, value] of new URLSearchParams(search)) expect(params.get(key)).toBe(value);
    expect(readDependencyExposureUrl(writeDependencyExposureUrl(written, { mode: "explore", roots: ["a", "b"] })).roots).toEqual(["a", "b"]);
  });
  it("retains a publication across same-identity polls and recomputes generation and supply changes", () => {
    const first = publication();
    const { result, rerender } = renderHook(({ data }) => useDependencyExposureMode(data, roots), { initialProps: { data: first } });
    expect(result.current.result?.direct.knownUsd).toBe(400);
    const poll = publication();
    poll.nodes.find(node => node.id === "known")!.circulatingUsdAtEvaluation = 2000;
    rerender({ data: poll });
    expect(result.current.result?.direct.knownUsd).toBe(400);
    poll.publicationGenerationId = "next";
    rerender({ data: { ...poll } });
    expect(result.current.result?.direct.knownUsd).toBe(800);
    expect(result.current.networkUpdated).toBe(true);
    const supplyChange = publication();
    supplyChange.publicationGenerationId = "next";
    supplyChange.nodes.find(node => node.id === "known")!.supplyAsOfSec = 200;
    supplyChange.nodes.find(node => node.id === "known")!.circulatingUsdAtEvaluation = 3000;
    rerender({ data: supplyChange });
    expect(result.current.result?.direct.knownUsd).toBe(1200);
  });
  it("keeps unknown supply rows and quarantines a malformed share to its row", () => {
    const data = publication();
    data.edges.push({ from: "root", to: "malformed", kind: "basket", weight: Number.NaN, materiality: "basket-weighted", upstreamScore: null });
    const result = computeDependencyExposure(data, roots);
    expect(result.rows.find(row => row.id === "known")?.exposureUsd).toBe(400);
    expect(result.rows.find(row => row.id === "unknown")?.supplyUnknown).toBe(true);
    expect(result.rows.find(row => row.id === "malformed")?.share).toBeNull();
    expect(result.direct.knownUsd).toBe(400);
  });

  it("hydrates shared roots without a dialog and closes back to its opener preserving roots", async () => {
    window.history.replaceState(null, "", "/dependency-map/?mode=exposure&root=root&limit=20");
    function Harness({ data }: { data: DependencyGraphResponse }) {
      const workspace = useDependencyExposureWorkspace(data);
      return <><button onClick={() => workspace.addRoot("known")}>Pick root</button><DependencyExposureWorkspace workspace={workspace} options={[]}>{workspace.modeControls}</DependencyExposureWorkspace></>;
    }
    render(<Harness data={publication()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    const opener = screen.getByRole("button", { name: "Pick root" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("tab", { name: "Results" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close exposure" }));
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      requestAnimationFrame(() => resolve());
      await promise;
    });
    expect(document.activeElement).toBe(opener);
    expect(readDependencyExposureUrl(window.location.search).roots).toEqual(["root", "known"]);
    expect(new URLSearchParams(window.location.search).get("limit")).toBe("20");
  });
});
