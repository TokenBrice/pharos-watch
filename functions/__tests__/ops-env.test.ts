import { describe, expect, it } from "vitest";
import {
  resolveOpsApiOrigin,
  validatePagesOpsProxyEnv,
} from "../lib/ops-env";

describe("ops env contract", () => {
  it("rejects non-canonical credential-bearing ops origins", () => {
    for (const origin of [
      "http://ops-api.pharos.watch",
      "ftp://ops-api.pharos.watch",
      "https://attacker.example",
      "https://ops-api.pharos.watch/path",
      "data:text/plain,opaque",
    ]) {
      expect(resolveOpsApiOrigin({ OPS_API_ORIGIN: origin })).toBeNull();
    }
    expect(validatePagesOpsProxyEnv({ OPS_API_ORIGIN: "https://attacker.example" })).toContainEqual({
      code: "ops-api-origin-invalid",
      message: "OPS_API_ORIGIN must be the canonical HTTPS origin https://ops-api.pharos.watch.",
    });
  });

});
