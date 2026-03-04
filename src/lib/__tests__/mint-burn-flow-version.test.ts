import { describe, expect, it } from "vitest";
import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  MINT_BURN_FLOW_METHODOLOGY_VERSION,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
  getMintBurnFlowMethodologyVersionAt,
  toMintBurnFlowMethodologyVersionLabel,
} from "../mint-burn-flow-version";

describe("mint-burn-flow-version", () => {
  it("keeps current version aligned with latest changelog entry", () => {
    expect(MINT_BURN_FLOW_METHODOLOGY_CHANGELOG[0]?.version).toBe(
      MINT_BURN_FLOW_METHODOLOGY_VERSION,
    );
    expect(
      toMintBurnFlowMethodologyVersionLabel(MINT_BURN_FLOW_METHODOLOGY_VERSION),
    ).toBe(MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL);
  });

  it("resolves reconstructed version windows by timestamp", () => {
    expect(getMintBurnFlowMethodologyVersionAt(1772369417)).toBe("1.0");
    expect(getMintBurnFlowMethodologyVersionAt(1772375712)).toBe("2.0");
    expect(getMintBurnFlowMethodologyVersionAt(1772389000)).toBe("2.1");
    expect(getMintBurnFlowMethodologyVersionAt(1772490000)).toBe("3.0");
    expect(getMintBurnFlowMethodologyVersionAt(1772522000)).toBe("3.1");
    expect(getMintBurnFlowMethodologyVersionAt(1772544000)).toBe("3.2");
    expect(getMintBurnFlowMethodologyVersionAt(1772609391)).toBe("4.0");
    expect(getMintBurnFlowMethodologyVersionAt(1772612000)).toBe("4.1");
  });

  it("returns current version for non-finite timestamps", () => {
    expect(getMintBurnFlowMethodologyVersionAt(Number.NaN)).toBe(
      MINT_BURN_FLOW_METHODOLOGY_VERSION,
    );
    expect(getMintBurnFlowMethodologyVersionAt(Number.POSITIVE_INFINITY)).toBe(
      MINT_BURN_FLOW_METHODOLOGY_VERSION,
    );
  });
});
