import { describe, expect, it } from "vitest";
import type { SupplyChainGuardProvenance } from "../../types/market";
import {
  buildSupplyObservationProvenance,
  classifySupplyCoverage,
  isGuardCapablePricingPipelineVersion,
  parseSupplyObservationProvenance,
  projectEnvelopeSupplyProvenance,
} from "../supply-provenance";

const QUARANTINED_SINCE = 1_792_800_000;

function chain(resolution: SupplyChainGuardProvenance["chains"][number]["resolution"], extra: Record<string, unknown> = {}) {
  return {
    chainId: "hyperevm",
    chainLabel: "HyperEVM",
    listCurrentUsd: 0,
    baselineUsd: 3_000,
    baselineObservedAt: 1_792_700_000,
    baselineSource: "state" as const,
    resolution,
    ...extra,
  };
}

const PARTIAL_GUARD: SupplyChainGuardProvenance = {
  reason: "supply-chain-dropout",
  status: "chains-unavailable",
  partialCoverage: true,
  quarantinedSince: QUARANTINED_SINCE,
  chains: [chain("unavailable")],
};

describe("supply provenance coverage authority (K-031)", () => {
  it("classifies a published partial-chain remainder as partial, keeping every original clock", () => {
    const provenance = buildSupplyObservationProvenance({
      supplySource: "defillama",
      supplyObservedAt: 1_792_900_000,
      supplyChainGuard: PARTIAL_GUARD,
    });
    expect(provenance).toEqual({
      supplySource: "defillama",
      supplyObservedAt: 1_792_900_000,
      supplyChainGuard: PARTIAL_GUARD,
    });
    expect(classifySupplyCoverage(provenance)).toBe("partial");
  });

  it("treats an immaterial chains-unavailable omission as partial, but repaired or carried chains as complete", () => {
    const immaterial = { ...PARTIAL_GUARD, partialCoverage: undefined };
    expect(classifySupplyCoverage(buildSupplyObservationProvenance({ supplyChainGuard: immaterial }))).toBe("partial");

    const repaired: SupplyChainGuardProvenance = {
      reason: "supply-chain-dropout",
      status: "repaired",
      chains: [chain("onchain-total-supply", { repairedCurrentUsd: 3_000, observedAt: 1_792_900_000, observedAtKind: "local-read" })],
    };
    expect(classifySupplyCoverage(buildSupplyObservationProvenance({ supplyChainGuard: repaired }))).toBe("complete");
    const carried: SupplyChainGuardProvenance = {
      reason: "supply-chain-dropout", status: "quarantined", quarantinedSince: QUARANTINED_SINCE, chains: [chain("carried-baseline")],
    };
    expect(classifySupplyCoverage(buildSupplyObservationProvenance({ supplyChainGuard: carried }))).toBe("complete");
  });

  it("records guard-less coverage as complete with null source/clock, never synthesizing a clock", () => {
    const provenance = buildSupplyObservationProvenance({});
    expect(provenance).toEqual({ supplySource: null, supplyObservedAt: null, supplyChainGuard: null });
    expect(classifySupplyCoverage(provenance)).toBe("complete");
  });

  it("turns invalid guard metadata into unknown coverage instead of dropping the exclusion", () => {
    expect(buildSupplyObservationProvenance({ supplyChainGuard: { reason: "supply-chain-dropout", chains: [] } })).toBeNull();
    expect(classifySupplyCoverage(null)).toBe("unknown");
    expect(classifySupplyCoverage(undefined)).toBe("unknown");
  });

  it("parses stored JSON, flags malformed metadata and keeps NULL unrecorded", () => {
    const stored = JSON.stringify(buildSupplyObservationProvenance({ supplyChainGuard: PARTIAL_GUARD }));
    expect(parseSupplyObservationProvenance(stored)).toEqual({
      provenance: { supplySource: null, supplyObservedAt: null, supplyChainGuard: PARTIAL_GUARD },
      invalid: false,
    });
    expect(parseSupplyObservationProvenance(null)).toEqual({ provenance: null, invalid: false });
    expect(parseSupplyObservationProvenance("{not json")).toEqual({ provenance: null, invalid: true });
    expect(parseSupplyObservationProvenance(JSON.stringify({ supplySource: 7 }))).toEqual({ provenance: null, invalid: true });
  });

  it("gates guard-less envelope rows on the string Pricing Pipeline version", () => {
    expect(isGuardCapablePricingPipelineVersion("6.57")).toBe(true);
    expect(isGuardCapablePricingPipelineVersion("6.55")).toBe(true);
    expect(isGuardCapablePricingPipelineVersion("6.6")).toBe(true);
    expect(isGuardCapablePricingPipelineVersion("6.54")).toBe(false);
    expect(isGuardCapablePricingPipelineVersion(6.57)).toBe(false);
    expect(isGuardCapablePricingPipelineVersion(undefined)).toBe(false);
    expect(isGuardCapablePricingPipelineVersion("v6.x")).toBe(false);

    expect(projectEnvelopeSupplyProvenance({ supplySource: "defillama" }, "6.57"))
      .toEqual({ supplySource: "defillama", supplyObservedAt: null, supplyChainGuard: null });
    expect(projectEnvelopeSupplyProvenance({ supplySource: "defillama" }, "6.54")).toBeNull();
    expect(projectEnvelopeSupplyProvenance({ supplySource: "defillama" }, undefined)).toBeNull();
    // An explicit guard establishes its own disposition even on an older envelope.
    expect(classifySupplyCoverage(projectEnvelopeSupplyProvenance({ supplyChainGuard: PARTIAL_GUARD }, "6.54"))).toBe("partial");
  });
});
