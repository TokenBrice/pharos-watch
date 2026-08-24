import { describe, expect, it } from "vitest";
import {
  CanonicalTextSchema,
  V9ControlCapabilitySchema,
  V9MechanismExitDispositionSchema,
  V9RouteHolderAccessSchema,
} from "../safety-score-v9-fact-input-primitives";

describe("Safety Score V9 shared fact-input leaves", () => {
  it("rejects surrounding whitespace instead of normalizing digest-bearing text", () => {
    expect(CanonicalTextSchema.safeParse(" canonical ").success).toBe(false);
    expect(CanonicalTextSchema.parse("canonical")).toBe("canonical");
  });

  it("keeps control and route vocabularies closed", () => {
    expect(V9ControlCapabilitySchema.safeParse("freeze").success).toBe(true);
    expect(V9ControlCapabilitySchema.safeParse("pause-anything").success).toBe(false);
    expect(V9RouteHolderAccessSchema.safeParse("retail-open").success).toBe(true);
    expect(V9RouteHolderAccessSchema.safeParse("public-ish").success).toBe(false);
  });

  it("accepts expired published evidence as a mechanism-exit disposition", () => {
    expect(V9MechanismExitDispositionSchema.parse("published-evidence-expired"))
      .toBe("published-evidence-expired");
  });
});
