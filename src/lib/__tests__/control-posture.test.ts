import { describe, expect, it } from "vitest";
import { buildControlPostureView, type ControlPostureView } from "@/lib/control-posture";
import { CONTROL_POSTURE_STYLES } from "@shared/lib/classification";
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

const PARENT = { id: "parent-coin", name: "Parent Coin", symbol: "PAR" };

function readerText(view: ControlPostureView | null): string {
  return [view?.summary, ...(view?.details ?? []), ...(view?.facts ?? []).map((fact) => fact.value)].join(" ");
}

describe("buildControlPostureView", () => {
  it("returns null when control posture metadata is absent", () => {
    expect(buildControlPostureView(makeCoin())).toBeNull();
  });

  it("projects the classified posture with local scope", () => {
    const view = buildControlPostureView(makeCoin({ governanceQuality: "regulated-entity" }));

    expect(view).toMatchObject({
      key: "regulated-entity",
      label: CONTROL_POSTURE_STYLES["regulated-entity"].label,
      scope: "LOCAL",
    });
    expect(view?.facts.map((fact) => fact.key)).toEqual(["posture", "taxonomy", "scope", "scoring-role"]);
  });

  it("marks wrapper variants as inherited and names the parent", () => {
    const view = buildControlPostureView(
      makeCoin({ governanceQuality: "wrapper", variantOf: "parent-coin" }),
      PARENT,
    );

    expect(view?.scope).toBe("INHERITED");
    expect(view?.details.join(" ")).toContain("Parent Coin (PAR)");
  });

  it("keeps non-wrapper variants local", () => {
    const view = buildControlPostureView(
      makeCoin({ governanceQuality: "dao-governance", variantOf: "parent-coin" }),
      PARENT,
    );

    expect(view?.scope).toBe("LOCAL");
    expect(view?.details.join(" ")).toContain("Parent Coin (PAR)");
  });

  it("distinguishes standalone wrapper records from tracked variants", () => {
    expect(buildControlPostureView(makeCoin({ governanceQuality: "wrapper" }))?.scope).toBe("WRAPPER");
  });

  it("never shows readers internal field names, version pins or raw ids", () => {
    const views = [
      buildControlPostureView(makeCoin({ governanceQuality: "multisig" })),
      buildControlPostureView(makeCoin({ governanceQuality: "wrapper" })),
      buildControlPostureView(makeCoin({ governanceQuality: "wrapper", variantOf: "parent-coin" })),
      buildControlPostureView(makeCoin({ governanceQuality: "dao-governance", variantOf: "parent-coin" }), PARENT),
    ];
    for (const view of views) {
      const text = readerText(view);
      expect(text).not.toMatch(/flags\.|variantOf|\bV\d+\b|parent-coin|\b(LOCAL|INHERITED|WRAPPER|DESCRIPTIVE)\b/);
    }
  });
});
