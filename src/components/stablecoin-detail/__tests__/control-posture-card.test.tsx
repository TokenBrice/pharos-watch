// @vitest-environment node

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
  it("renders one posture chip with taxonomy and scope, folded detail, and the methodology link", () => {
    const html = renderToStaticMarkup(<ControlPostureCard view={VIEW} />);

    expect(html).toContain("Control posture");
    expect(html).toContain("Regulated entity");
    expect(html).toContain("Control posture: Regulated entity. This is a classification, not a score.");
    expect(html).toContain(">CEFI<");
    expect(html).toContain(">LOCAL<");
    expect(html).toContain("Classification details");
    expect(html).toContain("not a Safety Score input");
    expect(html).toContain('/methodology#safety-scores-methodology');
    expect(html).not.toContain("Sources");
    expect(html).not.toContain("/100");
    // The six-tile map is gone: unselected postures are not drawn.
    for (const label of ["Code", "DAO", "Multisig", "Operator", "Wrapper"]) {
      expect(html).not.toContain(`>${label}<`);
    }
  });

  it("renders nothing without a view", () => {
    expect(renderToStaticMarkup(<ControlPostureCard view={null} />)).toBe("");
    expect(renderToStaticMarkup(<ControlPostureCard />)).toBe("");
  });
});
