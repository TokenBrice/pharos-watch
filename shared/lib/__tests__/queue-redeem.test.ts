import { describe, expect, it } from "vitest";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs";

describe("queue-redeem Nest NAV vault configs", () => {
  it.each([
    ["ntbill-nest", ["usdc-circle", "pusd-plume"]],
    ["nbasis-nest", ["usdc-circle", "pusd-plume"]],
    ["nopal-nest", ["usdc-circle", "pusd-plume", "usdt-tether"]],
    ["nwisdom-nest", ["usdc-circle", "pusd-plume"]],
  ] as const)("preserves queued NAV redemption and evidence for %s", (id, outputAssets) => {
    const config = REDEMPTION_BACKSTOP_CONFIGS[id];
    expect(config).toMatchObject({
      routeFamily: "queue-redeem",
      accessModel: "issuer-api",
      settlementModel: "days",
      executionModel: "rules-based-nav",
      outputAssetType: "stable-basket",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: {
        kind: "dynamic-or-unclear",
        confidence: "undisclosed-reviewed",
        feeModelKind: "undisclosed-reviewed",
      },
      outputAssets,
    });
    expect(config.costModel.feeDescription?.trim()).toBeTruthy();
    expect(config.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isFinite(Date.parse(config.reviewedAt!))).toBe(true);
    expect(config.docs).toBeDefined();
    expect(config.docs!.length).toBeGreaterThan(0);
    const supportedClaims = new Set(config.docs!.flatMap((doc) => doc.supports ?? []));
    for (const claim of ["route", "capacity", "fees", "access", "settlement"] as const) {
      expect(supportedClaims.has(claim)).toBe(true);
    }
    for (const doc of config.docs!) {
      expect(doc.label.trim()).not.toBe("");
      expect(new URL(doc.url).protocol).toBe("https:");
    }
  });
});
