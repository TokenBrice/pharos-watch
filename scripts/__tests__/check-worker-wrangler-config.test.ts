import { describe, expect, it } from "vitest";
import { evaluateWorkerWranglerConfig } from "../ci/check-worker-wrangler-config";

const VALID_CONFIG = `
name = "stablecoin-api"
routes = [
  { pattern = "api.pharos.watch", custom_domain = true },
  { pattern = "site-api.pharos.watch", custom_domain = true },
  { pattern = "ops-api.pharos.watch", custom_domain = true }
]

[[rules]]
type = "Data"
globs = ["**/*.ttf"]
fallthrough = true

[[rules]]
type = "CompiledWasm"
globs = ["**/*.wasm"]
fallthrough = true
`;

describe("check-worker-wrangler-config", () => {
  it("accepts root-owned custom domains and fallthrough asset rules", () => {
    expect(evaluateWorkerWranglerConfig(VALID_CONFIG)).toEqual({ failed: false, issues: [] });
  });

  it("rejects routes nested under an asset rule and missing fallthrough", () => {
    const report = evaluateWorkerWranglerConfig(`
[[rules]]
type = "Data"
globs = ["**/*.ttf"]

[[rules]]
type = "CompiledWasm"
globs = ["**/*.wasm"]
routes = [{ pattern = "api.pharos.watch", custom_domain = true }]
`);

    expect(report.failed).toBe(true);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        "Expected exactly one root routes assignment before any table; found 0.",
        "routes is owned by [rules] instead of the Wrangler root.",
        "[[rules]] entry Data must set fallthrough = true.",
        "[[rules]] entry CompiledWasm must set fallthrough = true.",
      ]),
    );
  });

  it("rejects missing, extra, or non-custom production domains", () => {
    const report = evaluateWorkerWranglerConfig(
      VALID_CONFIG.replace(
        '{ pattern = "ops-api.pharos.watch", custom_domain = true }',
        '{ pattern = "preview.pharos.watch", custom_domain = false }',
      ),
    );

    expect(report.failed).toBe(true);
    expect(report.issues).toContain("Route preview.pharos.watch must set custom_domain = true.");
    expect(report.issues.some((issue) => issue.startsWith("Root custom domains must be exactly"))).toBe(true);
  });

  it("rejects route entries that only appear in TOML comments", () => {
    const report = evaluateWorkerWranglerConfig(`
routes = [
  # { pattern = "api.pharos.watch", custom_domain = true },
  # { pattern = "site-api.pharos.watch", custom_domain = true },
  # { pattern = "ops-api.pharos.watch", custom_domain = true }
]

[[rules]]
type = "Data"
globs = ["**/*.ttf"]
fallthrough = true

[[rules]]
type = "CompiledWasm"
globs = ["**/*.wasm"]
fallthrough = true
`);

    expect(report.failed).toBe(true);
    expect(report.issues).toContain(
      "Root custom domains must be exactly api.pharos.watch, ops-api.pharos.watch, site-api.pharos.watch; found none.",
    );
  });
});
