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
});

describe("buildFailureDomainsView", () => {
  it("hides itself when the asset has no shared domains", () => {
    expect(buildFailureDomainsView(makeV9Card())).toBeNull();
    expect(buildFailureDomainsView(null)).toBeNull();
  });

  it("keeps a zero-point domain — no penalty is not no exposure", () => {
    const view = buildFailureDomainsView(cardWithDeploymentRisk({ adjustments: [adjustment()] }));
    expect(view?.rows).toHaveLength(1);
    expect(view?.rows[0]?.adjustmentPoints).toBe(0);
    expect(view?.rows[0]?.exposureShare).toBeCloseTo(0.34, 6);
    expect(view?.rows[0]?.resolved).toBe(true);
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
    expect(view?.rows.at(-1)?.resolved).toBe(false);
    expect(view?.rows.at(-1)?.exposureShare).toBeNull();
  });
});
