import { describe, expect, it } from "vitest";
import { evaluateWorkerWranglerConfig } from "../ci/check-worker-wrangler-config";

const VALID_CONFIG = `
name = "stablecoin-api"
compatibility_date = "2026-04-18"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
preview_urls = true
routes = [
  { pattern = "api.pharos.watch", custom_domain = true },
  { pattern = "site-api.pharos.watch", custom_domain = true },
  { pattern = "ops-api.pharos.watch", custom_domain = true }
]

[limits]
cpu_ms = 300000

[observability]
enabled = true
head_sampling_rate = 0.1

[observability.logs]
enabled = true
invocation_logs = true

[vars]
ADDRESS_PRICE_PROVIDERS_ENABLED = "coingecko-onchain-address"

[[rules]]
type = "Data"
globs = ["**/*.ttf"]
fallthrough = true

[[rules]]
type = "CompiledWasm"
globs = ["**/*.wasm"]
fallthrough = true
`;

const VALID_WORKER_INFRASTRUCTURE_DOC = `
# Worker Infrastructure

## Runtime Limits and Observability

\`\`\`toml
compatibility_date = "2026-04-18"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
preview_urls = true

[limits]
cpu_ms = 300000

[observability]
enabled = true
head_sampling_rate = 0.1

[observability.logs]
enabled = true
invocation_logs = true
\`\`\`
`;

describe("check-worker-wrangler-config", () => {
  it("accepts root-owned custom domains and fallthrough asset rules", () => {
    expect(evaluateWorkerWranglerConfig(VALID_CONFIG)).toEqual({ failed: false, issues: [] });
  });

  it("accepts runtime documentation that matches the checked-in Worker config", () => {
    expect(
      evaluateWorkerWranglerConfig(VALID_CONFIG, {
        workerInfrastructureDoc: VALID_WORKER_INFRASTRUCTURE_DOC,
      }),
    ).toEqual({ failed: false, issues: [] });
  });

  it("rejects runtime documentation drift from the checked-in Worker config", () => {
    const report = evaluateWorkerWranglerConfig(VALID_CONFIG, {
      workerInfrastructureDoc: VALID_WORKER_INFRASTRUCTURE_DOC.replace("cpu_ms = 300000", "cpu_ms = 30000"),
    });

    expect(report.failed).toBe(true);
    expect(report.issues).toContain(
      "docs/worker-infrastructure.md runtime snippet must document [limits].cpu_ms = 300000; found 30000.",
    );
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

  it("rejects re-enabling the heavier address-price providers in production", () => {
    const report = evaluateWorkerWranglerConfig(
      VALID_CONFIG.replace(
        'ADDRESS_PRICE_PROVIDERS_ENABLED = "coingecko-onchain-address"',
        'ADDRESS_PRICE_PROVIDERS_ENABLED = "dexpaprika-address"',
      ),
    );

    expect(report.failed).toBe(true);
    expect(report.issues).toContain(
      'Production address-price providers must be exactly ADDRESS_PRICE_PROVIDERS_ENABLED="coingecko-onchain-address"; found dexpaprika-address.',
    );
  });
});
