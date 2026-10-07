import { describe, expect, it } from "vitest";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { buildFailureDomainsView, describeFailureDomain } from "../failure-domains";

function cardWithDeploymentRisk(
  trace: Partial<{
    totalAdjustmentPoints: number | null;
    adjustments: unknown[];
    unresolvedExposures: unknown[];
  }>,
) {
  const base = makeV9Card();
  return {
    ...base,
    scoreTrace: {
      ...base.scoreTrace,
      deploymentRisk: {
        method: "holder-slice-exposure-weighted-v2" as const,
        totalAdjustmentPoints: 0,
        adjustments: [],
        unresolvedExposures: [],
        ...trace,
      },
    },
  } as ReturnType<typeof makeV9Card>;
}

function adjustment(overrides: Record<string, unknown> = {}) {
  return {
    signalKey: "signal:a",
    sourceSignalKeys: ["signal:a"],
    exposureKey: "deployment-slice:arbitrum:0xabc",
    riskEventKey: "deployment-event:common-mode",
    failureDomainKey: "bridge-route:protocol:layerzero-v2",
    nominalExposureShare: 0.34,
    exposureShare: 0.34,
    exposedScore: 64,
    scoreBefore: 30,
    scoreAfter: 30,
    adjustmentPoints: 0,
    modeledLossPoints: 0,
    reason: "This asset's own reviewed share is 33.7% at bridge-route:protocol:layerzero-v2.",
    ...overrides,
  };
}

describe("describeFailureDomain", () => {
  it("resolves a chain key through the shared chain registry", () => {
    expect(describeFailureDomain("chain:celo")).toEqual({ label: "Celo", kind: "chain" });
    expect(describeFailureDomain("chain:base")).toEqual({ label: "Base", kind: "chain" });
  });

  it("labels known bridge protocols", () => {
    expect(describeFailureDomain("bridge-route:protocol:layerzero-v2").label).toBe("LayerZero V2");
    expect(describeFailureDomain("bridge-route:protocol:chainlink-ccip").label).toBe("Chainlink CCIP");
  });

  it("prefers the embedded protocol over a raw contract address in a compound key", () => {
    const key =
      "bridge-route:contract:avalanche:0xba51+bridge-route:protocol:layerzero-v2";
    expect(describeFailureDomain(key)).toEqual({ label: "LayerZero V2", kind: "bridge" });
  });

  it("falls back to the routing chain when a contract key carries no protocol", () => {
    expect(describeFailureDomain("bridge-route:contract:base:0xec35").label).toBe("Bridge contract on Base");
  });

  it("never leaks a raw address into a label", () => {
    for (const key of [
      "bridge-route:contract:base:0xec3582fcdc34078a4b7a8c75a5a3ae46f48525ab",
      "bridge-route:authority:solana:3JiU6sJt94WcD6r7EFTUnJo6By9DJ9WJxovRGfY9oseb",
    ]) {
      expect(describeFailureDomain(key).label).not.toMatch(/0x[a-f0-9]{6}|[A-Za-z0-9]{20,}/);
    }
  });

  it("cases protocol slugs by their brand, not by title case", () => {
    expect(describeFailureDomain("bridge-route:protocol:layerzero-oft").label).toBe("LayerZero OFT");
    expect(describeFailureDomain("bridge-route:protocol:layerzero-oft-v2").label).toBe("LayerZero OFT V2");
  });
});

describe("buildFailureDomainsView", () => {
  it("publishes nominal exposure rather than the capped scoring contribution", () => {
    const view = buildFailureDomainsView(cardWithDeploymentRisk({
      adjustments: [adjustment({ nominalExposureShare: 0.9097, exposureShare: 0.5 })],
    }));
    expect(view!.rows[0]!.share).toEqual({ status: "quantified", exposureShare: 0.9097, modeledExposureShare: 0.5 });
    expect(view!.rows[0]!.members[0]).toMatchObject({ exposureShare: 0.9097, modeledExposureShare: 0.5 });
  });

  it("hides itself when the asset has no shared domains", () => {
    expect(buildFailureDomainsView(makeV9Card())).toBeNull();
    expect(buildFailureDomainsView(null)).toBeNull();
  });

  it("keeps a zero-point domain — no penalty is not no exposure", () => {
    const view = buildFailureDomainsView(cardWithDeploymentRisk({ adjustments: [adjustment()] }));
    expect(view?.rows).toHaveLength(1);
    expect(view?.rows[0]?.adjustmentPoints).toBe(0);
    expect(view?.rows[0]?.share).toMatchObject({ status: "quantified" });
    expect(view?.rows[0]?.share.status === "quantified" && view.rows[0].share.exposureShare).toBeCloseTo(0.34, 6);
    expect(view?.rows[0]?.members[0]).toMatchObject({ resolved: true, adjustmentPoints: 0 });
  });

  it("sorts scoring domains above larger but costless exposures", () => {
    const view = buildFailureDomainsView(
      cardWithDeploymentRisk({
        adjustments: [
          adjustment({ failureDomainKey: "chain:celo", exposureShare: 0.9, adjustmentPoints: 0 }),
          adjustment({
            exposureKey: "deployment-slice:base:0xdef",
            failureDomainKey: "bridge-route:protocol:wormhole-ntt",
            exposureShare: 0.1,
            scoreBefore: 30,
            scoreAfter: 27.5,
            adjustmentPoints: 2.5,
            modeledLossPoints: 2.5,
          }),
        ],
      }),
    );
    expect(view?.rows.map((row) => row.label)).toEqual(["Wormhole NTT", "Celo"]);
  });

  it("carries unresolved exposures last and marks them unquantified", () => {
    const view = buildFailureDomainsView(
      cardWithDeploymentRisk({
        adjustments: [adjustment()],
        unresolvedExposures: [
          {
            signalKey: "signal:u",
            exposureKey: "deployment-slice:base:0x94",
            riskEventKey: "deployment-event:common-mode",
            failureDomainKeys: ["bridge-route:contract:base:0xec35"],
            economicLossScope: "deployment",
            exposedScore: 64,
            exposureShare: null,
            reason: "2 reviewed paths share this bridge contract.",
          },
        ],
      }),
    );
    const last = view?.rows.at(-1);
    expect(last?.share).toEqual({ status: "unquantified", unquantifiedMemberCount: 1 });
    expect(last?.members).toEqual([
      expect.objectContaining({ resolved: false, exposureShare: null, modeledExposureShare: null, adjustmentPoints: null }),
    ]);
    expect(last?.members[0]?.reason).toMatch(/bridge contract/);
  });

  // USDe shape from the live card: two LayerZero deployment slices plus the
  // protocol-wide common-mode slice, which the engine could not quantify.
  const plasmaSlice = adjustment({
    exposureKey: "deployment-slice:plasma:0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
    failureDomainKey:
      "bridge-route:contract:ethereum:0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34+bridge-route:contract:plasma:0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34+bridge-route:protocol:layerzero-v2",
    nominalExposureShare: 0.108,
    exposureShare: 0.108,
    reason: "Bridge control topology is external-lock-mint.",
  });
  const solanaSlice = adjustment({
    exposureKey: "deployment-slice:solana:DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT",
    failureDomainKey:
      "bridge-route:contract:ethereum:0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34+bridge-route:contract:solana:4x3oQtX4MhjTKGBeXDZbtTSLZ9cUWo5waN2UChAuthtS+bridge-route:protocol:layerzero-v2",
    nominalExposureShare: 0.103,
    exposureShare: 0.103,
    reason: "Bridge control topology is external-lock-mint.",
  });
  const protocolWide = {
    signalKey: "signal:lz",
    exposureKey: "common-mode-slice:usde-ethena:bridge-route:protocol:layerzero-v2",
    riskEventKey: "deployment-event:common-mode:bridge-route:protocol:layerzero-v2",
    failureDomainKeys: ["bridge-route:protocol:layerzero-v2"],
    economicLossScope: "deployment",
    exposedScore: 64,
    exposureShare: null,
    reason: "214 reviewed paths across 32 assets share bridge-route:protocol:layerzero-v2; unknown/unattributed bridge exposure.",
  };

  it("groups entries that resolve to one label without dropping any member's share or reason", () => {
    const view = buildFailureDomainsView(cardWithDeploymentRisk({
      adjustments: [plasmaSlice, solanaSlice],
      unresolvedExposures: [protocolWide],
    }));
    expect(view?.rows).toHaveLength(1);
    const row = view!.rows[0]!;
    expect(row.label).toBe("LayerZero V2");
    // Published order: resolved adjustments, then unresolved exposures.
    expect(row.members.map((member) => [member.label, member.exposureShare, member.resolved])).toEqual([
      ["Plasma", 0.108, true],
      ["Solana", 0.103, true],
      ["Domain-wide", null, false],
    ]);
    expect(new Set(row.members.map((member) => member.key)).size).toBe(3);
    for (const member of row.members) expect(member.reason).toBeTruthy();
    expect(row.members[2]?.reason).toMatch(/214 reviewed paths/);

    // The known members bound the share from below; the unquantified one is counted, not zeroed.
    expect(row.share).toMatchObject({ status: "partial", unquantifiedMemberCount: 1 });
    expect(row.share.status === "partial" && row.share.knownShareLowerBound).toBeCloseTo(0.211, 6);
    expect(row.span).toEqual({
      chainIds: [],
      routeKeys: [
        "plasma:0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
        "solana:DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT",
      ],
      protocolKeys: ["layerzero-v2"],
    });
  });

  it("ranks a partly quantified domain by its known share, above a wholly unquantified one", () => {
    const view = buildFailureDomainsView(cardWithDeploymentRisk({
      adjustments: [plasmaSlice, solanaSlice, adjustment({ failureDomainKey: "chain:celo", nominalExposureShare: 0.05, exposureShare: 0.05 })],
      unresolvedExposures: [
        protocolWide,
        { ...protocolWide, signalKey: "signal:base", exposureKey: "deployment-slice:base:0x94", failureDomainKeys: ["bridge-route:contract:base:0xec35"] },
      ],
    }));
    expect(view?.rows.map((row) => row.label)).toEqual(["LayerZero V2", "Celo", "Bridge contract on Base"]);
  });

  it("numbers members that would otherwise read the same", () => {
    const view = buildFailureDomainsView(cardWithDeploymentRisk({
      adjustments: [
        adjustment({ exposureKey: "deployment-slice:base:0x1" }),
        adjustment({ exposureKey: "deployment-slice:base:0x2" }),
      ],
    }));
    expect(view?.rows[0]?.members.map((member) => member.label)).toEqual(["Base (1)", "Base (2)"]);
  });

  it("adds distinct deployment slices but never double counts overlapping supply", () => {
    const disjoint = buildFailureDomainsView(cardWithDeploymentRisk({ adjustments: [plasmaSlice, solanaSlice] }));
    expect(disjoint?.rows[0]?.share).toMatchObject({ status: "quantified" });
    expect(disjoint?.rows[0]?.share.status === "quantified" && disjoint.rows[0].share.exposureShare).toBeCloseTo(0.211, 6);

    // A protocol common-mode slice already covers the deployment routed through it.
    const overlapping = buildFailureDomainsView(cardWithDeploymentRisk({
      adjustments: [
        adjustment({ exposureKey: "common-mode-slice:a:bridge-route:protocol:layerzero-v2", nominalExposureShare: 0.15, exposureShare: 0.12 }),
        adjustment({ ...plasmaSlice, nominalExposureShare: 0.15, exposureShare: 0.12 }),
      ],
    }));
    const row = overlapping!.rows[0]!;
    expect(row.members.map((member) => member.exposureShare)).toEqual([0.15, 0.15]);
    expect(row.share.status).toBe("quantified");
    if (row.share.status !== "quantified") return;
    expect(row.share.exposureShare).toBeCloseTo(0.15, 6);
    expect(row.share.modeledExposureShare).toBeCloseTo(0.12, 6);

    // The same overlap with an unquantified sibling: the lower bound follows the same rule.
    const partial = buildFailureDomainsView(cardWithDeploymentRisk({
      adjustments: [
        adjustment({ exposureKey: "common-mode-slice:a:bridge-route:protocol:layerzero-v2", nominalExposureShare: 0.15, exposureShare: 0.12 }),
        adjustment({ ...plasmaSlice, nominalExposureShare: 0.15, exposureShare: 0.12 }),
      ],
      unresolvedExposures: [protocolWide],
    }));
    expect(partial?.rows[0]?.share).toMatchObject({ status: "partial", unquantifiedMemberCount: 1 });
    expect(partial?.rows[0]?.share.status === "partial" && partial.rows[0].share.knownShareLowerBound).toBeCloseTo(0.15, 6);
  });

  it("keeps evaluator keys and tier slugs out of reader notes", () => {
    const view = buildFailureDomainsView(cardWithDeploymentRisk({
      adjustments: [adjustment(), plasmaSlice, solanaSlice],
      unresolvedExposures: [protocolWide],
    }));
    for (const row of view!.rows) {
      for (const member of row.members) {
        expect(member.reason).not.toMatch(/bridge-route:|chain:|external-lock-mint/);
        expect(member.reason?.length).toBeGreaterThan(0);
      }
    }
  });
});
