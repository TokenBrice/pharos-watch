import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const EXPECTED_CUSTOM_DOMAINS = ["api.pharos.watch", "ops-api.pharos.watch", "site-api.pharos.watch"] as const;
const EXPECTED_RULE_TYPES = ["CompiledWasm", "Data"] as const;
const EXPECTED_ADDRESS_PRICE_PROVIDER_SETTING = "coingecko-onchain-address";
const WORKER_INFRASTRUCTURE_DOC_PATH = "docs/worker-infrastructure.md";
const RUNTIME_DOCUMENTED_FIELDS = [
  { section: "root", key: "compatibility_date", label: "compatibility_date" },
  { section: "root", key: "compatibility_flags", label: "compatibility_flags" },
  { section: "root", key: "preview_urls", label: "preview_urls" },
  { section: "limits", key: "cpu_ms", label: "[limits].cpu_ms" },
  { section: "observability", key: "enabled", label: "[observability].enabled" },
  { section: "observability", key: "head_sampling_rate", label: "[observability].head_sampling_rate" },
  { section: "observability.logs", key: "enabled", label: "[observability.logs].enabled" },
  { section: "observability.logs", key: "invocation_logs", label: "[observability.logs].invocation_logs" },
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

interface RuntimeDocsCheckOptions {
  workerInfrastructureDoc?: string;
}

function stripTomlComment(line: string): string {
  let inString = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (character === "\"") {
      inString = !inString;
      continue;
    }
    if (!inString && character === "#") {
      return line.slice(0, index);
    }
  }

  return line;
}

function countBracketDelta(value: string): number {
  let delta = 0;
  let inString = false;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && (character === "[" || character === "{")) delta += 1;
    if (!inString && (character === "]" || character === "}")) delta -= 1;
  }

  return delta;
}

function parseAssignments(toml: string): TomlAssignment[] {
  const assignments: TomlAssignment[] = [];
  const lines = toml.split(/\r?\n/);
  let section = "root";

  for (let index = 0; index < lines.length; index += 1) {
    const uncommented = stripTomlComment(lines[index]);
    const trimmed = uncommented.trim();
    const arrayTable = trimmed.startsWith("[[");
    const tableStart = arrayTable ? 2 : trimmed.startsWith("[") ? 1 : 0;
    const tableTerminator = arrayTable ? "]]" : "]";
    const tableEnd = tableStart > 0 ? trimmed.indexOf(tableTerminator, tableStart) : -1;
    const trailingTableText = tableEnd >= 0 ? trimmed.slice(tableEnd + tableTerminator.length).trim() : "";
    if (tableEnd >= 0 && (!trailingTableText || trailingTableText.startsWith("#"))) {
      section = trimmed.slice(tableStart, tableEnd).trim();
      continue;
    }

    const assignmentMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!assignmentMatch) continue;

    const [, key] = assignmentMatch;
    let value = assignmentMatch[2];
    value = stripTomlComment(value).trim();
    let bracketDepth = countBracketDelta(value);
    while (bracketDepth > 0 && index + 1 < lines.length) {
      index += 1;
      const nextLine = stripTomlComment(lines[index]);
      value += `\n${nextLine.trim()}`;
      bracketDepth += countBracketDelta(nextLine);
    }
    assignments.push({ key, section, value });
  }

  return assignments;
}

function unquote(value: string | undefined): string | undefined {
  return value?.trim().match(/^"([^"]*)"/)?.[1];
}

function assignmentKey(section: string, key: string): string {
  return `${section}\0${key}`;
}

function buildAssignmentMap(assignments: TomlAssignment[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const assignment of assignments) {
    map.set(assignmentKey(assignment.section, assignment.key), assignment.value.trim());
  }
  return map;
}

function normalizeDocumentedTomlValue(value: string | undefined): string | undefined {
  return value?.replace(/\s+/g, " ").trim();
}

function extractRuntimeLimitsTomlSnippet(markdown: string): string | null {
  const heading = "## Runtime Limits and Observability";
  const start = markdown.indexOf(heading);
  if (start < 0) return null;
  const nextHeading = markdown.indexOf("\n## ", start + heading.length);
  const section = markdown.slice(start, nextHeading < 0 ? markdown.length : nextHeading);
  const match = section.match(/```toml\s*\n([\s\S]*?)\n```/);
  return match?.[1] ?? null;
}

function addRuntimeDocsIssues(
  issues: string[],
  tomlAssignments: TomlAssignment[],
  workerInfrastructureDoc: string,
): void {
  const snippet = extractRuntimeLimitsTomlSnippet(workerInfrastructureDoc);
  if (snippet === null) {
    issues.push(`${WORKER_INFRASTRUCTURE_DOC_PATH} must include a toml runtime limits snippet.`);
    return;
  }

  const configByKey = buildAssignmentMap(tomlAssignments);
  const docsByKey = buildAssignmentMap(parseAssignments(snippet));
  for (const field of RUNTIME_DOCUMENTED_FIELDS) {
    const key = assignmentKey(field.section, field.key);
    const expected = normalizeDocumentedTomlValue(configByKey.get(key));
    const documented = normalizeDocumentedTomlValue(docsByKey.get(key));
    if (expected === undefined) {
      issues.push(`worker/wrangler.toml must declare ${field.label}.`);
    } else if (documented === undefined) {
      issues.push(`${WORKER_INFRASTRUCTURE_DOC_PATH} runtime snippet must declare ${field.label}.`);
    } else if (documented !== expected) {
      issues.push(
        `${WORKER_INFRASTRUCTURE_DOC_PATH} runtime snippet must document ${field.label} = ${expected}; found ${documented}.`,
      );
    }
  }
}

export function evaluateWorkerWranglerConfig(
  toml: string,
  options: RuntimeDocsCheckOptions = {},
): WorkerWranglerConfigReport {
  const assignments = parseAssignments(toml);
  const issues: string[] = [];
  const routes = assignments.filter(({ key }) => key === "routes");
  const rootRoutes = routes.filter(({ section }) => section === "root");
  const nestedRoutes = routes.filter(({ section }) => section !== "root");

  if (rootRoutes.length !== 1) {
    issues.push(`Expected exactly one root routes assignment before any table; found ${rootRoutes.length}.`);
  }
  for (const route of nestedRoutes) {
    issues.push(`routes is owned by [${route.section}] instead of the Wrangler root.`);
  }

  if (rootRoutes.length === 1) {
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
    addressPriceProviderVars.length !== 1 ||
    configuredAddressPriceProviderSetting !== EXPECTED_ADDRESS_PRICE_PROVIDER_SETTING
  ) {
    issues.push(
      `Production address-price providers must be exactly ADDRESS_PRICE_PROVIDERS_ENABLED="${EXPECTED_ADDRESS_PRICE_PROVIDER_SETTING}"; ` +
      `found ${configuredAddressPriceProviderSetting || "unset"}.`,
    );
  }

  if (options.workerInfrastructureDoc !== undefined) {
    addRuntimeDocsIssues(issues, assignments, options.workerInfrastructureDoc);
  }

  return { failed: issues.length > 0, issues };
}

export function printWorkerWranglerConfigReport(report: WorkerWranglerConfigReport): void {
  if (!report.failed) {
    console.log(
      "Worker Wrangler configuration check passed (3 root custom domains, 2 fallthrough asset rules, address-price providers pinned to coingecko-onchain-address, runtime docs aligned).",
    );
    return;
  }

  console.error("Worker Wrangler configuration is unsafe:");
  for (const issue of report.issues) console.error(`  - ${issue}`);
}

export function checkWorkerWranglerConfig(
  path = resolve(process.cwd(), "worker/wrangler.toml"),
): WorkerWranglerConfigReport {
  return evaluateWorkerWranglerConfig(readFileSync(path, "utf8"), {
    workerInfrastructureDoc: readFileSync(resolve(process.cwd(), WORKER_INFRASTRUCTURE_DOC_PATH), "utf8"),
  });
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  const report = checkWorkerWranglerConfig();
  printWorkerWranglerConfigReport(report);
  if (report.failed) process.exitCode = 1;
}
