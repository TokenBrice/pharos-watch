import { describe, expect, it } from "vitest";
import { detailItemsFromParts, joinReportCardDetail, plural } from "../report-card-detail";

describe("report-card detail formatting", () => {
  it("joins plain value rows without a parenthesized detail", () => {
    expect(joinReportCardDetail([{ label: "Liquidity", value: "No DEX liquidity data" }])).toBe(
      "Liquidity: No DEX liquidity data",
    );
  });

  it("uses supplied detail as-is when it already includes the label", () => {
    expect(joinReportCardDetail([{ label: "Chain", value: "Stage 1", detail: "Chain: Stage 1 (-10)" }])).toBe(
      "Chain: Stage 1 (-10)",
    );
  });

  it("wraps supplemental detail when it differs from the value", () => {
    expect(joinReportCardDetail([{ label: "Collateral", value: "Low risk", detail: "75" }])).toBe(
      "Collateral: Low risk (75)",
    );
  });

  it("parses labeled parts using only the first separator", () => {
    expect(detailItemsFromParts(["Route: primary: issuer API"])).toEqual([
      { label: "Route", value: "primary: issuer API", detail: "Route: primary: issuer API" },
    ]);
  });

  it("falls back to a generic detail item when a separator is absent", () => {
    expect(detailItemsFromParts(["active depeg"])).toEqual([
      { label: "Detail", value: "active depeg", detail: "active depeg" },
    ]);
  });

  it("pluralizes report-card nouns without changing singular labels", () => {
    expect(plural(1, "pool")).toBe("1 pool");
    expect(plural(2, "pool")).toBe("2 pools");
  });
});
