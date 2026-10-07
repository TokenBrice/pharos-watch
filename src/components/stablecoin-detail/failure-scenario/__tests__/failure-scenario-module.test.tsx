// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import failureScenarios from "@data/failure-scenarios.json";
import type { FailureScenariosById } from "@shared/types/failure-scenarios";
import {
  findSummaryBudgetViolations,
  SUMMARY_PROSE_MAX_WORDS,
  SUMMARY_VERDICT_MAX_WORDS,
} from "@shared/lib/summary-budget";
import { FailureScenarioModule } from "../failure-scenario-module";

const scenarios = failureScenarios as FailureScenariosById;

describe.each(Object.keys(scenarios))("FailureScenarioModule summary layer: %s", (coinId) => {
  afterEach(cleanup);

  it("keeps every always-visible line within the summary budget", () => {
    const { container } = render(<FailureScenarioModule selection={{ scenario: scenarios[coinId]!, isDraft: true }} />);
    const body = container.querySelector("#failure-scenario-body")!.cloneNode(true) as HTMLElement;
    // The summary layer is the body minus its folds (attack-path steps,
    // defenders, falsifiers, exposure, sources) and the footer line.
    body.querySelectorAll("[data-module-fold]").forEach((fold) => fold.remove());
    body.querySelectorAll("footer, [data-evidence-footer]").forEach((footer) => footer.remove());

    const verdict = scenarios[coinId]!.thesis;
    expect(body.textContent).toContain(verdict);
    expect(findSummaryBudgetViolations(verdict, SUMMARY_VERDICT_MAX_WORDS)).toEqual([]);

    const prose = [...body.querySelectorAll("p")]
      .map((paragraph) => paragraph.textContent?.trim() ?? "")
      .filter((text) => text.length > 0 && text !== verdict);
    for (const text of prose) {
      expect({ text, violations: findSummaryBudgetViolations(text, SUMMARY_PROSE_MAX_WORDS) }).toEqual({ text, violations: [] });
    }
    // No raw identifier anywhere in the summary layer, including the route map.
    expect(findSummaryBudgetViolations(body.textContent ?? "", Number.POSITIVE_INFINITY)).toEqual([]);
    expect(body.textContent).not.toMatch(/\b0x[0-9a-f]/i);
  });
});
