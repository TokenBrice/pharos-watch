import { describe, expect, it } from "vitest";
import catalog from "@shared/data/safety-score-v9/lane-emitter-descriptors-v1.generated.json";
import { adaptLaneEmitterCatalog } from "../safety-score-v9/lane-emitter-catalog";
import { laneIncidentCertificateScreeningSetId } from "../safety-score-v9/lane-incident-certificate-store";

describe("reviewed lane emitter catalog", () => {
  it("admits exactly the five reviewed pilot lanes with recomputed v2 identities", () => {
    const result = adaptLaneEmitterCatalog(catalog.descriptors);
    expect(result.reasons).toEqual([]);
    expect(result.descriptors).toHaveLength(5);
    expect(new Set(result.descriptors.map((row) => row.assetId))).toEqual(new Set(["frnt-wyoming", "yusd-yieldfi"]));
    for (const row of result.descriptors) {
      expect(row.screeningSetId).toBe(laneIncidentCertificateScreeningSetId({ ...row,
        emitters: row.emitters.map((emitter) => ({ address: emitter.address,
          expectedRuntimeCodeSha256: emitter.reviewedRuntimePin.split(":")[1] })),
      }));
    }
  });
  it("quarantines unmappable descriptors without losing valid siblings", () => {
    const source = catalog.descriptors[0];
    for (const bad of [
      { ...source, provenance: { ...source.provenance, controlIds: [] } },
      { ...source, provenance: { ...source.provenance, assetIds: [] } },
      { ...source, emitters: [{ ...source.emitters[0], expectedRuntimeCodeSha256: "bad-pin" }] },
      { ...source, emitters: [{ ...source.emitters[0], expectedRuntimeCodeSha256: "a".repeat(64) }, ...source.emitters.slice(1)] },
    ]) {
      const result = adaptLaneEmitterCatalog([bad, source]);
      expect(result.descriptors).toHaveLength(1);
      expect(result.reasons).toHaveLength(1);
    }
    expect(adaptLaneEmitterCatalog([source], "f".repeat(64))).toMatchObject({ descriptors: [],
      reasons: [`lane-descriptor-policy-mismatch:${source.subjectDeploymentKey}`] });
  });
  it("rejects missing reviewed emitters even when provenance is narrowed consistently", () => {
    const source = catalog.descriptors.find((row) => row.emitters.length > 1)!;
    const emitters = source.emitters.slice(1);
    const addresses = new Set(emitters.map((row) => row.address));
    const result = adaptLaneEmitterCatalog([{ ...source, emitters, provenance: { ...source.provenance,
      emitters: source.provenance.emitters.filter((row) => addresses.has(row.address)),
      contributors: source.provenance.contributors.map((row) => ({
        ...row, emitterAddresses: row.emitterAddresses.filter((address) => addresses.has(address)),
      })).filter((row) => row.emitterAddresses.length > 0),
      controlIds: source.provenance.contributors.filter((row) => row.emitterAddresses.some((address) => addresses.has(address)))
        .map((row) => row.controlId),
    } }]);
    expect(result).toEqual({ descriptors: [], reasons: [`lane-descriptor-inventory-mismatch:${source.subjectDeploymentKey}`] });
  });

  it("rejects event-family narrowing relative to the reviewed inventory", () => {
    const source = catalog.descriptors[0];
    const result = adaptLaneEmitterCatalog([{ ...source, emitters: source.emitters.map((row, index) =>
      index === 0 ? { ...row, families: row.families.slice(1) } : row) }]);
    expect(result).toEqual({ descriptors: [], reasons: [`lane-descriptor-inventory-mismatch:${source.subjectDeploymentKey}`] });
  });

  it("rejects provenance inconsistent with admitted emitter identity", () => {
    const source = catalog.descriptors[0];
    const result = adaptLaneEmitterCatalog([{ ...source, provenance: { ...source.provenance,
      emitters: source.provenance.emitters.map((row, index) => index === 0 ? { ...row, chain: "wrong-chain" } : row),
    } }]);
    expect(result).toEqual({ descriptors: [], reasons: [`lane-descriptor-provenance-mismatch:${source.subjectDeploymentKey}`] });
  });
});
