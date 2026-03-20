import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPS_API_ORIGIN,
  PAGES_FUNCTIONS_ACTIVE_ENV_KEYS,
  PAGES_FUNCTIONS_OPTIONAL_ENV_KEYS,
  PAGES_FUNCTIONS_REQUIRED_ENV_KEYS,
  PAGES_FUNCTIONS_RESERVED_ENV_KEYS,
  resolveOpsApiOrigin,
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
});
