import { describe, expect, it } from "vitest";
import * as pricingSourceHealth from "../pricing-source-health";
import * as status from "../status";
import * as d1Capacity from "../status/d1-capacity";

// `status.ts` re-exports these two modules with `export type { … }` on purpose:
// consumers of the compatibility barrel must not pull their runtime schemas and
// constants into the bundle. Checking by origin (rather than pinning the
// barrel's export names) keeps the invariant meaningful as the barrel grows.
const TYPE_ONLY_MODULES: Record<string, Record<string, unknown>> = {
  "./pricing-source-health": pricingSourceHealth,
  "./status/d1-capacity": d1Capacity,
};

describe("status compatibility barrel", () => {
  it("leaks no runtime export from the type-only domain modules", () => {
    const barrelKeys = new Set(Object.keys(status));

    for (const [specifier, moduleNamespace] of Object.entries(TYPE_ONLY_MODULES)) {
      const runtimeExports = Object.keys(moduleNamespace);
      // Guards the check against silently going vacuous if a module ever loses
      // its runtime exports — then this test would prove nothing.
      expect(runtimeExports.length, `${specifier} has no runtime exports to guard`).toBeGreaterThan(0);
      expect(runtimeExports.filter((key) => barrelKeys.has(key)), `${specifier} leaked through the barrel`).toEqual([]);
    }
  });
});
