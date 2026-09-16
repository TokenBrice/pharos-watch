// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnnotationDensityStrip } from "@/components/chart-primitives/annotations";
import type { ChartAnnotation } from "@shared/types/chart-annotation";

const annotation: ChartAnnotation = {
  ts: Date.parse("2026-01-01T00:30:00Z"),
  kind: "depeg",
  label: "New-year event",
};

describe("AnnotationDensityStrip UTC bins", () => {
  it("labels a quarter tooltip with the UTC month that starts the bin", () => {
    const { container } = render(
      <AnnotationDensityStrip
        annotations={[annotation]}
        domain={[Date.UTC(2026, 0, 1), Date.UTC(2026, 3, 1)]}
        width={300}
      />,
    );

    expect(container.querySelector("title")?.textContent).toBe("1 event · Jan 2026");
  });
});
