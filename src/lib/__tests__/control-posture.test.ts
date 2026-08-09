import { describe, expect, it } from "vitest";
import { buildControlPostureView } from "@/lib/control-posture";
import type { StablecoinMeta } from "@shared/types";

function makeCoin(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id: "test-coin",
    name: "Test Coin",
    symbol: "TST",
    llamaId: "1",
    flags: {
      pegCurrency: "USD",
      governance: "centralized",
      backing: "rwa-backed",
      yieldBearing: false,
      rwa: true,
      navToken: false,
    },
    ...overrides,
  } as StablecoinMeta;
}

describe("buildControlPostureView", () => {
  it("returns null when control posture metadata is absent", () => {
    expect(buildControlPostureView(makeCoin())).toBeNull();
  });

  it("projects a descriptive regulated-entity posture", () => {
    const view = buildControlPostureView(makeCoin({ governanceQuality: "regulated-entity" }));

    expect(view).toMatchObject({
      key: "regulated-entity",
      label: "Regulated entity",
      shortLabel: "Regulated",
      scope: "LOCAL",
    });
    expect(view?.facts).toEqual([
      { key: "posture", label: "Posture", value: "Regulated entity" },
      { key: "taxonomy", label: "Taxonomy", value: "CEFI" },
      { key: "scope", label: "Scope", value: "LOCAL" },
      { key: "scoring-role", label: "Scoring role", value: "DESCRIPTIVE" },
    ]);
    expect(view?.summary).toContain("This classification is descriptive");
    expect(view?.details.join(" ")).toContain("not a Safety Score input");
  });

  it("marks wrapper variants as inherited and names the parent", () => {
    const view = buildControlPostureView(
      makeCoin({ governanceQuality: "wrapper", variantOf: "parent-coin" }),
      { id: "parent-coin", name: "Parent Coin", symbol: "PAR" },
    );

    expect(view?.scope).toBe("INHERITED");
    expect(view?.details.join(" ")).toContain("Parent Coin (PAR)");
    expect(view?.details.join(" ")).toContain("inherited from that parent relationship");
  });

  it("keeps non-wrapper variants local and surfaces the distinction", () => {
    const view = buildControlPostureView(
      makeCoin({ governanceQuality: "dao-governance", variantOf: "parent-coin" }),
      { id: "parent-coin", name: "Parent Coin", symbol: "PAR" },
    );

    expect(view?.scope).toBe("LOCAL");
    expect(view?.details.join(" ")).toContain("authored as local control");
  });

  it("distinguishes standalone wrapper records from tracked variants", () => {
    const view = buildControlPostureView(makeCoin({ governanceQuality: "wrapper" }));

    expect(view?.scope).toBe("WRAPPER");
    expect(view?.details.join(" ")).toContain("does not declare a tracked parent");
  });
});
