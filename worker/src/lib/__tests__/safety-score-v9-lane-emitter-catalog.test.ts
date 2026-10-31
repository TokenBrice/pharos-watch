import { describe, expect, it } from "vitest";
import catalog from "@shared/data/safety-score-v9/lane-emitter-descriptors-v1.generated.json";
import { adaptLaneEmitterCatalog, laneIncidentCertificateScreeningSetId } from "@shared/lib/safety-score-v9/lane-screening-derivation";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";

const FROZEN_POLICY_DIGEST = "1140d33cfdafa7e85b863a7d40686f17409b85f60ec444c8e187d4ee27f127ab";
const FROZEN_SCREENING_SET_IDS = [
  "174277cf1424befbbc470d5d99db67f4708352d3932ce359b9608a0a91c7bff3",
  "726c6537ab9eb40b37b5b007962cb6bfcd738cd5f03efabae444b2a84308a674",
  "9acbd7f922d3f05cce5b832b741caa54b55d9c77d265f8988b481bcc4a525f70",
  "ded8a66cb659bce25dc2fa9ae60728bba46cd13ffbf83f7d42cf0a1b195aee85",
  "f6c9d6d0f35cdcb50ae331374245e8fb178ddeca2addb13a405d1a2d5a89eac1",
];
const FROZEN_DESCRIPTOR_DIGEST = "68b7f226a5b8d1c40e32038121aec66e0afaab9913241d29612fe6a7bdeefaf2";

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
  it("pins every derived descriptor identity and the frozen screening policy", () => {
    const result = adaptLaneEmitterCatalog(catalog.descriptors);
    expect(result.reasons).toEqual([]);
    expect(result.descriptors.map((row) => row.screeningSetId).sort()).toEqual(FROZEN_SCREENING_SET_IDS);
    expect(new Set(result.descriptors.map((row) => row.screeningPolicyDigest))).toEqual(new Set([FROZEN_POLICY_DIGEST]));
    expect(sha256Hex(stableJsonStringifyV1(result.descriptors))).toBe(FROZEN_DESCRIPTOR_DIGEST);
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
