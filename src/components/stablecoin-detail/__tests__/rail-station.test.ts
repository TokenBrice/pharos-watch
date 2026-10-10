// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { REDEMPTION_SETTLEMENT_LABELS } from "@shared/lib/classification";
import { isMonoArrowLabel, RailArrow, type RailArrowOrientation } from "../rail-station";

describe("isMonoArrowLabel", () => {
  it("keeps the mono figure treatment for pure figures only", () => {
    expect(isMonoArrowLabel("1-7")).toBe(true);
    expect(isMonoArrowLabel("≤ 24")).toBe(true);
  });

  it("reads every label containing a letter as prose, whatever it leads with", () => {
    for (const label of Object.values(REDEMPTION_SETTLEMENT_LABELS)) {
      expect(isMonoArrowLabel(label)).toBe(false);
    }
    expect(isMonoArrowLabel("T+1")).toBe(false);
    expect(isMonoArrowLabel("Next business day")).toBe(false);
  });
});

describe("RailArrow", () => {
  it.each(["container", "responsive", "horizontal"] as const)("preserves %s arrow structure and label treatment", (orientation: RailArrowOrientation) => {
    for (const label of [undefined, "≤ 24", "Same day"]) {
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(createElement(RailArrow, { orientation, label }));
      const root = host.firstElementChild!;
      const horizontal = orientation === "horizontal";
      const children = [...root.children];
      expect(root.getAttribute("aria-hidden")).toBe(!horizontal && !label ? "true" : null);
      expect(children.map((child) => child.tagName)).toEqual(horizontal ? (label ? ["SPAN", "DIV"] : ["DIV"]) : (label ? ["DIV", "SPAN", "DIV"] : ["DIV", "DIV"]));
      const arrows = children.filter((child) => child.tagName === "DIV");
      expect(arrows.every((arrow) => arrow.children.length === 2)).toBe(true);
      expect(arrows.map((arrow) => arrow.getAttribute("aria-hidden"))).toEqual(horizontal ? ["true"] : label ? ["true", "true"] : [null, null]);
      if (!horizontal) {
        const prefix = orientation === "container" ? "@xl/rail:" : "sm:";
        const [first, second] = arrows;
        expect(first.classList.contains(`${prefix}${label ? "hidden" : "flex"}`)).toBe(true);
        expect(second.classList.contains(`${prefix}${label ? "flex" : "hidden"}`)).toBe(true);
        expect(root.classList.contains("@xl/rail:mt-1")).toBe(orientation === "container" && !label);
      }
      if (label) {
        const text = children.find((child) => child.tagName === "SPAN")!;
        expect(text.textContent).toBe(label);
        expect(text.classList.contains("font-mono")).toBe(label === "≤ 24");
        expect(text.classList.contains("uppercase")).toBe(label === "≤ 24");
        expect(text.classList.contains("font-medium")).toBe(label === "Same day");
      }
    }
  });
});
