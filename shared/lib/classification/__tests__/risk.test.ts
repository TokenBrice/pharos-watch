import { describe, it, expect } from "vitest";
import { getDewsRiskLevel } from "../risk";

describe("getDewsRiskLevel", () => {
  // DewsRiskLevel is a 2-tier collapse below ALERT: WATCH has no level of its
  // own, so it maps to "calm" exactly like CALM. Lock that intentional behavior.
  it("collapses WATCH into calm, matching CALM", () => {
    expect(getDewsRiskLevel(["WATCH"])).toBe("calm");
    expect(getDewsRiskLevel(["CALM"])).toBe("calm");
  });

  it("maps the alert bands to their own levels", () => {
    expect(getDewsRiskLevel(["ALERT"])).toBe("alert");
    expect(getDewsRiskLevel(["WARNING"])).toBe("warning");
    expect(getDewsRiskLevel(["DANGER"])).toBe("danger");
  });

  it("returns the highest level across mixed bands", () => {
    expect(getDewsRiskLevel(["WATCH", "WARNING", "ALERT"])).toBe("warning");
    expect(getDewsRiskLevel([])).toBe("calm");
  });
});
