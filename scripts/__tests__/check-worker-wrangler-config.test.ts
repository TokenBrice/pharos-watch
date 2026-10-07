import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateWorkerWranglerConfig } from "../ci/check-worker-wrangler-config";

const VALID_CONFIG = `
name = "stablecoin-api"
main = "src/index.ts"
compatibility_date = "2026-04-18"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
preview_urls = true
minify = true
keep_names = true
routes = [
  { pattern = "api.pharos.watch", custom_domain = true },
  { pattern = "site-api.pharos.watch", custom_domain = true },
  { pattern = "ops-api.pharos.watch", custom_domain = true }
]

[alias]
"#pharos-full-catalog" = "./src/lib/full-stablecoin-catalog.ts"

[version_metadata]
binding = "CF_VERSION_METADATA"

[[d1_databases]]
binding = "DB"
database_id = "8f3f54ca-e035-4cdf-9ec5-a4fbbe48b27a"

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
minify = true
keep_names = true

[alias]
"#pharos-full-catalog" = "./src/lib/full-stablecoin-catalog.ts"

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
  it("validates the heavy scheduled-only configuration", () => {
    const toml = readFileSync("worker/wrangler.heavy.toml", "utf8");
    expect(evaluateWorkerWranglerConfig(toml, { workerRole: "heavy" })).toEqual({ failed: false, issues: [] });
    for (const mutation of [
      toml.replace("workers_dev = false", "workers_dev = true"),
      toml.replace("preview_urls = false", "preview_urls = true"),
      toml.replace('name = "stablecoin-heavy"', 'name = "stablecoin-api"'),
      toml.replace('main = "src/index.heavy.ts"', 'main = "src/index.ts"'),
      toml.replace('[alias]', 'routes = []\n[alias]'),
      `${toml}\n[[ratelimits]]\nname = "HTTP"\n`,
      toml.replace('binding = "SAFETY_SCORE_V9_WORKFLOW"', 'binding = "WRONG_WORKFLOW"'),
    ]) {
      expect(evaluateWorkerWranglerConfig(mutation, { workerRole: "heavy" }).failed).toBe(true);
    }
  });
  it("rejects a missing lossless Worker catalog alias", () => {
    const report = evaluateWorkerWranglerConfig(VALID_CONFIG.replace(
      '"#pharos-full-catalog" = "./src/lib/full-stablecoin-catalog.ts"', "",
    ));
    expect(report.issues).toContain("Worker full catalog alias must resolve to ./src/lib/full-stablecoin-catalog.ts.");
  });
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

  it("checks minification and function-name preservation against the runtime documentation", () => {
    const report = evaluateWorkerWranglerConfig(VALID_CONFIG, {
      workerInfrastructureDoc: VALID_WORKER_INFRASTRUCTURE_DOC
        .replace("minify = true", "minify = false")
        .replace("keep_names = true", "keep_names = false"),
    });
    expect(report.issues).toContain("docs/worker-infrastructure.md runtime snippet must document minify = true; found false.");
    expect(report.issues).toContain("docs/worker-infrastructure.md runtime snippet must document keep_names = true; found false.");
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
