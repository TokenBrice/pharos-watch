import { describe, expect, it } from "vitest";

import {
  projectCoin,
  readCanonicalClientFields,
} from "../build-data/build-client-registry.mjs";
import { STABLECOIN_CLIENT_META_FIELDS } from "../../shared/types/stablecoin-client-meta";

describe("client registry field contract", () => {
  it("reads the canonical ordered field list from the shared TypeScript contract", () => {
    expect(readCanonicalClientFields()).toEqual([...STABLECOIN_CLIENT_META_FIELDS]);
  });

  it("projects client registry fields in canonical order", () => {
    const coin = {
      id: "usdc-circle",
      name: "USDC",
      symbol: "USDC",
      oneLiner: "A dollar-backed stablecoin.",
      flags: {
        pegCurrency: "USD",
        backing: "fiat",
        governance: "centralized",
      },
      pegMechanism: "fiat-backed",
      mechanismArchetype: "fiat-backed",
      archetypeOverride: false,
      geckoId: "usd-coin",
      protocolSlug: "circle",
      variantOf: null,
      variantKind: null,
      status: "active",
      tags: ["major"],
      frozenAt: null,
      launchDate: "2018-09-26",
      announcedDate: "2018-05-15",
      expectedLaunchDate: null,
      launchPhase: "live",
      milestones: [],
      dateHistory: [],
      canBeBlacklisted: true,
      canBeBlacklistedSource: "issuer docs",
      commodityOunces: null,
      infrastructures: ["circle"],
      mica: null,
      yieldConfig: null,
      liveReservesConfig: null,
      proofOfReserves: null,
      reserves: [{ asset: "cash" }],
      collateral: "cash",
      collateralQuality: "rwa",
    };

    expect(Object.keys(projectCoin(coin, readCanonicalClientFields()))).toEqual([
      ...STABLECOIN_CLIENT_META_FIELDS,
    ]);
  });
});
