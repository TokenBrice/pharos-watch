// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import failureScenarios from "@data/failure-scenarios.json";
import type { FailureScenario, FailureScenarioEvidence, FailureScenariosById } from "@shared/types/failure-scenarios";
import { selectFailureScenario } from "@shared/lib/failure-scenarios";
import {
  findSummaryBudgetViolations,
  SUMMARY_PROSE_MAX_WORDS,
  SUMMARY_VERDICT_MAX_WORDS,
} from "@shared/lib/summary-budget";
import { FailureScenarioModule } from "../failure-scenario-module";
import { EVIDENCE_LABEL } from "../scenario-model";

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

describe("FailureScenarioModule claim-scoped evidence", () => {
  afterEach(cleanup);

  it("does not present approved USDC reserve access or redemption gates as verified on-chain", () => {
    const selection = selectFailureScenario(scenarios, "usdc-circle", {
      allowDrafts: false,
      now: new Date("2026-10-10T00:00:00Z"),
    });
    expect(selection).not.toBeNull();
    expect(selection!.isDraft).toBe(false);
    const { container } = render(<FailureScenarioModule selection={selection!} />);

    const footer = screen.getByText(/^Hypothetical premise/);
    expect(footer.textContent).not.toMatch(/verified|on[- ]?chain/i);
    for (const [id, evidence] of [
      ["bank-shock", "Inferred"],
      ["cash-access", "Documented"],
      ["mint-queue", "Documented"],
      ["secondary-sale", "Inferred"],
    ]) {
      const summary = container.querySelector(`#failure-scenario-${id} > summary`)!;
      expect(summary.textContent).toContain(evidence);
      expect(summary.textContent).not.toContain("Verified onchain");
    }
    // A measured pool quote remains on-chain evidence only for that figure.
    expect(screen.getByText("0.908 USDT").closest("[title]")?.getAttribute("title")).toBe("Verified onchain");
  });

  it.each([
    { name: "mixed evidence", evidence: ["verified-onchain", "documented", "inferred", "unverified"] as FailureScenarioEvidence[] },
    { name: "fully on-chain evidence", evidence: ["verified-onchain"] as FailureScenarioEvidence[] },
  ])("retains per-claim labels without a blanket verification claim for $name", ({ evidence }) => {
    const original = scenarios["usdc-circle"]!;
    const scenario: FailureScenario = {
      ...original,
      stages: original.stages.map((stage, index) => ({ ...stage, evidence: evidence[index % evidence.length]! })),
      keyFigures: original.keyFigures.map((figure) => ({ ...figure, evidence: evidence[0]! })),
      defenders: original.defenders.map((defender) => ({ ...defender, evidence: evidence[0]! })),
      exposure: original.exposure.map((item) => ({ ...item, evidence: evidence[0]! })),
      review: { status: "draft" },
    };
    const { container } = render(<FailureScenarioModule selection={{ scenario, isDraft: true }} />);
    expect(screen.getByText(/^Hypothetical premise/).textContent).not.toMatch(/verified|on[- ]?chain/i);
    for (const stage of scenario.stages) {
      const summary = container.querySelector(`#failure-scenario-${stage.id} > summary`)!;
      expect(summary.textContent).toContain(EVIDENCE_LABEL[stage.evidence]);
    }
  });
});
