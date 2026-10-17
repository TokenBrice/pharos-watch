import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkWorkerWranglerConfig, evaluateWorkerWranglerConfig } from "../ci/check-worker-wrangler-config";

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
      toml.replace('binding = "SAFETY_CAPTURE_ARCHIVE"', 'binding = "WRONG_ARCHIVE"'),
      toml.replace('bucket_name = "pharos-measurements"', 'bucket_name = "wrong-bucket"'),
      `${toml}\n[vars]\nWORKER_V9_WORKFLOW_MODE = "shadow"\n`,
      `${toml}\n[vars]\nWORKER_V9_WORKFLOW_MODE = "off"\n`,
    ]) {
      expect(evaluateWorkerWranglerConfig(mutation, { workerRole: "heavy" }).failed).toBe(true);
    }
  });
  it.each(["public", "heavy"] as const)("rejects retired Workflow bindings on %s", (workerRole) => {
    const toml = workerRole === "public" ? VALID_CONFIG : readFileSync("worker/wrangler.heavy.toml", "utf8");
    const report = evaluateWorkerWranglerConfig(
      `${toml}\n[[workflows]]\nname = "safety-score-v9-publication"\nbinding = "SAFETY_SCORE_V9_WORKFLOW"\nclass_name = "SafetyScoreV9PublicationWorkflow"\n`,
      { workerRole },
    );
    expect(report.issues).toContain(`${workerRole} must not declare retired Workflow bindings.`);
  });
  it("rejects accepted-capture bucket ownership on public", () => {
    const report = evaluateWorkerWranglerConfig(
      `${VALID_CONFIG}\n[[r2_buckets]]\nbinding = "SAFETY_CAPTURE_ARCHIVE"\nbucket_name = "pharos-measurements"\n`,
    );
    expect(report.issues).toContain("Public must not own the accepted Safety capture archive bucket binding.");
  });
  it("rejects the retired Workflow mode on public", () => {
    const report = evaluateWorkerWranglerConfig(
      VALID_CONFIG.replace('[vars]', '[vars]\nWORKER_V9_WORKFLOW_MODE = "shadow"'),
    );
    expect(report.issues).toContain('public must not declare retired WORKER_V9_WORKFLOW_MODE.');
  });

  it.each([
    ["compatibility_date", /^compatibility_date\s*=.*$/m, 'compatibility_date = "2026-10-08"'],
    ["compatibility_flags", /^compatibility_flags\s*=.*$/m, 'compatibility_flags = ["nodejs_compat"]'],
    ["minify", /^minify\s*=.*$/m, "minify = false"],
    ["keep_names", /^keep_names\s*=.*$/m, "keep_names = false"],
  ])("rejects paired runtime drift in %s without reading documentation", (key, pattern, replacement) => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-paired-date-test-"));
    try {
      const publicPath = join(directory, "public.toml");
      const heavyPath = join(directory, "heavy.toml");
      writeFileSync(publicPath, readFileSync("worker/wrangler.toml", "utf8"));
      writeFileSync(heavyPath, readFileSync("worker/wrangler.heavy.toml", "utf8").replace(
        pattern, replacement,
      ));
      const report = checkWorkerWranglerConfig(publicPath, heavyPath);
      expect(report.failed).toBe(true);
      expect(report.issues.some((issue) => issue.includes("Paired runtime configuration differs") && issue.includes(key))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
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
