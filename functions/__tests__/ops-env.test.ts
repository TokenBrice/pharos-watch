import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPS_API_ORIGIN,
  PAGES_FUNCTIONS_ACTIVE_ENV_KEYS,
  PAGES_FUNCTIONS_OPTIONAL_ENV_KEYS,
  PAGES_FUNCTIONS_REQUIRED_ENV_KEYS,
  PAGES_FUNCTIONS_RESERVED_ENV_KEYS,
  resolvePagesOpsUiAccessConfig,
  resolveOpsApiOrigin,
  validatePagesOpsProxyEnv,
} from "../lib/ops-env";

describe("ops env contract", () => {
  it("keeps active and reserved Pages bindings disjoint", () => {
    const active = new Set(PAGES_FUNCTIONS_ACTIVE_ENV_KEYS);
    for (const key of PAGES_FUNCTIONS_RESERVED_ENV_KEYS) {
      expect(active.has(key)).toBe(false);
    }
  });

  it("derives the active Pages set from required and optional bindings", () => {
    expect(PAGES_FUNCTIONS_ACTIVE_ENV_KEYS).toEqual([
      ...PAGES_FUNCTIONS_REQUIRED_ENV_KEYS,
      ...PAGES_FUNCTIONS_OPTIONAL_ENV_KEYS,
    ]);
  });

  it("falls back to the default ops API origin", () => {
    expect(resolveOpsApiOrigin({ OPS_API_ORIGIN: undefined })).toBe(DEFAULT_OPS_API_ORIGIN);
  });

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

  it("requires Pages-side Access verification bindings", () => {
    expect(PAGES_FUNCTIONS_REQUIRED_ENV_KEYS).toContain("CF_ACCESS_TEAM_DOMAIN");
    expect(PAGES_FUNCTIONS_REQUIRED_ENV_KEYS).toContain("CF_ACCESS_OPS_UI_AUD");
    expect(resolvePagesOpsUiAccessConfig({
      CF_ACCESS_TEAM_DOMAIN: "pharos-watch",
      CF_ACCESS_OPS_UI_AUD: "ui-aud",
    })).toEqual({
      teamDomain: "pharos-watch",
      aud: "ui-aud",
    });
  });

  it("flags incomplete Pages-side Access verification config", () => {
    expect(validatePagesOpsProxyEnv({
      OPS_API_SERVICE_TOKEN_ID: "id",
      OPS_API_SERVICE_TOKEN_SECRET: "secret",
      CF_ACCESS_TEAM_DOMAIN: "pharos-watch",
      CF_ACCESS_OPS_UI_AUD: undefined,
    })).toContainEqual({
      code: "ops-access-ui-incomplete",
      message: "CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_OPS_UI_AUD must be configured together for Pages-side Access JWT verification.",
    });
  });
});
