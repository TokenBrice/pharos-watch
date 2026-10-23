import { assignmentKey, buildAssignmentMap, parseAssignments, unquote } from "../lib/wrangler-toml.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import type { ScheduledWorkerRole } from "@shared/lib/scheduled-runner-registry";

const EXPECTED_CUSTOM_DOMAINS = ["api.pharos.watch", "ops-api.pharos.watch", "site-api.pharos.watch"] as const;
const EXPECTED_RULE_GLOBS: Record<string, string> = {
  CompiledWasm: "**/*.wasm",
  Data: "**/*.ttf",
  Text: "**/coins.worker-full.generated.json",
};
const EXPECTED_RULE_TYPES = Object.keys(EXPECTED_RULE_GLOBS).sort();
const EXPECTED_ADDRESS_PRICE_PROVIDER_SETTING = "coingecko-onchain-address";
const PAIRED_RUNTIME_FIELDS = [
  { section: "root", key: "compatibility_date" },
  { section: "root", key: "compatibility_flags" },
  { section: "root", key: "minify" },
  { section: "root", key: "keep_names" },
  { section: "root", key: "upload_source_maps" },
  { section: "alias", key: "#pharos-full-catalog" },
  { section: "limits", key: "cpu_ms" },
  { section: "observability", key: "enabled" },
  { section: "observability.logs", key: "enabled" },
  { section: "observability.logs", key: "invocation_logs" },
] as const;

interface TomlAssignment {
  key: string;
  section: string;
  value: string;
}

export interface WorkerWranglerConfigReport {
  failed: boolean;
  issues: string[];
}

interface WorkerWranglerConfigOptions {
  workerRole?: ScheduledWorkerRole;
}

export function evaluateWorkerWranglerConfig(
  toml: string,
  options: WorkerWranglerConfigOptions = {},
): WorkerWranglerConfigReport {
  const assignments = parseAssignments(toml);
  const issues: string[] = [];
  const role = options.workerRole ?? "public";
  const values = buildAssignmentMap(assignments);
  const expectValue = (section: string, key: string, expected: string) => {
    if (values.get(assignmentKey(section, key)) !== expected) {
      issues.push(`${role} [${section}].${key} must be ${expected}.`);
    }
  };
  expectValue("root", "name", role === "public" ? '"stablecoin-api"' : '"stablecoin-heavy"');
  expectValue("root", "main", role === "public" ? '"src/index.ts"' : '"src/index.heavy.ts"');
  expectValue("version_metadata", "binding", '"CF_VERSION_METADATA"');
  expectValue("d1_databases", "binding", '"DB"');
  expectValue("d1_databases", "database_id", '"8f3f54ca-e035-4cdf-9ec5-a4fbbe48b27a"');
  expectValue("root", "upload_source_maps", "true");
  expectValue("limits", "cpu_ms", "300000");
  expectValue("observability", "head_sampling_rate", role === "public" ? "0.1" : "1");
  expectValue("observability", "enabled", "true");
  expectValue("observability.logs", "enabled", "true");
  expectValue("observability.logs", "invocation_logs", "true");
  if (values.has(assignmentKey("vars", "WORKER_V9_WORKFLOW_MODE"))) {
    issues.push(`${role} must not declare retired WORKER_V9_WORKFLOW_MODE.`);
  }
  const workflows = assignments.filter(({ section }) => section === "workflows");
  if (workflows.length > 0) {
    issues.push(`${role} must not declare retired Workflow bindings.`);
  }
  const queueAssignments = assignments.filter(({ section }) => section.startsWith("queues."));
  if (role === "public") {
    expectValue("queues.producers", "binding", '"RESERVE_CONTINUATION_QUEUE"');
    expectValue("queues.producers", "queue", '"pharos-reserve-continuation"');
    expectValue("queues.consumers", "queue", '"pharos-reserve-continuation"');
    expectValue("queues.consumers", "max_batch_size", "1");
    expectValue("queues.consumers", "max_batch_timeout", "0");
    expectValue("queues.consumers", "max_concurrency", "1");
    expectValue("queues.consumers", "max_retries", "3");
    expectValue("queues.consumers", "retry_delay", "60");
    expectValue("queues.consumers", "dead_letter_queue", '"pharos-reserve-continuation-dlq"');
    if (queueAssignments.length !== 9) issues.push("Public must declare exactly the bounded reserve Queue producer/consumer.");
    const queueMode = values.get(assignmentKey("vars", "WORKER_RESERVE_QUEUE_MODE"));
    if (queueMode !== '"on"' && queueMode !== '"off"') issues.push('Public WORKER_RESERVE_QUEUE_MODE must be "on" or "off".');
    const catchUpMode = values.get(assignmentKey("vars", "WORKER_SLOT_CATCH_UP_MODE"));
    if (catchUpMode !== '"on"' && catchUpMode !== '"off"') issues.push('Public WORKER_SLOT_CATCH_UP_MODE must be "on" or "off".');
  } else if (queueAssignments.length > 0) issues.push("Heavy must not declare Queue bindings or consumers.");
  const services = assignments.filter(({ section }) => section === "services");
  const placement = assignments.filter(({ section }) => section === "placement");
  if (role === "public") {
    expectValue("services", "binding", '"HEAVY_EXECUTOR"');
    expectValue("services", "service", '"stablecoin-heavy"');
    if (services.length !== 2 || services.some(({ key }) => key !== "binding" && key !== "service")) {
      issues.push("Public must declare exactly the HEAVY_EXECUTOR default-fetch service binding (no RPC entrypoint).");
    }
    const mode = values.get(assignmentKey("vars", "PROJECT_TAPE_PLACED_EXECUTOR"));
    if (mode !== '"on"' && mode !== '"off"') {
      issues.push('Public PROJECT_TAPE_PLACED_EXECUTOR must be "on" or "off".');
    }
    if (placement.length > 0) issues.push("Placement belongs only to the heavy fetch executor.");
  } else {
    expectValue("placement", "region", '"aws:eu-central-1"');
    if (placement.length !== 1) issues.push("Heavy placement must declare only the reviewed region hint.");
    if (services.length > 0) issues.push("Heavy must not declare an executor service binding.");
    const deferredMaterialization = values.get(assignmentKey("vars", "SAFETY_V9_DEFERRED_MATERIALIZATION"));
    if (deferredMaterialization !== '"on"' && deferredMaterialization !== '"off"') {
      issues.push('Heavy SAFETY_V9_DEFERRED_MATERIALIZATION must be "on" or "off".');
    }
    const chunkedWrites = values.get(assignmentKey("vars", "SAFETY_V9_CHUNKED_PUBLICATION_WRITES"));
    if (chunkedWrites !== '"on"' && chunkedWrites !== '"off"') {
      issues.push('Heavy SAFETY_V9_CHUNKED_PUBLICATION_WRITES must be "on" or "off".');
    }
  }
  if (role === "heavy") {
    expectValue("root", "workers_dev", "false");
    expectValue("root", "preview_urls", "false");
    expectValue("r2_buckets", "binding", '"SAFETY_CAPTURE_ARCHIVE"');
    expectValue("r2_buckets", "bucket_name", '"pharos-measurements"');
    if (assignments.some(({ section, key }) => section.startsWith("ratelimits") || key === "CORS_ORIGIN")) {
      issues.push("Heavy must not declare HTTP rate-limit or CORS bindings.");
    }
  }
  if (role === "public" && assignments.some(({ section, key, value }) =>
    section === "r2_buckets" && key === "binding" && unquote(value) === "SAFETY_CAPTURE_ARCHIVE")) {
    issues.push("Public must not own the accepted Safety capture archive bucket binding.");
  }
  const catalogAliases = assignments.filter(({ section, key }) => section === "alias" && key === "#pharos-full-catalog");
  if (catalogAliases.length !== 1 || unquote(catalogAliases[0]?.value) !== "./src/lib/full-stablecoin-catalog.ts") {
    issues.push("Worker full catalog alias must resolve to ./src/lib/full-stablecoin-catalog.ts.");
  }
  const routes = assignments.filter(({ key }) => key === "routes");
  const rootRoutes = routes.filter(({ section }) => section === "root");
  const nestedRoutes = routes.filter(({ section }) => section !== "root");

  if (role === "heavy" && routes.length > 0) {
    issues.push("Heavy must not declare routes.");
  } else if (role === "public" && rootRoutes.length !== 1) {
    issues.push(`Expected exactly one root routes assignment before any table; found ${rootRoutes.length}.`);
  }
  for (const route of nestedRoutes) {
    issues.push(`routes is owned by [${route.section}] instead of the Wrangler root.`);
  }

  if (role === "public" && rootRoutes.length === 1) {
    const routeEntries = [...rootRoutes[0].value.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
    const customDomains: string[] = [];
    for (const entry of routeEntries) {
      const pattern = unquote(entry.match(/(?:^|,)\s*pattern\s*=\s*("[^"]*")/)?.[1]);
      const isCustomDomain = entry.match(/(?:^|,)\s*custom_domain\s*=\s*(true|false)/)?.[1] === "true";
      if (!pattern) {
        issues.push("Every root routes entry must declare a string pattern.");
      } else if (!isCustomDomain) {
        issues.push(`Route ${pattern} must set custom_domain = true.`);
      } else {
        customDomains.push(pattern);
      }
    }

    const actualDomains = [...customDomains].sort();
    if (JSON.stringify(actualDomains) !== JSON.stringify(EXPECTED_CUSTOM_DOMAINS)) {
      issues.push(
        `Root custom domains must be exactly ${EXPECTED_CUSTOM_DOMAINS.join(", ")}; found ${actualDomains.join(", ") || "none"}.`,
      );
    }
  }

  const ruleSections: TomlAssignment[][] = [];
  let currentRule: TomlAssignment[] | undefined;
  for (const assignment of assignments) {
    if (assignment.section !== "rules") continue;
    if (assignment.key === "type") {
      currentRule = [];
      ruleSections.push(currentRule);
    }
    currentRule?.push(assignment);
  }

  const ruleTypes: string[] = [];
  for (const rule of ruleSections) {
    const type = unquote(rule.find(({ key }) => key === "type")?.value);
    if (type) ruleTypes.push(type);
    if (!type) {
      issues.push("Every [[rules]] entry must declare a string type.");
      continue;
    }
    const expectedGlob = EXPECTED_RULE_GLOBS[type];
    const globs = rule.find(({ key }) => key === "globs")?.value.match(/^\[\s*(["'])([^"']*)\1\s*,?\s*\]$/);
    if (expectedGlob && globs?.[2] !== expectedGlob) {
      issues.push(`[[rules]] entry ${type} must set globs = ["${expectedGlob}"].`);
    }
    const fallthrough = rule.find(({ key }) => key === "fallthrough")?.value.trim();
    if (fallthrough !== "true") {
      issues.push(`[[rules]] entry ${type} must set fallthrough = true.`);
    }
  }

  const actualRuleTypes = [...ruleTypes].sort();
  if (JSON.stringify(actualRuleTypes) !== JSON.stringify(EXPECTED_RULE_TYPES)) {
    issues.push(
      `Asset rules must be exactly ${EXPECTED_RULE_TYPES.join(", ")}; found ${actualRuleTypes.join(", ") || "none"}.`,
    );
  }

  const addressPriceProviderVars = assignments.filter(
    ({ key, section }) => key === "ADDRESS_PRICE_PROVIDERS_ENABLED" && section === "vars",
  );
  const configuredAddressPriceProviderSetting = unquote(addressPriceProviderVars[0]?.value)?.trim();
  if (
    role === "public" && (
      addressPriceProviderVars.length !== 1 ||
      configuredAddressPriceProviderSetting !== EXPECTED_ADDRESS_PRICE_PROVIDER_SETTING
    )
  ) {
    issues.push(
      `Production address-price providers must be exactly ADDRESS_PRICE_PROVIDERS_ENABLED="${EXPECTED_ADDRESS_PRICE_PROVIDER_SETTING}"; ` +
      `found ${configuredAddressPriceProviderSetting || "unset"}.`,
    );
  }

  return { failed: issues.length > 0, issues };
}

export function printWorkerWranglerConfigReport(report: WorkerWranglerConfigReport): void {
  if (!report.failed) {
    console.log(
      "Worker Wrangler configuration check passed (public/heavy ownership, bindings and runtime limits aligned).",
    );
    return;
  }

  console.error("Worker Wrangler configuration is unsafe:");
  for (const issue of report.issues) console.error(`  - ${issue}`);
}

export function checkWorkerWranglerConfig(
  publicPath = resolve(process.cwd(), "worker/wrangler.toml"),
  heavyPath = resolve(process.cwd(), "worker/wrangler.heavy.toml"),
): WorkerWranglerConfigReport {
  const publicToml = readFileSync(publicPath, "utf8");
  const heavyToml = readFileSync(heavyPath, "utf8");
  const publicReport = evaluateWorkerWranglerConfig(publicToml);
  const heavyReport = evaluateWorkerWranglerConfig(heavyToml, { workerRole: "heavy" });
  const issues = [...publicReport.issues, ...heavyReport.issues];
  const publicValues = buildAssignmentMap(parseAssignments(publicToml));
  const heavyValues = buildAssignmentMap(parseAssignments(heavyToml));
  for (const { section, key } of PAIRED_RUNTIME_FIELDS) {
    const field = assignmentKey(section, key);
    if (publicValues.get(field) !== heavyValues.get(field)) issues.push(`Paired runtime configuration differs at ${field}.`);
  }
  return { failed: issues.length > 0, issues };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  const report = checkWorkerWranglerConfig();
  printWorkerWranglerConfigReport(report);
  if (report.failed) process.exitCode = 1;
}
