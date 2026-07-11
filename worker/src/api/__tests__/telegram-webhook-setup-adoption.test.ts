import { describe, expect, it } from "vitest";
import { parseSetupState } from "../telegram-webhook-setup";

describe("setup adoption state", () => {
  it("preserves only an allowlisted setup token through the short-lived wizard state", () => {
    const base = { step: "branch", alertTypes: [], target: null };
    expect(parseSetupState(JSON.stringify({ ...base, adoptionToken: "pw1_landing_hero" }), "42"))
      .toMatchObject({ adoptionToken: "pw1_landing_hero", initiatorUserId: "42" });
    expect(parseSetupState(JSON.stringify({ ...base, adoptionToken: "pw1_landing_arbitrary" }), "42"))
      .toMatchObject({ adoptionToken: null, initiatorUserId: "42" });
    expect(parseSetupState(JSON.stringify({ ...base, adoptionToken: "pw1_landing_miniapp_home" }), "42"))
      .toMatchObject({ adoptionToken: null, initiatorUserId: "42" });
  });
});
