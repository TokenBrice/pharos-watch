import { describe, expect, it } from "vitest";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { deriveCurrentPegObservationMap } from "../current-peg-observations";

const AS_OF = 1_700_000_000;

describe("current peg observations", () => {
  it.each([
    ["xaut-tether", "peggedUSD", 5_000], ["usdc-circle", "peggedJPY", 150],
  ])("withholds a registry/snapshot peg-unit mismatch (%s)", (id, pegType, price) => {
    const observation = deriveCurrentPegObservationMap({
      peggedAssets: [makeAsset({ id, pegType, price })], asOf: AS_OF,
    }).get(id);
    expect(observation).toMatchObject({
      currentDeviationBps: null, currentSignal: null, pegReference: null, pegReferenceUnavailable: true,
    });
  });
});
