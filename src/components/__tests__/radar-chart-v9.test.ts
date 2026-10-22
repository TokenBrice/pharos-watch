// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { CompareRadarV9, buildV9RadarDataset } from "@/components/radar-chart-v9";
import { makeReportCardsV9Response, makeV9Card, makeV9Pillars } from "@/test/fixtures/safety-score-v9";
import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import type { SafetyScoreV9Card } from "@shared/types";
import { projectV9TableCard } from "@shared/lib/report-cards-v9-projections";
import type * as Recharts from "recharts";

const radiusAxis = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({ ref: vi.fn(), ready: true, width: 300, height: 300 }),
}));
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof Recharts>();
  return {
    ...actual,
    PolarRadiusAxis: (props: Parameters<typeof actual.PolarRadiusAxis>[0]) => {
      radiusAxis(props);
      return createElement(actual.PolarRadiusAxis, props);
    },
  };
});
afterEach(() => { cleanup(); radiusAxis.mockClear(); });

describe("V9 radar cohorts", () => {
  it("requires three complete rated cohort members before publishing any medians", () => {
    const identity = makeReportCardsV9Response().safetyScoreIdentity;
    const entry = (card: SafetyScoreV9Card) => ({ card, identity, color: "#123456" });
    const rated = [90, 80, 30].map((score, index) => entry(makeV9Card({
      id: `rated-${index}`, pillars: makeV9Pillars({ backing: score, exit: score, control: score }),
    })));
    const unusable = [
      entry(makeReportCardsV9PipelineGapCard("control", "A")),
      entry(makeV9Card({ pillars: makeV9Pillars({ backing: 100, exit: 100, control: null }) })),
    ];
    expect(buildV9RadarDataset([rated[0]!], [...rated.slice(0, 2), ...unusable])).toMatchObject({
      status: "available", value: { cohortMedians: null },
    });
    expect(buildV9RadarDataset([rated[0]!], [...rated, ...unusable])).toMatchObject({
      status: "available", value: { cohortMedians: { backing: 80, exit: 80, control: 80 } },
    });
    expect(buildV9RadarDataset([rated[0]!], unusable)).toMatchObject({
      status: "available", value: { cohortMedians: null },
    });
  });

  it("keeps a rated card's missing pillar as an unplotted Unknown axis and still rejects pipeline gaps", () => {
    const identity = makeReportCardsV9Response().safetyScoreIdentity;
    const partial = makeReportCardsV9PartialCard("exit", "B");
    const result = buildV9RadarDataset([{ card: partial, identity, color: "#123456" }]);
    if (result.status !== "available") throw new Error("Expected a plottable partial card");
    expect(result.value.rows.find((row) => row.pillar === "Exit")?.[partial.id]).toBeNull();
    expect(result.value.unknownAxes).toEqual({ Exit: { seriesIds: [partial.id], assumptions: [] } });
    expect(buildV9RadarDataset([{ card: makeReportCardsV9PipelineGapCard("control", "A"), identity, color: "#123456" }]))
      .toEqual({ status: "unavailable", reason: "card-unavailable" });
  });

  it("names a priced unknown's scoring assumption without plotting it", () => {
    const identity = makeReportCardsV9Response().safetyScoreIdentity;
    const card = projectV9TableCard(makeV9Card({ id: "uusd", pillars: makeV9Pillars({ backing: 35, exit: 50, control: 60 }) }));
    card.pillars.exit = { score: null, aggregationDisposition: "unavailable", pricedUnknown: { cause: "U", score: 50 } };
    const result = buildV9RadarDataset([{ card, identity, color: "#10b981" }]);
    if (result.status !== "available") throw new Error("Expected a plottable priced-unknown card");
    expect(result.value.unknownAxes.Exit).toEqual({
      seriesIds: ["uusd"], assumptions: ["scored as an unknown at 50/100 (not yet researched)"],
    });
    const { container } = render(createElement(CompareRadarV9, { series: [{ card, identity, color: "#10b981" }], cohortSeries: [], size: 300 }));
    expect(container.textContent).toContain("Unknown");
    expect([...container.querySelectorAll("title")].map((title) => title.textContent).join(" "))
      .toContain("Exit: unknown, not plotted. scored as an unknown at 50/100 (not yet researched)");
    // Two measured pillars: one open segment and two dots, no filled polygon through the missing axis.
    expect(container.querySelectorAll("circle[fill='#10b981']")).toHaveLength(2);
    expect(container.querySelectorAll("line[stroke='#10b981']")).toHaveLength(1);
    expect(container.querySelector("path[fill='#10b981']")).toBeNull();
  });
  it("builds exactly three pillars and a same-identity cohort median", () => {
    const response = makeReportCardsV9Response();
    const series = [
      makeV9Card({ id: "asset-a", pillars: makeV9Pillars({ backing: 90, exit: 10, control: 60 }) }),
      makeV9Card({ id: "asset-b", pillars: makeV9Pillars({ backing: 20, exit: 80, control: 30 }) }),
      makeV9Card({ id: "asset-c", pillars: makeV9Pillars({ backing: 50, exit: 40, control: 90 }) }),
    ].map((card) => ({ card, identity: response.safetyScoreIdentity, color: "#123456" }));
    const result = buildV9RadarDataset(series, series);
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.value.rows.map((row) => row.pillar)).toEqual(["Backing", "Exit", "Control"]);
    expect(result.value.cohortMedians).toEqual({ backing: 50, exit: 40, control: 60 });
    expect(result.value.rows).toEqual([
      { pillar: "Backing", "asset-a": 90, "asset-b": 20, "asset-c": 50, __cohortMedian: 50 },
      { pillar: "Exit", "asset-a": 10, "asset-b": 80, "asset-c": 40, __cohortMedian: 40 },
      { pillar: "Control", "asset-a": 60, "asset-b": 30, "asset-c": 90, __cohortMedian: 60 },
    ]);
    expect(buildV9RadarDataset(series, series.slice(0, 2))).toMatchObject({
      status: "available", value: { cohortMedians: null },
    });
  });

  it("rejects mixed models and policy/publication identities", () => {
    const response = makeReportCardsV9Response();
    const card = makeV9Card();
    const v8Identity = {
      model: "v8" as const,
      schemaVersion: 1 as const,
      methodologyVersion: "v8.17",
      evaluationBuildDigest: "b".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
      publicationGenerationId: "v8-publication",
    };
    expect(buildV9RadarDataset([
      { card, identity: response.safetyScoreIdentity, color: "#123456" },
      { card: { ...card, id: "asset-b" }, identity: v8Identity, color: "#654321" },
    ])).toEqual({ status: "unavailable", reason: "identity-mismatch" });
    expect(buildV9RadarDataset([
      { card, identity: response.safetyScoreIdentity, color: "#123456" },
      {
        card: { ...card, id: "asset-b" },
        identity: { ...response.safetyScoreIdentity, policyId: "other-policy" },
        color: "#654321",
      },
    ])).toEqual({ status: "unavailable", reason: "identity-mismatch" });
  });

  it("suppresses incomplete cohort medians and rejects a displayed card with fewer than two pillars", () => {
    const identity = makeReportCardsV9Response().safetyScoreIdentity;
    const displayed = { card: makeV9Card(), identity, color: "#123456" };
    const missing = { ...displayed, card: makeV9Card() };
    missing.card.pillars.backing.score = null;
    const sparse = { ...displayed, card: makeV9Card() };
    sparse.card.pillars.backing.score = null;
    sparse.card.pillars.exit.score = null;
    expect(buildV9RadarDataset([sparse])).toEqual({ status: "unavailable", reason: "card-unavailable" });
    const result = buildV9RadarDataset([displayed], [missing, missing, missing]);
    expect(result).toMatchObject({ status: "available", value: { cohortMedians: null } });
    if (result.status !== "available") throw new Error("Expected available displayed card");
    expect(result.value.rows.every((row) => !("__cohortMedian" in row))).toBe(true);
  });

  it("rejects cohort-only identity mismatch and empty displayed series", () => {
    const identity = makeReportCardsV9Response().safetyScoreIdentity;
    const displayed = { card: makeV9Card(), identity, color: "#123456" };
    expect(buildV9RadarDataset([displayed], [{
      ...displayed, identity: { ...identity, policyId: "different" },
    }])).toEqual({ status: "unavailable", reason: "identity-mismatch" });
    expect(buildV9RadarDataset([], [displayed])).toEqual({ status: "unavailable", reason: "invalid-v9-response" });
  });

  it("renders a fixed absolute radial domain for low and high scores with or without a cohort", () => {
    const identity = makeReportCardsV9Response().safetyScoreIdentity;
    const entry = (score: number, index: number) => ({
      card: makeV9Card({ id: `asset-${index}`, pillars: makeV9Pillars({ backing: score, exit: score, control: score }) }),
      identity, color: "#123456",
    });
    const low = entry(20, 0);
    const high = entry(100, 1);
    const { rerender } = render(createElement(CompareRadarV9, { series: [low] }));
    expect(radiusAxis).toHaveBeenLastCalledWith(expect.objectContaining({ type: "number", domain: [0, 100] }));
    rerender(createElement(CompareRadarV9, { series: [high] }));
    expect(radiusAxis).toHaveBeenLastCalledWith(expect.objectContaining({ domain: [0, 100] }));
    rerender(createElement(CompareRadarV9, { series: [low], cohortSeries: [low, high, entry(80, 2)] }));
    expect(radiusAxis).toHaveBeenLastCalledWith(expect.objectContaining({ domain: [0, 100] }));
    rerender(createElement(CompareRadarV9, { series: [low], cohortSeries: [] }));
    expect(radiusAxis).toHaveBeenLastCalledWith(expect.objectContaining({ domain: [0, 100] }));
  });
});
