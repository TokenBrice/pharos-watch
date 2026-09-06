import { describe, expect, it } from "vitest";
import { REDEMPTION_BACKSTOP_CONFIGS } from "../redemption-backstop-configs";

describe("queue-redeem Nest NAV vault configs", () => {
  it("preserves the golden queued-NAV configuration family", () => {
    const nestNavVaultIds = ["ntbill-nest", "nbasis-nest", "nopal-nest", "nwisdom-nest"] as const;
    const configs = Object.fromEntries(
      nestNavVaultIds.map((stablecoinId) => [stablecoinId, REDEMPTION_BACKSTOP_CONFIGS[stablecoinId]]),
    );

    expect(configs).toEqual({
      "ntbill-nest": {
        routeFamily: "queue-redeem",
        accessModel: "issuer-api",
        settlementModel: "days",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-basket",
        capacityModel: { kind: "supply-full", confidence: "documented-bound" },
        costModel: {
          kind: "dynamic-or-unclear",
          feeDescription:
            "Nest docs describe nTBILL redemptions through the Nest app; public materials reviewed do not publish one fixed redemption fee",
          confidence: "undisclosed-reviewed",
          feeModelKind: "undisclosed-reviewed",
        },
        reviewedAt: "2026-07-15",
        docs: [
          {
            label: "Nest available vaults",
            url: "https://docs.nest.credit/about/available-vaults",
            supports: ["route", "capacity", "fees", "access", "settlement"],
          },
        ],
        outputAssets: ["usdc-circle", "pusd-plume"],
        notes: ["Nest's current vault directory lists a nTBILL redemption estimate of 4 days."],
      },
      "nbasis-nest": {
        routeFamily: "queue-redeem",
        accessModel: "issuer-api",
        settlementModel: "days",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-basket",
        capacityModel: { kind: "supply-full", confidence: "documented-bound" },
        costModel: {
          kind: "dynamic-or-unclear",
          feeDescription:
            "Nest docs describe nBASIS redemptions through the Nest app; public materials reviewed do not publish one fixed redemption fee",
          confidence: "undisclosed-reviewed",
          feeModelKind: "undisclosed-reviewed",
        },
        reviewedAt: "2026-07-15",
        docs: [
          {
            label: "Nest available vaults",
            url: "https://docs.nest.credit/about/available-vaults",
            supports: ["route", "capacity", "fees", "access", "settlement"],
          },
        ],
        outputAssets: ["usdc-circle", "pusd-plume"],
        notes: ["Nest's current vault directory lists a nBASIS redemption estimate of 4 days."],
      },
      "nopal-nest": {
        routeFamily: "queue-redeem",
        accessModel: "issuer-api",
        settlementModel: "days",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-basket",
        capacityModel: { kind: "supply-full", confidence: "documented-bound" },
        costModel: {
          kind: "dynamic-or-unclear",
          feeDescription:
            "Nest docs describe nOPAL redemptions through the Nest app; public materials reviewed do not publish one fixed redemption fee",
          confidence: "undisclosed-reviewed",
          feeModelKind: "undisclosed-reviewed",
        },
        reviewedAt: "2026-07-15",
        docs: [
          {
            label: "Nest available vaults",
            url: "https://docs.nest.credit/about/available-vaults",
            supports: ["route", "capacity", "fees", "access", "settlement"],
          },
        ],
        outputAssets: ["usdc-circle", "pusd-plume", "usdt-tether"],
        notes: ["Nest's current vault directory lists a nOPAL redemption estimate of 4 days."],
      },
      "nwisdom-nest": {
        routeFamily: "queue-redeem",
        accessModel: "issuer-api",
        settlementModel: "days",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-basket",
        capacityModel: { kind: "supply-full", confidence: "documented-bound" },
        costModel: {
          kind: "dynamic-or-unclear",
          feeDescription:
            "Nest docs describe nWISDOM redemptions through the Nest app; public materials reviewed do not publish one fixed redemption fee",
          confidence: "undisclosed-reviewed",
          feeModelKind: "undisclosed-reviewed",
        },
        reviewedAt: "2026-07-15",
        docs: [
          {
            label: "Nest available vaults",
            url: "https://docs.nest.credit/about/available-vaults",
            supports: ["route", "capacity", "fees", "access", "settlement"],
          },
        ],
        outputAssets: ["usdc-circle", "pusd-plume"],
        notes: ["Nest's current vault directory lists a nWISDOM redemption estimate of 4 days."],
      },
    });
  });
});
