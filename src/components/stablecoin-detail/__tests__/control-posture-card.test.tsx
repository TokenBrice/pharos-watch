import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ControlPostureCard } from "../control-posture-card";
import type { ControlPostureView } from "@/lib/control-posture";

const VIEW: ControlPostureView = {
  key: "regulated-entity",
  label: "Regulated entity",
  shortLabel: "Regulated",
  badgeClassName: "border-indigo-500/25 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400",
  scope: "LOCAL",
  summary:
    "USDC control posture: Regulated entity. This classification is descriptive; V9 Economic Control is scored through mint, oracle, and bridge evidence.",
  facts: [
    { key: "posture", label: "Posture", value: "Regulated entity" },
    { key: "taxonomy", label: "Taxonomy", value: "CEFI" },
    { key: "scope", label: "Scope", value: "LOCAL" },
    { key: "scoring-role", label: "Scoring role", value: "DESCRIPTIVE" },
  ],
  details: [
    "Material control is exercised by an identified regulated entity.",
    "The CEFI taxonomy is broader than this operational classification.",
    "Control posture is not a Safety Score input.",
  ],
};

describe("ControlPostureCard", () => {
  it("renders the active category, critical facts, folded detail, and methodology link", () => {
    const html = renderToStaticMarkup(<ControlPostureCard view={VIEW} />);

    expect(html).toContain("Control posture");
    expect(html).toContain("Regulated entity");
    expect(html).toContain("Control posture classification map. Regulated entity selected. This is not a score.");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("Taxonomy");
    expect(html).toContain("CEFI");
    expect(html).toContain("DESCRIPTIVE");
    expect(html).toContain("Classification details");
    expect(html).toContain("not a Safety Score input");
    expect(html).toContain('/methodology#safety-scores-methodology');
    expect(html).not.toContain("Sources");
    expect(html).not.toContain("/100");
    expect(html).not.toContain("right = safer");
  });

  it("renders all six categories in the classification map", () => {
    const html = renderToStaticMarkup(<ControlPostureCard view={VIEW} />);

    for (const label of ["Code", "DAO", "Multisig", "Regulated", "Operator", "Wrapper"]) {
      expect(html).toContain(`>${label}<`);
    }
  });

  it("renders nothing without a view", () => {
    expect(renderToStaticMarkup(<ControlPostureCard view={null} />)).toBe("");
    expect(renderToStaticMarkup(<ControlPostureCard />)).toBe("");
  });
});
