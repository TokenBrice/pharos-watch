// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { FailureScenario, FailureScenarioStage } from "@shared/types/failure-scenarios";
import {
  findSummaryBudgetViolations,
  SUMMARY_PROSE_MAX_WORDS,
  SUMMARY_VERDICT_MAX_WORDS,
} from "@shared/lib/summary-budget";
import { FailureScenarioModule } from "../failure-scenario-module";
import { routeMapBreakpoint } from "../route-map";
import { buildScenarioClock, buildScenarioRoute, parseElapsed } from "../scenario-model";

function makeStage(id: string, elapsed: string): FailureScenarioStage {
  return {
    id,
    kind: "counterparty-failure",
    title: `Stage ${id}`,
    actor: "Settlement provider",
    action: "Suspend settlement",
    elapsed,
    cost: "Operational disruption",
    explanation: "Settlement stops while the provider reviews its obligations.",
    evidence: "inferred",
    sourceIds: ["fixture-source"],
  };
}

function makeScenario(overrides: Partial<FailureScenario> = {}): FailureScenario {
  return {
    coinId: "synthetic-linear",
    title: "How does Fixture Dollar break?",
    thesis: "Settlement disruption can leave holders unable to redeem.",
    premise: "Hypothetical: a settlement provider stops serving redemptions. This has not been observed.",
    stages: Array.from({ length: 5 }, (_, index) => makeStage(`linear-${index + 1}`, `T+${index}d`)),
    keyFigures: [{ value: "5 days", label: "Settlement horizon", evidence: "inferred", sourceIds: ["fixture-source"] }],
    defenders: [{ name: "Provider", verdict: "partial", why: "It can restore settlement.", evidence: "inferred", sourceIds: ["fixture-source"] }],
    falsifiers: [{ id: "independent-settlement", condition: "An independent settlement path becomes available", status: "unverified" }],
    exposure: [],
    sources: [{ id: "fixture-source", label: "Synthetic evidence", url: "https://example.com/evidence" }],
    evidencePin: { chainId: 1, block: 1, observedAt: "2026-10-07" },
    review: { status: "draft" },
    ...overrides,
  };
}

const LINEAR = makeScenario();
const THREE_BRANCHES = makeScenario({
  coinId: "synthetic-three-routes",
  title: "How does Branch Dollar break?",
  stages: [
    makeStage("start", "T+0"),
    makeStage("fork", "T+1h"),
    makeStage("join", "T+2d"),
    makeStage("settlement", "T+3d"),
    makeStage("outcome", "T+4d"),
  ],
  branchPoint: {
    afterStageId: "fork",
    branches: [4, 2, 1].map((length, index) => ({
      id: `route-${index + 1}`,
      label: `Alternative ${index + 1}`,
      keys: `${index + 1} approvals`,
      premise: "A provider-specific interruption blocks settlement.",
      stages: Array.from({ length }, (_, step) => makeStage(`route-${index + 1}-${step + 1}`, `T+${step + 2}h`)),
    })),
  },
});
const NON_TIME = makeScenario({
  coinId: "synthetic-non-time",
  title: "How does Event Dollar break?",
  stages: ["Before opening", "When access stops", "During review", "After notification", "Until resolved"]
    .map((elapsed, index) => makeStage(`event-${index + 1}`, elapsed)),
});

function expectSummaryBudget(container: HTMLElement, scenario: FailureScenario) {
  const body = container.querySelector("#failure-scenario-body")!.cloneNode(true) as HTMLElement;
  body.querySelectorAll("[data-module-fold], footer, [data-evidence-footer]").forEach((fold) => fold.remove());
  expect(body.textContent).toContain(scenario.thesis);
  expect(findSummaryBudgetViolations(scenario.thesis, SUMMARY_VERDICT_MAX_WORDS)).toEqual([]);
  for (const paragraph of body.querySelectorAll("p")) {
    const text = paragraph.textContent?.trim() ?? "";
    if (text !== scenario.thesis) {
      expect({ text, violations: findSummaryBudgetViolations(text, SUMMARY_PROSE_MAX_WORDS) }).toEqual({ text, violations: [] });
    }
  }
  expect(findSummaryBudgetViolations(body.textContent ?? "", Number.POSITIVE_INFINITY)).toEqual([]);
}

afterEach(cleanup);

describe("coin-agnostic failure scenarios", () => {
  it("shows the approved reviewer and reviewed date without expiry wording", () => {
    const scenario = makeScenario({
      evidencePin: { chainId: 1, block: 26_138_725, observedAt: "2026-10-07" },
      review: {
        status: "approved",
        reviewedBy: "Fixture Maintainer",
        reviewedAt: "2020-01-02T12:34:56Z",
        contentSha256: "a".repeat(64),
      },
    });
    const { container } = render(<FailureScenarioModule selection={{ scenario, isDraft: false }} />);
    expect(screen.getByText(/^Reviewed/).textContent).toBe("Reviewed 2020-01-02");
    const stamp = screen.getByText(/^Approved by Fixture Maintainer on/);
    expect(stamp.textContent).toBe("Approved by Fixture Maintainer on 2020-01-02 · state at block 26,138,725");
    expect(within(stamp).getAllByText("2020-01-02")).toHaveLength(1);
    const dates = screen.getAllByText("2020-01-02");
    expect(dates).toHaveLength(2);
    for (const date of dates) {
      expect(date.classList.contains("pharos-numeric")).toBe(true);
    }
    expect(within(stamp).getByText("26,138,725").classList.contains("pharos-numeric")).toBe(true);
    expect(container.textContent).not.toMatch(/re-review|expir/i);
    expect(screen.queryByText("Draft — not approved")).toBeNull();
    expect(screen.queryByRole("note", { name: "Draft scenario" })).toBeNull();
  });

  it("retains the draft chip and development notice without a reviewed date", () => {
    render(<FailureScenarioModule selection={{ scenario: LINEAR, isDraft: true }} />);
    expect(screen.getByText("Draft — not approved")).toBeDefined();
    expect(screen.getByRole("note", { name: "Draft scenario" }).textContent)
      .toContain("Draft, not approved: development preview only.");
    expect(screen.queryByText(/^Reviewed/)).toBeNull();
    expect(screen.queryByText(/^Approved by/)).toBeNull();
  });

  it.each([
    { name: "five-step linear path", scenario: LINEAR, length: 5, breakpoint: "@[45rem]/evidence:block", hide: "@[45rem]/evidence:hidden", clock: true },
    { name: "nine-step three-route path", scenario: THREE_BRANCHES, length: 9, breakpoint: "@[78rem]/evidence:block", hide: "@[78rem]/evidence:hidden", clock: true },
    { name: "non-time labels", scenario: NON_TIME, length: 5, breakpoint: "@[45rem]/evidence:block", hide: "@[45rem]/evidence:hidden", clock: false },
  ])("renders $name as pure data", ({ scenario, length, breakpoint, hide, clock }) => {
    const { container } = render(<FailureScenarioModule selection={{ scenario, isDraft: true }} />);
    expect(screen.getByRole("heading", { name: scenario.title })).toBeDefined();
    expectSummaryBudget(container, scenario);
    const route = buildScenarioRoute(scenario);
    expect(route.length).toBe(length);
    const horizontal = container.querySelector('[data-route-layout="horizontal"]')!;
    const vertical = container.querySelector('[data-route-layout="vertical"]')!;
    expect(horizontal.classList.contains(breakpoint)).toBe(true);
    expect(vertical.classList.contains(hide)).toBe(true);
    expect(horizontal.querySelectorAll("a")).toHaveLength(route.steps.length);
    expect(vertical.querySelectorAll("a")).toHaveLength(route.steps.length);
    expect(container.querySelectorAll("details[data-scenario-step]")).toHaveLength(route.steps.length);
    expect(Boolean(container.querySelector("#failure-scenario-clock"))).toBe(clock);
    expect(container.textContent).not.toMatch(/crvUSD|Convex|veCRV|vlCVX|PegKeeper/);
    // Path order and authored labels are retained, independently of the ruler.
    const steps = [...container.querySelectorAll("details[data-scenario-step]")];
    expect(steps.map((step) => step.id)).toEqual(route.steps.map((step) => `failure-scenario-${step.stage.id}`));
    for (const step of route.steps) {
      expect(within(container.querySelector(`#failure-scenario-${step.stage.id}`)! as HTMLElement).getByText(step.stage.elapsed)).toBeDefined();
    }
  });

  it("numbers every branch by path position and rejoins after the longest branch", () => {
    const route = buildScenarioRoute(THREE_BRANCHES);
    expect(route.lanes).toHaveLength(3);
    expect(route.lanes.map((lane) => lane.steps.map((step) => step.number))).toEqual([[3, 4, 5, 6], [3, 4], [3]]);
    expect(route.post.map((step) => step.number)).toEqual([7, 8, 9]);
    const { container } = render(<FailureScenarioModule selection={{ scenario: THREE_BRANCHES, isDraft: true }} />);
    expect(container.querySelectorAll('[data-route-layout="vertical"] [role="group"]')).toHaveLength(3);
    const path = container.querySelector("#failure-scenario-path")! as HTMLElement;
    fireEvent.click(within(path).getByRole("button", { name: "Expand all" }));
    expect(container.querySelectorAll("details[data-scenario-step][open]")).toHaveLength(route.steps.length);
    fireEvent.click(within(path).getByRole("button", { name: "Collapse all" }));
    expect(container.querySelectorAll("details[data-scenario-step][open]")).toHaveLength(0);
  });

  it("opens the corresponding step from the route map", () => {
    const { container } = render(<FailureScenarioModule selection={{ scenario: LINEAR, isDraft: true }} />);
    const step = container.querySelector("#failure-scenario-linear-3")! as HTMLDetailsElement;
    // jsdom lacks scrolling; this test covers the native disclosures and focus.
    step.scrollIntoView = () => {};
    fireEvent.click(container.querySelector('[data-route-layout="horizontal"] a[href="#failure-scenario-linear-3"]')!);
    expect(step.open).toBe(true);
    expect((container.querySelector("#failure-scenario-path") as HTMLDetailsElement).open).toBe(true);
    expect(document.activeElement).toBe(step.querySelector("summary"));
  });

  it("keeps path layout independent of time ordering", () => {
    const scenario = makeScenario({ stages: ["T+2w", "T+1d", "T+3w", "T+4d", "T+4w"].map((elapsed, index) => makeStage(`bank-${index}`, elapsed)) });
    const route = buildScenarioRoute(scenario);
    expect(buildScenarioClock(scenario, route)?.horizonHours).toBe(672);
    const { container } = render(<FailureScenarioModule selection={{ scenario, isDraft: true }} />);
    expectSummaryBudget(container, scenario);
    expect(container.querySelectorAll("details[data-scenario-step]")).toHaveLength(5);
    expect(container.querySelector("#failure-scenario-clock")).not.toBeNull();
  });

  it.each(["T+0", "T+7d", "No timeline"])("omits the ruler for a single instant or no timeline: %s", (elapsed) => {
    const scenario = makeScenario({ stages: LINEAR.stages.map((stage) => ({ ...stage, elapsed })) });
    expect(buildScenarioClock(scenario, buildScenarioRoute(scenario))).toBeNull();
    const { container } = render(<FailureScenarioModule selection={{ scenario, isDraft: true }} />);
    expect(container.querySelector("#failure-scenario-clock")).toBeNull();
    expect(container.querySelectorAll("details[data-scenario-step]")).toHaveLength(5);
  });

  it("does not silently plot a partial timeline, and retains an unplottable window as text", () => {
    const scenario = makeScenario({
      stages: LINEAR.stages.map((stage, index) => index === 2 ? { ...stage, elapsed: "Timing unknown" } : stage),
      window: { label: "Settlement window", fromStageId: "linear-1", toStageId: "linear-5", duration: "Several days", note: "Timing depends on the provider." },
    });
    const { container } = render(<FailureScenarioModule selection={{ scenario, isDraft: true }} />);
    expect(container.querySelector("#failure-scenario-clock")).toBeNull();
    expect(screen.getByText("Settlement window · Several days")).toBeDefined();
    expect(container.textContent).toContain(scenario.window!.note);
  });

  it("retains a draft review note in detail when it cannot appear in the summary", () => {
    const note = "Verified state at block 26,138,725; awaiting maintainer review.";
    const scenario = makeScenario({ review: { status: "draft", note } });
    const { container } = render(<FailureScenarioModule selection={{ scenario, isDraft: true }} />);
    expectSummaryBudget(container, scenario);
    expect(screen.getByText(note)).toBeDefined();
    expect(container.querySelector("#failure-scenario-path")!.textContent).toContain(note);
    expect(screen.getByRole("note", { name: "Draft scenario" }).textContent).not.toContain(note);
  });

  it("marks a duration-based outcome as terminal on the clock", () => {
    const scenario = makeScenario({ stages: LINEAR.stages.map((stage, index) => index === 4 ? { ...stage, elapsed: "T+4d → T+1w" } : stage) });
    const clock = buildScenarioClock(scenario, buildScenarioRoute(scenario))!;
    expect(clock.rows[0].spans).toEqual([{ start: 96, end: 168, number: 5, hypothetical: true, terminal: true }]);
    const { container } = render(<FailureScenarioModule selection={{ scenario, isDraft: true }} />);
    const ruler = container.querySelector('[role="img"]')!;
    expect(within(ruler as HTMLElement).getByText("5").classList.contains("bg-foreground")).toBe(true);
  });

  it("uses static length bands and an explicit vertical fallback", () => {
    for (const length of [1, 5, 6, 7, 8, 9, 10]) expect(routeMapBreakpoint(length)).toBeDefined();
    expect(routeMapBreakpoint(8)?.show).toBe("hidden @[69rem]/evidence:block");
    expect(routeMapBreakpoint(11)).toBeUndefined();
    const scenario = makeScenario({ stages: Array.from({ length: 11 }, (_, index) => makeStage(`long-${index}`, `T+${index}h`)) });
    const { container } = render(<FailureScenarioModule selection={{ scenario, isDraft: true }} />);
    expect(container.querySelector('[data-route-layout="horizontal"]')).toBeNull();
    expect(container.querySelector('[data-route-layout="vertical"]')!.querySelectorAll("a")).toHaveLength(11);
  });
});

describe("elapsed-label clock convention", () => {
  it.each<[string, { start: number; end: number }]>([
    ["T+0", { start: 0, end: 0 }],
    ["T+0 (or earlier)", { start: 0, end: 0 }],
    ["T+30min", { start: 0.5, end: 0.5 }],
    ["T+1.5h", { start: 1.5, end: 1.5 }],
    ["T+2w", { start: 336, end: 336 }],
    ["T+0 → T+1d", { start: 0, end: 24 }],
  ])("parses explicit label %s", (label, expected) => {
    expect(parseElapsed(label)).toEqual(expected);
  });

  it.each(["Before opening", "T+7days", "T+3", "T+2d → T+1d", "About T+7d", "T+1.2.3h", "T+-1h", "T+0 → T+1h → T+2h"])("does not invent a position for %s", (label) => {
    expect(parseElapsed(label)).toBeNull();
  });
});
