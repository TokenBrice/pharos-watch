import { describe, expect, it } from "vitest";
import { REDEMPTION_CAPACITY_WARNING_EXCEPTIONS } from "../redemption-backstop-live-metadata";

describe("REDEMPTION_CAPACITY_WARNING_EXCEPTIONS", () => {
  it("declares the gho-aave aggregated-residual-issuance exception", () => {
    const ghoExceptions = REDEMPTION_CAPACITY_WARNING_EXCEPTIONS["gho-aave"];
    expect(ghoExceptions).toBeDefined();
    expect(ghoExceptions?.["aggregated-residual-issuance"]).toMatch(/GSM backing/);
  });
});
