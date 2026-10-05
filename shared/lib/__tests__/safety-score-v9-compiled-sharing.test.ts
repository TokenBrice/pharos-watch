import { describe, expect, it } from "vitest";
import { compileV9FactSetV3 } from "../safety-score-v9/compile";
import { V9FactSetCoreV3Schema } from "../../types/safety-score-v9-facts";
import { createV9ValueInterner } from "../../types/safety-score-v9-immutable";
import {
  compileNativeV3FactSet,
  computeV9FactSetDigest,
  coreFixture,
  createV9FactGapV3,
  createV9FactStatus,
  requiredV9Applicability,
} from "./safety-score-v9-facts.fixture-support";

function currentCore() {
  const { v9FactSetDigest: _digest, ...core } = compileNativeV3FactSet(coreFixture());
  return V9FactSetCoreV3Schema.parse(core);
}

describe("immutable compiled fact sharing", () => {
  it("shares only structurally equal schema-owned values while leaving caller inputs isolated", () => {
    const domain = { kind: "reserve-issuer", key: "origin" };
    const supplied = {
      first: domain, equal: { ...domain }, repeated: domain,
      different: { kind: "mint-control", key: "origin" },
      emptyArray: [], emptyObject: {}, shortSparse: new Array(1), longSparse: new Array(2),
      negativeZero: [-0], zero: [0],
    };
    const original = structuredClone(supplied);
    const admitted = createV9ValueInterner()(structuredClone(supplied));
    expect(supplied).toEqual(original);
    expect(supplied.first).toBe(domain);
    expect(supplied.first).not.toBe(supplied.equal);
    expect(Object.isFrozen(supplied)).toBe(false);
    expect(Object.isFrozen(domain)).toBe(false);
    expect(admitted.first).not.toBe(domain);
    expect(admitted.first).toBe(admitted.equal);
    expect(admitted.first).toBe(admitted.repeated);
    expect(admitted.first).not.toBe(admitted.different);
    expect(admitted.emptyArray).not.toBe(admitted.emptyObject);
    expect(admitted.shortSparse).not.toBe(admitted.longSparse);
    expect(admitted.shortSparse).toHaveLength(1);
    expect(admitted.longSparse).toHaveLength(2);
    expect(admitted.negativeZero).not.toBe(admitted.zero);
    expect(Object.isFrozen(admitted.first)).toBe(true);
    domain.key = "caller-update";
    expect(admitted.first.key).toBe("origin");
  });

  it("shares equal statuses without letting one consumer mutate another holding or the supplied input", () => {
    const core = currentCore();
    const supplied = core.assets[0]!;
    const parsedValues = V9FactSetCoreV3Schema.parse(core);
    const expectedDigest = computeV9FactSetDigest(parsedValues);
    const compiled = compileV9FactSetV3(core);
    const asset = compiled.assets[0]!;
    const status = asset.reserveExposures[0]!.status;

    expect(status).toBe(asset.reserveStatus);
    expect(status).toBe(asset.reserveExposures[1]!.status);
    expect(() => { status.observationState = "missing"; }).toThrow(TypeError);
    expect(() => { status.evidenceRefIds.push("forged-source"); }).toThrow(TypeError);
    expect(asset.reserveExposures[1]!.status.observationState).toBe("known");
    expect(supplied.reserveExposures[0]!.status.observationState).toBe("known");
    expect(Object.isFrozen(supplied.reserveExposures[0]!.status)).toBe(false);
    const { v9FactSetDigest, ...admittedValues } = compiled;
    expect(admittedValues).toEqual(parsedValues);
    expect(v9FactSetDigest).toBe(expectedDigest);
  });

  it("reuses admitted immutable rows but revalidates cloned rows and cohort references", () => {
    const compiled = compileV9FactSetV3(currentCore());
    const { v9FactSetDigest: _digest, ...core } = compiled;
    const repeated = compileV9FactSetV3(core);
    expect(repeated.v9FactSetDigest).toBe(compiled.v9FactSetDigest);
    for (let index = 0; index < compiled.assets.length; index++) {
      expect(repeated.assets[index]).toBe(compiled.assets[index]);
    }
    const cloned = structuredClone(compiled.assets[0]!);
    const replaced = compileV9FactSetV3({ ...core, assets: [cloned, ...compiled.assets.slice(1)] });
    expect(replaced.assets[0]).not.toBe(cloned);
    expect(replaced.assets[0]).not.toBe(compiled.assets[0]);
    expect(replaced.assets[1]).toBe(compiled.assets[1]);
    expect(replaced.v9FactSetDigest).toBe(compiled.v9FactSetDigest);
    cloned.peg.currentDeviationBps = Number.NaN;
    expect(() => compileV9FactSetV3({ ...core, assets: [cloned, ...compiled.assets.slice(1)] })).toThrow();
    expect(() => compileV9FactSetV3({ ...core, activeAssetIds: core.activeAssetIds.slice(1) })).toThrow();
  });

  it("shares one historical source and U proof while keeping publisher and gap identities distinct", () => {
    const core = currentCore();
    const asset = core.assets[0]!;
    const source = asset.evidence.find((reference) => reference.evidenceId === "evidence:base")!;
    for (const [gapId, publishedBy] of [
      ["history:one", "issuer"], ["history:two", "issuer"], ["history:parent", "parent"],
    ] as const) {
      asset.gaps.push(createV9FactGapV3({
        gapId, reasonCode: "partial-reserve-review", ownerDomain: "backing",
        policyRuleId: "v9.backing.reserve-composition", observationState: "missing",
        path: { kind: "local-component", componentKey: gapId },
        message: "Historical composition does not resolve this datum.", responsibility: "unresearched",
        evidenceHistory: { publishedBy, references: [source] },
      }));
    }
    asset.reserveStatus = createV9FactStatus({
      applicability: requiredV9Applicability("v9.backing.reserve-composition"),
      observationState: "bounded-unknown", evidenceRefIds: [source.evidenceId],
      gapIds: ["history:one", "history:two", "history:parent"],
    });
    const admitted = compileV9FactSetV3(core).assets[0]!;
    const one = admitted.gaps.find((gap) => gap.gapId === "history:one")!;
    const two = admitted.gaps.find((gap) => gap.gapId === "history:two")!;
    const parent = admitted.gaps.find((gap) => gap.gapId === "history:parent")!;
    expect(one).not.toBe(two);
    expect(one.causeProof).toBe(two.causeProof);
    expect(one.evidenceHistory).toBe(two.evidenceHistory);
    expect(one.evidenceHistory).not.toBe(parent.evidenceHistory);
    expect(() => { one.evidenceHistory!.publishedBy = "parent"; }).toThrow(TypeError);
    expect(() => { one.evidenceHistory!.evidenceRefIds.push("forged-source"); }).toThrow(TypeError);
    expect(two.evidenceHistory!.publishedBy).toBe("issuer");
    expect(parent.evidenceHistory!.publishedBy).toBe("parent");
    expect(two.evidenceHistory!.evidenceRefIds).toEqual([source.evidenceId]);
  });

  it("never merges missing factor statuses that refer to different atomic gaps", () => {
    const core = currentCore();
    const asset = core.assets[0]!;
    const exposure = asset.reserveExposures[0]!;
    exposure.liquidityHorizon = "unknown";
    exposure.maturityDaysMax = null;
    exposure.factorStatuses = {};
    for (const [factorKey, requiredDatum] of [
      ["liquidity", "liquidityHorizon"], ["maturity", "maturityDaysMax"],
    ] as const) {
      const gap = createV9FactGapV3({
        gapId: `atomic:${factorKey}`, reasonCode: "material-reserve-slice-unstructured", ownerDomain: "backing",
        policyRuleId: "v9.backing.reserve-classification", observationState: "missing",
        path: { kind: "collateral-exposure", exposureKey: exposure.exposureKey },
        message: `Unresearched ${requiredDatum}.`, responsibility: "unresearched",
        causeScope: { pillar: "backing", componentKey: "reserve-exposure", factorKey, routeKey: null,
          exposureId: exposure.exposureKey, requiredDatum },
      });
      asset.gaps.push(gap);
      exposure.factorStatuses[factorKey] = createV9FactStatus({
        applicability: requiredV9Applicability("v9.backing.reserve-classification"),
        observationState: "missing", gapIds: [gap.gapId],
      });
    }
    const admitted = compileV9FactSetV3(core).assets[0]!;
    const statuses = admitted.reserveExposures[0]!.factorStatuses!;
    expect(statuses.liquidity).not.toBe(statuses.maturity);
    expect(statuses.liquidity!.gapIds).toEqual(["atomic:liquidity"]);
    expect(statuses.maturity!.gapIds).toEqual(["atomic:maturity"]);
    expect(statuses.liquidity!.applicability).toBe(statuses.maturity!.applicability);
    expect(() => { statuses.liquidity!.gapIds.push("atomic:maturity"); }).toThrow(TypeError);
    expect(statuses.maturity!.gapIds).toEqual(["atomic:maturity"]);
  });
});
