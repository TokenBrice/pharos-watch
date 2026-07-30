#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const API_BASE_URL = "https://api.cloudflare.com/client/v4";
const API_TOKEN_ENV = "CLOUDFLARE_ACCOUNT_STATE_DRIFT_API_TOKEN";
const MANIFEST_PATH = "scripts/ci/cloudflare-account-state-manifest.json";
const REQUEST_TIMEOUT_MS = 30_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeExpression(value) {
  return normalizeString(value).replaceAll(/\s+/g, " ");
}

function sortedStrings(values) {
  return asArray(values)
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .sort();
}

function sameStrings(left, right) {
  return JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));
}

function addValueDrift(drift, path, expected, actual) {
  if (expected !== actual) {
    drift.push(`${path}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
  }
}

function addRequiredStringDrift(drift, path, expected, actualValues) {
  if (!sortedStrings(actualValues).includes(expected)) {
    drift.push(`${path}: missing ${JSON.stringify(expected)}`);
  }
}

/**
 * Compare normalized, secret-free Cloudflare account state against the committed manifest.
 * The live-state shape intentionally excludes environment-variable values and all resource IDs.
 */
export function compareCloudflareAccountState(manifest, liveState) {
  const drift = [];
  const zone = isRecord(liveState?.zone) ? liveState.zone : {};
  addValueDrift(drift, "zone.name", manifest.zone.name, zone.name);
  addValueDrift(drift, "zone.status", manifest.zone.status, zone.status);

  const pages = isRecord(liveState?.pages) ? liveState.pages : {};
  const project = isRecord(pages.project) ? pages.project : {};
  addValueDrift(drift, "pages.project.name", manifest.pages.project, project.name);
  for (const domain of manifest.pages.customDomains) {
    addRequiredStringDrift(drift, "pages.customDomains", domain, pages.customDomains);
  }

  const production = isRecord(project.production) ? project.production : {};
  const environmentVariables = isRecord(production.environmentVariables) ? production.environmentVariables : {};
  for (const expected of manifest.pages.production.requiredEnvironmentVariables) {
    const actual = isRecord(environmentVariables[expected.name]) ? environmentVariables[expected.name] : null;
    if (actual === null) {
      drift.push(`pages.production.environmentVariables.${expected.name}: missing`);
      continue;
    }
    addValueDrift(
      drift,
      `pages.production.environmentVariables.${expected.name}.type`,
      expected.type,
      actual.type,
    );
    if (Object.hasOwn(expected, "value")) {
      addValueDrift(
        drift,
        `pages.production.environmentVariables.${expected.name}.value`,
        expected.value,
        actual.value,
      );
    }
  }
  for (const binding of manifest.pages.production.requiredD1Bindings) {
    addRequiredStringDrift(drift, "pages.production.d1Bindings", binding, production.d1Bindings);
  }
  for (const binding of manifest.pages.production.requiredKvBindings) {
    addRequiredStringDrift(drift, "pages.production.kvBindings", binding, production.kvBindings);
  }

  const accessApplications = asArray(liveState?.accessApplications);
  for (const expected of manifest.accessApplications) {
    const matchingApplications = accessApplications.filter(
      (application) =>
        isRecord(application) &&
        application.type === expected.type &&
        sameStrings(application.selfHostedDomains, expected.selfHostedDomains),
    );
    if (matchingApplications.length !== 1) {
      const noun = matchingApplications.length === 0 ? "missing" : `expected one, found ${matchingApplications.length}`;
      drift.push(`accessApplications.${expected.key}: ${noun} ${expected.type} application for ${expected.selfHostedDomains.join(", ")}`);
      continue;
    }
    const actual = matchingApplications[0];
    if (!actual) {
      drift.push(`accessApplications.${expected.key}: missing ${expected.type} application for ${expected.selfHostedDomains.join(", ")}`);
      continue;
    }
    if (Object.hasOwn(expected, "sessionDuration")) {
      addValueDrift(
        drift,
        `accessApplications.${expected.key}.sessionDuration`,
        expected.sessionDuration,
        actual.sessionDuration,
      );
    }
  }

  const workerDomains = asArray(liveState?.workerDomains);
  for (const hostname of manifest.workerCustomDomains.hostnames) {
    const actual = workerDomains.find((domain) => isRecord(domain) && domain.hostname === hostname);
    if (!actual) {
      drift.push(`workerCustomDomains.${hostname}: missing`);
      continue;
    }
    addValueDrift(drift, `workerCustomDomains.${hostname}.service`, manifest.workerCustomDomains.service, actual.service);
  }

  const rateLimitRules = asArray(liveState?.rateLimitRules);
  for (const expected of manifest.rateLimitRules) {
    const matchingRules = rateLimitRules.filter((rule) => isRecord(rule) && rule.description === expected.description);
    if (matchingRules.length !== 1) {
      drift.push(
        `rateLimitRules.${expected.description}: ${matchingRules.length === 0 ? "missing" : `expected one, found ${matchingRules.length}`}`,
      );
      continue;
    }
    const actual = matchingRules[0];
    addValueDrift(drift, `rateLimitRules.${expected.description}.enabled`, expected.enabled, actual.enabled);
    addValueDrift(drift, `rateLimitRules.${expected.description}.action`, expected.action, actual.action);
    addValueDrift(
      drift,
      `rateLimitRules.${expected.description}.expression`,
      normalizeExpression(expected.expression),
      normalizeExpression(actual.expression),
    );
    const actualRateLimit = isRecord(actual.ratelimit) ? actual.ratelimit : {};
    if (!sameStrings(expected.ratelimit.characteristics, actualRateLimit.characteristics)) {
      drift.push(
        `rateLimitRules.${expected.description}.ratelimit.characteristics: expected ${JSON.stringify(sortedStrings(expected.ratelimit.characteristics))}, found ${JSON.stringify(sortedStrings(actualRateLimit.characteristics))}`,
      );
    }
    addValueDrift(
      drift,
      `rateLimitRules.${expected.description}.ratelimit.requestsPerPeriod`,
      expected.ratelimit.requestsPerPeriod,
      actualRateLimit.requestsPerPeriod,
    );
    addValueDrift(
      drift,
      `rateLimitRules.${expected.description}.ratelimit.period`,
      expected.ratelimit.period,
      actualRateLimit.period,
    );
    addValueDrift(
      drift,
      `rateLimitRules.${expected.description}.ratelimit.mitigationTimeout`,
      expected.ratelimit.mitigationTimeout,
      actualRateLimit.mitigationTimeout,
    );
  }

  const ruleIndexes = new Map(
    rateLimitRules.map((rule, index) => [isRecord(rule) ? rule.description : undefined, index]),
  );
  for (const [before, after] of manifest.rateLimitOrdering) {
    const beforeIndex = ruleIndexes.get(before);
    const afterIndex = ruleIndexes.get(after);
    if (typeof beforeIndex === "number" && typeof afterIndex === "number" && beforeIndex >= afterIndex) {
      drift.push(`rateLimitOrdering: ${before} must be evaluated before ${after}`);
    }
  }

  return drift;
}

async function readCloudflareResult(fetchImpl, apiToken, path, operation, { allowNotFound = false } = {}) {
  const response = await fetchImpl(new URL(path.replace(/^\//, ""), `${API_BASE_URL}/`), {
    method: "GET",
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (allowNotFound && response.status === 404) return null;

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${operation} returned an unparseable response (HTTP ${response.status})`);
  }
  const errors = asArray(payload?.errors)
    .map((error) => (isRecord(error) ? normalizeString(error.message) : ""))
    .filter(Boolean)
    .join("; ");
  if (!response.ok || payload?.success !== true) {
    throw new Error(`${operation} failed (HTTP ${response.status})${errors ? `: ${errors}` : ""}`);
  }
  return payload.result;
}

function normalizePagesEnvironmentVariables(value) {
  const variables = isRecord(value) ? value : {};
  return Object.fromEntries(
    Object.entries(variables)
      .filter(([, variable]) => isRecord(variable))
      .map(([name, variable]) => {
        const normalized = { type: normalizeString(variable.type) };
        if (variable.type === "plain_text" && typeof variable.value === "string") {
          normalized.value = variable.value;
        }
        return [name, normalized];
      }),
  );
}

function normalizePagesDomains(value) {
  return asArray(value)
    .map((domain) => (typeof domain === "string" ? domain : isRecord(domain) ? domain.name : undefined))
    .filter((domain) => typeof domain === "string");
}

function normalizeAccessApplications(value) {
  return asArray(value).map((application) => ({
    type: normalizeString(application?.type),
    selfHostedDomains: sortedStrings(application?.self_hosted_domains),
    sessionDuration: normalizeString(application?.session_duration),
  }));
}

function normalizeWorkerDomains(value) {
  return asArray(value).map((domain) => ({
    hostname: normalizeString(domain?.hostname),
    service: normalizeString(domain?.service),
  }));
}

function normalizeRateLimitRules(value) {
  return asArray(value).map((rule) => ({
    description: normalizeString(rule?.description),
    enabled: rule?.enabled !== false,
    action: normalizeString(rule?.action),
    expression: normalizeExpression(rule?.expression),
    ratelimit: {
      characteristics: sortedStrings(rule?.ratelimit?.characteristics),
      requestsPerPeriod: rule?.ratelimit?.requests_per_period,
      period: rule?.ratelimit?.period,
      mitigationTimeout: rule?.ratelimit?.mitigation_timeout,
    },
  }));
}

/**
 * Fetch Cloudflare state using only GET requests, then discard IDs and secret values before comparison.
 */
export async function fetchCloudflareAccountState({ manifest, apiToken, fetchImpl = fetch }) {
  const zones = asArray(
    await readCloudflareResult(
      fetchImpl,
      apiToken,
      `/zones?name=${encodeURIComponent(manifest.zone.name)}&status=${encodeURIComponent(manifest.zone.status)}&per_page=5`,
      "Cloudflare zone lookup",
    ),
  );
  const exactZones = zones.filter(
    (candidate) =>
      isRecord(candidate) &&
      candidate.name === manifest.zone.name &&
      candidate.status === manifest.zone.status &&
      typeof candidate.id === "string" &&
      typeof candidate.account?.id === "string",
  );
  if (exactZones.length !== 1) {
    throw new Error(
      `Cloudflare zone lookup returned ${exactZones.length} exact active matches for ${manifest.zone.name}; refusing to compare account state.`,
    );
  }
  const zone = exactZones[0];

  const accountId = zone.account.id;
  const zoneId = zone.id;
  const projectPath = `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(manifest.pages.project)}`;
  const [project, pageDomains, accessApplications, workerDomains, rateLimitRuleset] = await Promise.all([
    readCloudflareResult(fetchImpl, apiToken, projectPath, "Cloudflare Pages project lookup"),
    readCloudflareResult(fetchImpl, apiToken, `${projectPath}/domains`, "Cloudflare Pages domain lookup"),
    readCloudflareResult(
      fetchImpl,
      apiToken,
      `/accounts/${encodeURIComponent(accountId)}/access/apps?per_page=1000`,
      "Cloudflare Access application lookup",
    ),
    readCloudflareResult(
      fetchImpl,
      apiToken,
      `/accounts/${encodeURIComponent(accountId)}/workers/domains`,
      "Cloudflare Worker domain lookup",
    ),
    readCloudflareResult(
      fetchImpl,
      apiToken,
      `/zones/${encodeURIComponent(zoneId)}/rulesets/phases/http_ratelimit/entrypoint`,
      "Cloudflare rate-limit ruleset lookup",
      { allowNotFound: true },
    ),
  ]);
  const production = isRecord(project?.deployment_configs?.production) ? project.deployment_configs.production : {};

  return {
    zone: {
      name: normalizeString(zone.name),
      status: normalizeString(zone.status),
    },
    pages: {
      project: {
        name: normalizeString(project?.name),
        production: {
          environmentVariables: normalizePagesEnvironmentVariables(production.env_vars),
          d1Bindings: Object.keys(isRecord(production.d1_databases) ? production.d1_databases : {}),
          kvBindings: Object.keys(isRecord(production.kv_namespaces) ? production.kv_namespaces : {}),
        },
      },
      customDomains: normalizePagesDomains(pageDomains),
    },
    accessApplications: normalizeAccessApplications(accessApplications),
    workerDomains: normalizeWorkerDomains(workerDomains),
    rateLimitRules: normalizeRateLimitRules(rateLimitRuleset?.rules),
  };
}

export function loadCloudflareAccountStateManifest(path = resolve(process.cwd(), MANIFEST_PATH)) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function runCloudflareAccountStateDriftCheck({
  env = process.env,
  fetchImpl = fetch,
  manifest = loadCloudflareAccountStateManifest(),
  consoleImpl = console,
} = {}) {
  const apiToken = normalizeString(env[API_TOKEN_ENV]);
  if (!apiToken) {
    throw new Error(`${API_TOKEN_ENV} is required; configure the repository secret of the same name.`);
  }

  const liveState = await fetchCloudflareAccountState({ manifest, apiToken, fetchImpl });
  const drift = compareCloudflareAccountState(manifest, liveState);
  if (drift.length > 0) {
    consoleImpl.error("Cloudflare account-state drift detected:");
    for (const issue of drift) consoleImpl.error(`  - ${issue}`);
    return { ok: false, drift };
  }
  consoleImpl.log("Cloudflare account-state drift check passed (read-only; no resource IDs or secret values reported).");
  return { ok: true, drift: [] };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  try {
    const report = await runCloudflareAccountStateDriftCheck();
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`[cloudflare-account-state-drift] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
