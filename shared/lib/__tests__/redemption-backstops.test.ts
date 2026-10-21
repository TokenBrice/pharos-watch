import { describe, expect, it } from "vitest";
import { resolveCapacitySemantics } from "../redemption-backstop-confidence";
import { getRedemptionBackstopConfig, resolveV9RedemptionRouteCostBpsAtNotional } from "../redemption-backstops";
import { resolveDefaultHolderEligibility } from "../redemption-backstop-configs/shared";
import { REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS } from "../../data/coverage-dispositions/redemption-coverage-dispositions";

describe("getRedemptionBackstopConfig", () => {
  it.each([
    ["usdv-solomon-v2", "defer", "issuer-terms-missing", "https://raw.githubusercontent.com/SolomonLabs/chancery/main/spec/04_Settlement_Pathways_and_Permissions.md"],
    ["iusd-initia", "needs-research", "documentation-insufficient", "https://contents.initia.xyz/app/iusd-faq.json"],
    ["bnusd-balanced", "defer", "route-status-unverified", "https://raw.githubusercontent.com/icon-project/sodax-sdks/main/packages/sdk/docs/MIGRATION.md"],
  ])("keeps %s's opaque composite path unconfigured with its sourced unresolved disposition", (id, disposition, reasonCode, evidenceUrl) => {
    expect(getRedemptionBackstopConfig(id)).toBeNull();
    const review = REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS.filter((row) => row.id === id);
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ disposition, reasonCode, reviewedDate: "2026-10-11" });
    expect(review[0]!.evidenceUrls).toContain(evidenceUrl);
    expect(review[0]!.evidenceNeeded).toMatch(/capacity|liquidity/);
    expect(review[0]!.evidenceNeeded).toMatch(/fees|deductions/);
    expect(review[0]!.evidenceNeeded).toMatch(/settlement|completion/);
  });

  it.each([
    ["mantrausd-mantra", "issuer-api", "whitelisted-primary"],
    ["usdm-moneta", "manual", "whitelisted-primary"],
  ] as const)("keeps %s documentary access separate from executable capacity and complete costs", (id, access, eligibility) => {
    const config = getRedemptionBackstopConfig(id)!;
    expect(config.accessModel).toBe(access);
    expect(config.holderEligibility).toBe(eligibility);
    expect(config.capacityModel).toEqual({ kind: "unquantified" });
    expect(config.v9RouteReviewTerms?.scoringDisposition).toBe("bounded-terms-gap");
    expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(expect.arrayContaining(["capacity", "cost", "settlement"]));
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    expect(config.v9RouteReviewTerms?.businessDayTerms).toBeUndefined();
    for (const notional of [1_000, 1_000_000, 25_000_000]) {
      expect(resolveV9RedemptionRouteCostBpsAtNotional(config, notional)).toBeNull();
    }
  });

  it.each([
    ["spusd-soulpeg", "asset:susdc-soulpeg"],
  ])("does not relabel %s's untracked receipt or successor as a priced stablecoin", (id, output) => {
    const config = getRedemptionBackstopConfig(id)!;
    expect(config.outputAssets).toBeUndefined();
    expect(config.unresolvedOutputAssetKeys).toEqual([output]);
    expect(config.unresolvedOutputDisposition).toBe("reviewed-external");
    expect(config.capacityModel).toEqual({ kind: "unquantified" });
  });

  it("keeps SoulPeg atomic receipt conversion and zero protocol fee distinct from a USDC payout", () => {
    const config = getRedemptionBackstopConfig("spusd-soulpeg")!;
    expect(config.holderEligibility).toBe("any-holder");
    expect(config.settlementModel).toBe("atomic");
    expect(config.v9RouteReviewTerms).toMatchObject({ settlementDelaySec: 0, missingScoringFields: ["capacity"] });
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBe(0);
    expect(config.costModel).not.toHaveProperty("gasOrBridgeCostUsd");
  });

  it("keeps USDXL GSM capacity and mutable fee strategy unquantified", () => {
    const config = getRedemptionBackstopConfig("usdxl-last")!;
    expect(config.outputAssets).toEqual(["usdt-tether"]);
    expect(config.accessModel).toBe("permissionless-onchain");
    expect(config.holderEligibility).toBe("any-holder");
    expect(config.settlementModel).toBe("atomic");
    expect(config.executionModel).toBe("deterministic-onchain");
    expect(config.capacityModel).toEqual({ kind: "unquantified" });
    expect(config.costModel).toMatchObject({ kind: "dynamic-or-unclear", confidence: "formula" });
    expect(config.costModel).not.toHaveProperty("feeBpsMax");
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBeNull();
  });

  it("records ZARU legal entitlement as eventual-only with all executable terms withheld", () => {
    const config = getRedemptionBackstopConfig("zaru-blocktower")!;
    expect(config.capacityModel).toEqual({ kind: "supply-full", confidence: "documented-bound", basis: "issuer-term-redemption" });
    expect(resolveCapacitySemantics(config.capacityModel)).toBe("eventual-only");
    expect(config.holderEligibility).toBe("whitelisted-primary");
    expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(["capacity", "settlement", "cost"]);
    expect(config.outputAssets).toBeUndefined();
  });

  it("records only YieldFi's ordinary yUSD rail as suspended without renewing historical terms", () => {
    const config = getRedemptionBackstopConfig("yusd-yieldfi")!;
    expect(config.reviewedAt).toBe("2026-10-02");
    expect(config.routeStatus).toBe("suspended");
    expect(config.routeSuspension).toMatchObject({
      routeId: "redemption:yusd-yieldfi:stablecoin-redeem",
      suspendedAt: "2026-10-11", reviewedAt: "2026-10-11",
    });
    expect(config.routeSuspension?.sources[0]?.quote).toContain("Mint and Redeem operations for yUSD and vyUSD are paused");
  });

  it("preserves Moneta's issuer-only fee component and independent term-review clock", () => {
    const config = getRedemptionBackstopConfig("usdm-moneta")!;
    expect(config.reviewedAt).toBe("2026-10-11");
    expect(config.v9RouteReviewTerms?.reviewedAt).toBe("2026-10-09");
    expect(config.costModel.feeComponents).toEqual([{ currency: "USD", terms: { feeBps: 10, minAmount: 50, maxAmount: 5_000 } }]);
    expect(config.costModel).not.toHaveProperty("feeBpsMax");
  });

  it("retains USDB's original terms clock without treating current withdrawal instructions as an SLA", () => {
    const config = getRedemptionBackstopConfig("usdb-blast")!;
    expect(config.reviewedAt).toBe("2026-05-13");
    expect(config.outputAssets).toEqual(["dai-makerdao"]);
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    expect(config.docs?.some((doc) => doc.url === "https://docs.blast.io/withdrawals/usdb-from-contracts")).toBe(true);
    expect(config.notes?.some((note) => note.includes("recipient must itself call USDYieldManager.claimWithdrawal"))).toBe(true);
  });

  it("shares the Sky LitePSM capacity model across USDS and DAI", () => {
    const usds = getRedemptionBackstopConfig("usds-sky");
    const dai = getRedemptionBackstopConfig("dai-makerdao");

    expect(usds).not.toBeNull();
    expect(dai).not.toBeNull();
    expect(usds?.capacityModel).toEqual(dai?.capacityModel);
  });

  it.each(["frax-frax", "mai-qidao"])("keeps the explicitly unmodeled %s route absent", (id) => {
    expect(getRedemptionBackstopConfig(id)).toBeNull();
  });

  it("keeps Lido earnUSD queue terms without invented capacity, settlement or fee bounds", () => {
    const config = getRedemptionBackstopConfig("earnusd-lido");
    expect(config?.outputAssets).toEqual(["usdc-circle"]);
    expect(resolveCapacitySemantics(config!.capacityModel)).toBe("eventual-only");
    expect(config?.settlementModel).toBe("queued");
    expect(config?.v9RouteReviewTerms?.missingScoringFields).toEqual(["capacity", "settlement", "cost"]);
    expect(config?.v9RouteReviewTerms).not.toHaveProperty("settlementDelaySec");
    expect(config?.costModel).toMatchObject({ confidence: "formula", feeModelKind: "formula" });
    expect(config?.costModel).not.toHaveProperty("feeBps");
    expect(config?.costModel).not.toHaveProperty("feeBpsMax");
  });

  it.each([
    { id: "usdm-monetrix", missingScoringFields: ["capacity", "settlement"], protocolFeeBps: 0 },
    { id: "susdat-saturn", missingScoringFields: ["capacity", "settlement", "cost"], protocolFeeBps: null },
  ])(
    "keeps $id queue capacity and completion unproven while preserving reviewed protocol fees",
    ({ id, missingScoringFields, protocolFeeBps }) => {
      const config = getRedemptionBackstopConfig(id)!;
      expect(resolveCapacitySemantics(config.capacityModel)).toBe("eventual-only");
      expect(config.capacityModel).not.toHaveProperty("fallbackRatio");
      expect(config.capacityModel).not.toHaveProperty("ratio");
      expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(missingScoringFields);
      expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
      for (const notional of [1_000, 1_000_000, 25_000_000]) {
        expect(resolveV9RedemptionRouteCostBpsAtNotional(config, notional)).toBe(protocolFeeBps);
      }
      expect(config.costModel).not.toHaveProperty("feeBpsMax");
      expect(config.v9RouteCostTerms?.publishedFeeSchedule).toBeUndefined();
      if (id === "usdm-monetrix") {
        expect(config.costModel).toMatchObject({
          kind: "fee-bps", feeBps: 0, confidence: "fixed",
          feeDescription: expect.stringContaining("network gas separate"),
        });
      }
    },
  );

  it("does not turn migrated USDat backing into USDC redemption capacity or a cost bound", () => {
    const config = getRedemptionBackstopConfig("usdat-saturn")!;
    expect(resolveCapacitySemantics(config.capacityModel)).toBe("eventual-only");
    expect(config.outputAssets).toEqual(["usdc-circle"]);
    expect(config.accessModel).toBe("permissionless-onchain");
    expect(config.holderEligibility ?? resolveDefaultHolderEligibility(config)).toBe("unknown");
    expect(config.capacityModel).not.toHaveProperty("ratio");
    expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(["capacity", "settlement", "cost"]);
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBeNull();
  });

  it.each(["susdai-usd-ai", "reusd-re-protocol"])(
    "keeps %s variable pricing and conditional queue terms unbounded at every tested notional",
    (id) => {
      const config = getRedemptionBackstopConfig(id)!;
      expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(["cost", "settlement"]);
      expect(config.settlementModel).toBe("queued");
      expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
      for (const notional of [1_000, 1_000_000, 25_000_000]) {
        expect(resolveV9RedemptionRouteCostBpsAtNotional(config, notional)).toBeNull();
      }
    },
  );

  it("does not promote Maple FAQ timing into a guaranteed completion bound", () => {
    const config = getRedemptionBackstopConfig("syrupusdc-maple")!;
    expect(config.settlementModel).toBe("queued");
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    expect(config.v9RouteReviewTerms?.businessDayTerms).toBeUndefined();
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBe(0);
  });

  it("does not expose a cash redemption route for non-refundable JPYC Prepaid v1", () => {
    expect(getRedemptionBackstopConfig("jpyc-jpyc-v1")).toBeNull();
  });

  it("redeems the Curve savings wrapper into crvUSD rather than its market pool's other token", () => {
    expect(getRedemptionBackstopConfig("scrvusd-curve")?.outputAssets).toEqual(["crvusd-curve"]);
  });

  it("keeps Apyx USDC output separate from its unproven settlement bound", () => {
    const config = getRedemptionBackstopConfig("apxusd-apyx");

    expect(config?.outputAssetType).toBe("stable-single");
    expect(config?.outputAssets).toEqual(["usdc-circle"]);
    expect(config?.executionModel).toBe("rules-based-nav");
    expect(config?.v9RouteReviewTerms).toMatchObject({
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["settlement", "cost"],
    });
  });

  it("retires JuiceDollar's operational route without treating shutdown as a live suspended channel", () => {
    expect(getRedemptionBackstopConfig("jusd-juicedollar")).toBeNull();
  });

  it("leaves eEARN withdrawal costs unavailable until an admitted validator quote arrives", () => {
    const config = getRedemptionBackstopConfig("eearn-ember")!;
    expect(config.v9RouteReviewTerms?.settlementModel).toBe("queued");
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    for (const notional of [1_000, 1_000_000, 25_000_000]) {
      expect(resolveV9RedemptionRouteCostBpsAtNotional(config, notional)).toBeNull();
      expect(resolveV9RedemptionRouteCostBpsAtNotional(config, notional, 5)).toBe(5);
      expect(resolveV9RedemptionRouteCostBpsAtNotional(config, notional, 0)).toBe(0);
    }
  });

  it.each([
    ["apxusd-apyx", "usdc-circle"],
    ["usx-solstice", "usdg-paxos"],
    ["usda-avalon", "usdt-tether"],
  ])("does not invent a %s cost ceiling from payout identity or processing terms", (id, output) => {
    const config = getRedemptionBackstopConfig(id)!;
    expect(config.outputAssets).toEqual([output]);
    for (const notional of [1_000, 1_000_000, 25_000_000]) {
      expect(resolveV9RedemptionRouteCostBpsAtNotional(config, notional)).toBeNull();
    }
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    if (id !== "usx-solstice") {
      expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(expect.arrayContaining(["cost", "settlement"]));
    }
  });

  it.each(["frxusd-frax", "sfrxusd-frax", "usdz-anzen"])(
    "keeps %s public mutable fee formulas separate from numeric all-in costs",
    (id) => {
      const config = getRedemptionBackstopConfig(id);
      expect(config?.costModel).toMatchObject({
        kind: "dynamic-or-unclear",
        confidence: "formula",
        feeModelKind: "formula",
      });
      expect(config?.costModel).not.toHaveProperty("feeBps");
      expect(config?.costModel).not.toHaveProperty("feeBpsMax");
      expect(config?.v9RouteCostTerms).toBeUndefined();
      expect(config?.capacityModel).toMatchObject({ kind: "reserve-sync-metadata" });
    },
  );

  it("keeps syrupUSDG's zero native fee separate from unbounded queue completion", () => {
    const config = getRedemptionBackstopConfig("syrupusdg-maple");
    expect(config?.costModel).toMatchObject({ kind: "fee-bps", feeBps: 0, confidence: "fixed" });
    expect(config?.costModel.feeDescription).toContain("gas, wallet and third-party charges");
    expect(config?.v9RouteReviewTerms).toMatchObject({
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement"],
    });
    expect(config?.v9RouteReviewTerms).not.toHaveProperty("settlementDelaySec");
    expect(config?.outputAssets).toEqual(["usdg-paxos"]);
    expect(config?.capacityModel).toEqual({ kind: "reserve-sync-metadata" });
  });

  it("records ACRDX's issuer-only zero without changing queued NAV redemption", () => {
    const config = getRedemptionBackstopConfig("acrdx-anemoy-apollo");
    expect(config?.costModel).toMatchObject({ kind: "fee-bps", feeBps: 0, confidence: "fixed" });
    expect(config?.costModel.feeDescription).toContain("issuer entry/exit fee only");
    expect(config?.settlementModel).toBe("queued");
    expect(config?.outputAssetType).toBe("nav");
    expect(config?.docs).toContainEqual(expect.objectContaining({
      url: "https://centrifuge-files.mypinata.cloud/ipfs/bafkreigpp4zkwecojcuipjnzyclrfgzaqe6tu5vedvujw6u73c3xfwbx5m",
      supports: ["route", "fees"],
    }));
  });

  it.each([
    ["tryb-bilira", "bank-transfer leg"],
    ["avusd-avant", "0.05% (5 bps)"],
  ])("keeps %s partial fee disclosures without a route-wide numerical ceiling", (id, disclosure) => {
    const config = getRedemptionBackstopConfig(id);
    expect(config?.costModel).toMatchObject({
      kind: "dynamic-or-unclear",
      feeModelKind: "documented-variable",
    });
    expect(config?.costModel.feeDescription).toContain(disclosure);
    expect(config?.costModel).not.toHaveProperty("feeBps");
    expect(config?.costModel).not.toHaveProperty("feeBpsMax");
    expect(config?.v9RouteCostTerms).toBeUndefined();
  });

  it("keeps UTY's verified Base USDC payout separate from unbounded redemption terms", () => {
    const config = getRedemptionBackstopConfig("uty-xsy");

    expect(config?.outputAssetType).toBe("stable-single");
    expect(config?.outputAssets).toEqual(["usdc-circle"]);
    expect(config?.unresolvedOutputAssetKeys).toBeUndefined();
    expect(config?.v9RouteReviewTerms).toMatchObject({
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
    });
  });


  it("retains Indigo's complete three-choice PSM payout census without valuing its untracked USDr branch", () => {
    const config = getRedemptionBackstopConfig("iusd-indigo-protocol");
    expect(config?.outputAssets).toBeUndefined();
    expect(config?.unresolvedOutputDisposition).toBe("reviewed-external");
    expect(config?.unresolvedOutputAssetKeys).toEqual([
      "usdm-moneta",
      "usdc-circle",
      "asset:cardano:7d9e4a0ee1a3f5d5ff8159ea91a83310cf2795ee7a87170c7aea05ae.55534472",
    ]);
    expect(config?.unresolvedOutputAssetKeys).not.toContain("usda-anzens");
  });

  it.each([
    ["stkgho-umbrella-aave", "immediate-bounded"],
    ["usdrif-rif", "eventual-only"],
    ["susd1plus-lorenzo", "eventual-only"],
    ["witry-brix", "eventual-only"],
  ] as const)("resolves %s capacity as %s", (id, expected) => {
    const config = getRedemptionBackstopConfig(id);
    expect(config).not.toBeNull();
    expect(resolveCapacitySemantics(config!.capacityModel)).toBe(expected);
  });

  it.each([
    "hyusd-hylo",
    "dusd-dtrinity",
    "u-united-stables",
    "silk-shade-protocol",
    "satusd-river",
    "witry-brix",
    "dllr-sovryn",
    "deuro-deuro",
    "nect-beraborrow",
  ])("withholds unresolved output assets for %s", (id) => {
    const config = getRedemptionBackstopConfig(id);
    expect(config).not.toBeNull();
    expect(config?.outputAssets).toBeUndefined();
  });
});
