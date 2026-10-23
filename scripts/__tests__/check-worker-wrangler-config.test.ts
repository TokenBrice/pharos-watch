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
upload_source_maps = true
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

[[services]]
binding = "HEAVY_EXECUTOR"
service = "stablecoin-heavy"

[[queues.producers]]
binding = "RESERVE_CONTINUATION_QUEUE"
queue = "pharos-reserve-continuation"

[[queues.consumers]]
queue = "pharos-reserve-continuation"
max_batch_size = 1
max_batch_timeout = 0
max_concurrency = 1
max_retries = 3
retry_delay = 60
dead_letter_queue = "pharos-reserve-continuation-dlq"

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
PROJECT_TAPE_PLACED_EXECUTOR = "on"
WORKER_RESERVE_QUEUE_MODE = "on"
WORKER_SLOT_CATCH_UP_MODE = "on"

[[rules]]
type = "Data"
globs = ["**/*.ttf"]
fallthrough = true

[[rules]]
type = "CompiledWasm"
globs = ["**/*.wasm"]
fallthrough = true

[[rules]]
type = "Text"
globs = ["**/coins.worker-full.generated.json"]
fallthrough = true
`;

describe("check-worker-wrangler-config", () => {
  it("bounds public Queue consumption and permits mode-only rollback", () => {
    expect(evaluateWorkerWranglerConfig(VALID_CONFIG.replace(
      'WORKER_RESERVE_QUEUE_MODE = "on"', 'WORKER_RESERVE_QUEUE_MODE = "off"',
    )).failed).toBe(false);
    expect(evaluateWorkerWranglerConfig(VALID_CONFIG.replace(
      'WORKER_SLOT_CATCH_UP_MODE = "on"', 'WORKER_SLOT_CATCH_UP_MODE = "off"',
    )).failed).toBe(false);
    for (const [before, after] of [
      ["max_batch_size = 1", "max_batch_size = 2"],
      ["max_batch_timeout = 0", "max_batch_timeout = 1"],
      ["max_concurrency = 1", "max_concurrency = 2"],
      ["max_retries = 3", "max_retries = 100"],
      ["retry_delay = 60", "retry_delay = 0"],
      ['WORKER_RESERVE_QUEUE_MODE = "on"', 'WORKER_RESERVE_QUEUE_MODE = "maybe"'],
      ['WORKER_SLOT_CATCH_UP_MODE = "on"', 'WORKER_SLOT_CATCH_UP_MODE = "maybe"'],
      ['binding = "RESERVE_CONTINUATION_QUEUE"', 'binding = "OTHER"'],
      ['dead_letter_queue = "pharos-reserve-continuation-dlq"', 'dead_letter_queue = "other"'],
    ]) expect(evaluateWorkerWranglerConfig(VALID_CONFIG.replace(before, after)).failed).toBe(true);
    expect(evaluateWorkerWranglerConfig(
      `${readFileSync("worker/wrangler.heavy.toml", "utf8")}\n[[queues.consumers]]\nqueue = "other"\n`,
      { workerRole: "heavy" },
    ).failed).toBe(true);
  });
  it("validates the private heavy configuration with fetch-only placement", () => {
    const toml = readFileSync("worker/wrangler.heavy.toml", "utf8");
    expect(evaluateWorkerWranglerConfig(toml, { workerRole: "heavy" })).toEqual({ failed: false, issues: [] });
    for (const mutation of [
      toml.replace("workers_dev = false", "workers_dev = true"),
      toml.replace("preview_urls = false", "preview_urls = true"),
      toml.replace('name = "stablecoin-heavy"', 'name = "stablecoin-api"'),
      toml.replace('main = "src/index.heavy.ts"', 'main = "src/index.ts"'),
      toml.replace("upload_source_maps = true", "upload_source_maps = false"),
      toml.replace(/^upload_source_maps = true\n/m, ""),
      toml.replace('[alias]', 'routes = []\n[alias]'),
      `${toml}\n[[ratelimits]]\nname = "HTTP"\n`,
      toml.replace('binding = "SAFETY_CAPTURE_ARCHIVE"', 'binding = "WRONG_ARCHIVE"'),
      toml.replace('bucket_name = "pharos-measurements"', 'bucket_name = "wrong-bucket"'),
      `${toml}\n[vars]\nWORKER_V9_WORKFLOW_MODE = "shadow"\n`,
      `${toml}\n[vars]\nWORKER_V9_WORKFLOW_MODE = "off"\n`,
      toml.replace('region = "aws:eu-central-1"', 'region = "aws:us-east-1"'),
      toml.replace('[placement]', '[placement]\nmode = "smart"'),
      `${toml}\n[[services]]\nbinding = "HEAVY_EXECUTOR"\nservice = "stablecoin-heavy"\n`,
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
    ["upload_source_maps", /^upload_source_maps\s*=.*$/m, "upload_source_maps = false"],
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
  it.each(["public", "heavy"] as const)("requires private source maps on %s", (workerRole) => {
    const toml = workerRole === "public" ? VALID_CONFIG : readFileSync("worker/wrangler.heavy.toml", "utf8");
    expect(evaluateWorkerWranglerConfig(toml, { workerRole })).toEqual({ failed: false, issues: [] });
    for (const mutation of [
      toml.replace("upload_source_maps = true", "upload_source_maps = false"),
      toml.replace(/^upload_source_maps = true\n/m, ""),
    ]) {
      const report = evaluateWorkerWranglerConfig(mutation, { workerRole });
      expect(report.issues).toContain(`${workerRole} [root].upload_source_maps must be true.`);
    }
  });
  it("rejects a mismatched source-map posture between roles", () => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-source-maps-"));
    try {
      const publicPath = join(directory, "public.toml");
      const heavyPath = join(directory, "heavy.toml");
      writeFileSync(publicPath, readFileSync("worker/wrangler.toml", "utf8"));
      writeFileSync(
        heavyPath,
        readFileSync("worker/wrangler.heavy.toml", "utf8")
          .replace("upload_source_maps = true", "upload_source_maps = false"),
      );
      const report = checkWorkerWranglerConfig(publicPath, heavyPath);
      expect(report.failed).toBe(true);
      expect(report.issues).toContain("heavy [root].upload_source_maps must be true.");
      expect(
        report.issues.some(
          (issue) => issue.includes("Paired runtime configuration differs") && issue.includes("upload_source_maps"),
        ),
      ).toBe(true);
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

  it.each(["public", "heavy"] as const)("requires the asset glob-to-type mapping on %s", (workerRole) => {
    const toml = workerRole === "public" ? VALID_CONFIG : readFileSync("worker/wrangler.heavy.toml", "utf8");
    for (const mutation of [
      toml.replaceAll("**/*.ttf", "**/*.swap").replaceAll("**/*.wasm", "**/*.ttf").replaceAll("**/*.swap", "**/*.wasm"),
      toml.replace('globs = ["**/*.ttf"]', ""),
      toml.replace('globs = ["**/*.wasm"]', ""),
      toml.replace('globs = ["**/*.ttf"]', "globs = []"),
      toml.replace('globs = ["**/*.wasm"]', 'globs = ["**/*.wasm", "**/*.ttf"]'),
      toml.replace('globs = ["**/coins.worker-full.generated.json"]', ""),
      toml.replace('globs = ["**/coins.worker-full.generated.json"]', 'globs = ["**/*.json"]'),
    ]) {
      const report = evaluateWorkerWranglerConfig(mutation, { workerRole });
      expect(report.failed).toBe(true);
      expect(report.issues.some((issue) => issue.includes("must set globs"))).toBe(true);
    }
    expect(evaluateWorkerWranglerConfig(toml.replace('globs = ["**/*.ttf"]', "globs = [\n'**/*.ttf',\n]"), { workerRole }))
      .toEqual({ failed: false, issues: [] });
  });
  it.each(["public", "heavy"] as const)("requires the packed catalog as a separate Text module on %s", (workerRole) => {
    const toml = workerRole === "public" ? VALID_CONFIG : readFileSync("worker/wrangler.heavy.toml", "utf8");
    for (const mutation of [
      toml.replace('type = "Text"', 'type = "Data"'),
      toml.replace(/\[\[rules\]\]\ntype = "Text"\nglobs = \["\*\*\/coins\.worker-full\.generated\.json"\]\nfallthrough = true\n/, ""),
    ]) {
      expect(evaluateWorkerWranglerConfig(mutation, { workerRole }).failed).toBe(true);
    }
  });
  it("accepts the project-tape rollback flag without removing the binding", () => {
    expect(evaluateWorkerWranglerConfig(VALID_CONFIG.replace(
      'PROJECT_TAPE_PLACED_EXECUTOR = "on"', 'PROJECT_TAPE_PLACED_EXECUTOR = "off"',
    ))).toEqual({ failed: false, issues: [] });
  });

  it("rejects missing, misdirected or RPC executor bindings and invalid flags", () => {
    for (const mutation of [
      VALID_CONFIG.replace('binding = "HEAVY_EXECUTOR"', 'binding = "OTHER"'),
      VALID_CONFIG.replace('service = "stablecoin-heavy"', 'service = "stablecoin-api"'),
      VALID_CONFIG.replace('service = "stablecoin-heavy"', 'service = "stablecoin-heavy"\nentrypoint = "Executor"'),
      VALID_CONFIG.replace('PROJECT_TAPE_PLACED_EXECUTOR = "on"', 'PROJECT_TAPE_PLACED_EXECUTOR = "maybe"'),
      `${VALID_CONFIG}\n[placement]\nregion = "aws:eu-central-1"\n`,
    ]) expect(evaluateWorkerWranglerConfig(mutation).failed).toBe(true);
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
