import { describe, expect, it } from "vitest";
import { parseDimensionDetail } from "@/lib/report-card-parsing";

describe("parseDimensionDetail", () => {
  it("parses positive, negative, and zero sub-scores", () => {
    expect(parseDimensionDetail("Liquidity: deep DEX exit (12)")).toEqual({
      label: "Liquidity",
      desc: "deep DEX exit",
      subScore: 12,
      isNegative: false,
      displayScore: "+12",
    });
    expect(parseDimensionDetail("Dependency Risk: issuer dependency (-8)")).toEqual({
      label: "Dependency Risk",
      desc: "issuer dependency",
      subScore: -8,
      isNegative: true,
      displayScore: "-8",
    });
    expect(parseDimensionDetail("Governance: neutral controls (0)")).toEqual({
      label: "Governance",
      desc: "neutral controls",
      subScore: 0,
      isNegative: false,
      displayScore: "—",
    });
  });

  it("keeps colons and parentheses inside the description", () => {
    expect(parseDimensionDetail("Resilience: reserves (cash: tbills) via custodian: audited (4)")).toEqual({
      label: "Resilience",
      desc: "reserves (cash: tbills) via custodian: audited",
      subScore: 4,
      isNegative: false,
      displayScore: "+4",
    });
  });

  it("returns null for malformed or null-like detail strings", () => {
    expect(parseDimensionDetail("")).toBeNull();
    expect(parseDimensionDetail("Liquidity: no score")).toBeNull();
    expect(parseDimensionDetail("Liquidity (5)")).toBeNull();
    expect(parseDimensionDetail("Liquidity: invalid (+5)")).toBeNull();
  });
});
