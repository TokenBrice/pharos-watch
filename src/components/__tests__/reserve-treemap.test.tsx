import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReserveTreemap } from "@/components/reserve-treemap";
import { RESERVE_RISK_PRESENTATION } from "@shared/lib/classification/reserve-risk";
import type { ReserveSlice } from "@shared/types";

const SLICE = (name: string, pct: number, risk: ReserveSlice["risk"]): ReserveSlice => ({ name, pct, risk });

describe("ReserveTreemap", () => {
  it("renders a thin basket in the treemap frame", () => {
    const html = renderToStaticMarkup(
      <ReserveTreemap reserves={[SLICE("USD deposits & T-bills", 100, "very-low")]} />,
    );
    expect(html).toContain("Reserve composition treemap: USD deposits &amp; T-bills 100%");
    expect(html).toContain("aspect-[6/5]");
    expect(html).toContain("pharos-chart-stage");
  });

  it("keys the risk legend even when the basket carries a single tier", () => {
    const single = renderToStaticMarkup(
      <ReserveTreemap reserves={[SLICE("Cash", 60, "very-low"), SLICE("T-bills", 40, "very-low")]} />,
    );
    expect(single).toContain("Very Low Risk");
    expect(single.match(/rounded-\[2px\]/g)).toHaveLength(1);
  });

  it("keys only the tiers present in the basket, right-aligned on the title row", () => {
    const html = renderToStaticMarkup(
      <ReserveTreemap
        reserves={[
          SLICE("T-bills", 50, "very-low"),
          SLICE("Repo", 30, "medium"),
          SLICE("Private credit", 20, "high"),
        ]}
      />,
    );
    expect(html).toContain("Very Low Risk");
    expect(html).toContain("Medium Risk");
    expect(html).toContain("High Risk");
    expect(html).not.toContain("Very High Risk");
    // Delimited: a naive "Low Risk" substring also matches "Very Low Risk".
    expect(html).not.toContain(">Low Risk<");
    expect(html.match(/rounded-\[2px\]/g)).toHaveLength(3);
    expect(html).toContain("justify-end");
  });

  it("reads compact and standalone reserve-risk labels from the shared classification owner", () => {
    expect(RESERVE_RISK_PRESENTATION["very-low"]).toEqual({
      shortLabel: "Very low",
      longLabel: "Very Low Risk",
    });
  });
});
