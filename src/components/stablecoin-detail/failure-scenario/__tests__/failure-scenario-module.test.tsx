// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import failureScenarios from "@data/failure-scenarios.json";
import type { FailureScenario, FailureScenarioEvidence, FailureScenariosById } from "@shared/types/failure-scenarios";
import { selectFailureScenario } from "@shared/lib/failure-scenarios";
import { FailureScenarioModule } from "../failure-scenario-module";
import { EVIDENCE_LABEL } from "../scenario-model";

const scenarios = failureScenarios as FailureScenariosById;

/** The footer line that closes the module, after its sources fold. */
function footerLine(container: HTMLElement): Element {
  return container.querySelector("#failure-scenario-sources")!.nextElementSibling!;
}

describe("FailureScenarioModule claim-scoped evidence", () => {

  it("does not present approved USDC reserve access or redemption gates as verified on-chain", () => {
    const selection = selectFailureScenario(scenarios, "usdc-circle", {
      allowDrafts: false,
      now: new Date("2026-10-10T00:00:00Z"),
    });
    expect(selection).not.toBeNull();
    expect(selection!.isDraft).toBe(false);
    const { container } = render(<FailureScenarioModule selection={selection!} />);

    expect(footerLine(container).textContent).toMatch(/^State at block [\d,]+ · Reviewed \d{4}-\d{2}-\d{2}$/);
    expect(footerLine(container).textContent).not.toMatch(/verified|on[- ]?chain/i);
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
    // Figure and ticker render as separate mono tokens; match the whole value cell.
    const figure = screen.getByText((_, element) => element?.textContent === "0.908 USDT" && element.childElementCount === 2);
    expect(figure.closest("[title]")?.getAttribute("title")).toBe("Verified onchain");
  });

  it("formats sub-unit figures and keeps word spacing out of the mono face", () => {
    const selection = selectFailureScenario(scenarios, "usde-ethena", {
      allowDrafts: false,
      now: new Date("2026-10-10T00:00:00Z"),
    });
    render(<FailureScenarioModule selection={selection!} />);
    const figures = screen.getByRole("group", { name: "Key figures" });
    expect(figures.textContent).toContain("808K tokens");
    expect(figures.textContent).not.toContain("0.808M");
    const threshold = within(figures).getByText((_, element) => element?.textContent === "5 of 10" && element.childElementCount === 3);
    for (const token of threshold.children) expect(token.textContent).toBe(token.textContent!.trim());
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
    expect(footerLine(container).textContent).not.toMatch(/verified|on[- ]?chain/i);
    for (const stage of scenario.stages) {
      const summary = container.querySelector(`#failure-scenario-${stage.id} > summary`)!;
      expect(summary.textContent).toContain(EVIDENCE_LABEL[stage.evidence]);
    }
  });
});
