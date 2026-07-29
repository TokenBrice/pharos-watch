#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { isDirectRun } from "../lib/smoke-runtime.mjs";

const registryUrl = new URL("./dependency-audit-exceptions.json", import.meta.url);

export const DEPENDENCY_AUDIT_EXCEPTION_REGISTRY = JSON.parse(readFileSync(registryUrl, "utf8"));

function isHighOrCritical(vulnerability) {
  return vulnerability?.severity === "high" || vulnerability?.severity === "critical";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedUniqueStrings(value, fieldName) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`Dependency-audit exception ${fieldName} must be a non-empty string array.`);
  }
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new Error(`Dependency-audit exception ${fieldName} must not contain duplicates.`);
  }
  return sorted;
}

function validateExpiration(expiresOn, now) {
  if (typeof expiresOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) {
    throw new Error("Dependency-audit exception expiresOn must be an ISO calendar date.");
  }
  const date = new Date(`${expiresOn}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== expiresOn) {
    throw new Error("Dependency-audit exception expiresOn must be a valid ISO calendar date.");
  }
  if (now.toISOString().slice(0, 10) > expiresOn) {
    throw new Error(`Dependency-audit exception expired on ${expiresOn}.`);
  }
}

function validateRegistry(registry, now) {
  if (!isObject(registry) || registry.version !== 1 || !Array.isArray(registry.exceptions)) {
    throw new Error("Dependency-audit exception registry must declare version 1 and an exceptions array.");
  }

  const exceptionKeys = new Set();
  return registry.exceptions.map((exception) => {
    if (
      !isObject(exception) ||
      typeof exception.advisoryId !== "string" ||
      typeof exception.source !== "number" ||
      typeof exception.dependency !== "string" ||
      (exception.severity !== "high" && exception.severity !== "critical") ||
      typeof exception.range !== "string"
    ) {
      throw new Error("Dependency-audit exception has an invalid advisory identity.");
    }
    validateExpiration(exception.expiresOn, now);

    const key = `${exception.advisoryId}:${exception.dependency}`;
    if (exceptionKeys.has(key)) {
      throw new Error(`Dependency-audit exception registry duplicates ${key}.`);
    }
    exceptionKeys.add(key);

    return {
      ...exception,
      affectedPackages: sortedUniqueStrings(exception.affectedPackages, "affectedPackages"),
      nodes: sortedUniqueStrings(exception.nodes, "nodes"),
    };
  });
}

function hasExactNodes(vulnerability, exception) {
  const nodes = Array.isArray(vulnerability.nodes) ? [...vulnerability.nodes].sort() : [];
  return nodes.length === exception.nodes.length && nodes.every((node, index) => node === exception.nodes[index]);
}

function isExactDirectAdvisory(via, exception) {
  return (
    isObject(via) &&
    via.source === exception.source &&
    via.name === exception.dependency &&
    via.dependency === exception.dependency &&
    via.severity === exception.severity &&
    via.range === exception.range &&
    typeof via.url === "string" &&
    via.url.endsWith(`/advisories/${exception.advisoryId}`)
  );
}

function findMatchingException(name, vulnerability, exceptions) {
  if (!Array.isArray(vulnerability.via) || vulnerability.via.length !== 1) return undefined;
  return exceptions.find(
    (exception) =>
      exception.dependency === name &&
      vulnerability.severity === exception.severity &&
      hasExactNodes(vulnerability, exception) &&
      isExactDirectAdvisory(vulnerability.via[0], exception),
  );
}

function reachableVulnerabilities(rootNames, vulnerabilities) {
  const reachable = new Set(rootNames);
  const pending = [...rootNames];

  while (pending.length > 0) {
    const name = pending.pop();
    const effects = vulnerabilities[name]?.effects;
    if (!Array.isArray(effects)) continue;
    for (const effect of effects) {
      if (typeof effect !== "string" || !isHighOrCritical(vulnerabilities[effect]) || reachable.has(effect)) continue;
      reachable.add(effect);
      pending.push(effect);
    }
  }

  return reachable;
}

/**
 * Accepts only the reviewed high/critical advisory graph. Registry mistakes,
 * changed paths, direct advisories, and expiry all throw rather than waive risk.
 */
export function verifyDependencyAuditReport(
  report,
  { registry = DEPENDENCY_AUDIT_EXCEPTION_REGISTRY, now = new Date() } = {},
) {
  const exceptions = validateRegistry(registry, now);
  if (!isObject(report) || !isObject(report.vulnerabilities)) {
    throw new Error("npm audit did not return a valid audit report.");
  }

  const highVulnerabilities = Object.fromEntries(
    Object.entries(report.vulnerabilities).filter(([, vulnerability]) => isHighOrCritical(vulnerability)),
  );
  const matchedExceptions = new Map();

  for (const [name, vulnerability] of Object.entries(highVulnerabilities)) {
    const directAdvisories = Array.isArray(vulnerability.via)
      ? vulnerability.via.filter((via) => isObject(via))
      : [];
    if (directAdvisories.length === 0) continue;

    const exception = findMatchingException(name, vulnerability, exceptions);
    if (!exception) {
      throw new Error(`Unreviewed high/critical advisory affects ${name}.`);
    }
    matchedExceptions.set(name, exception);
  }

  const reachable = reachableVulnerabilities([...matchedExceptions.keys()], highVulnerabilities);
  for (const [name, vulnerability] of Object.entries(highVulnerabilities)) {
    const exception = matchedExceptions.get(name);
    if (exception) continue;

    if (!reachable.has(name)) {
      throw new Error(`Unreviewed high/critical vulnerability affects ${name}.`);
    }
    if (!Array.isArray(vulnerability.via) || vulnerability.via.some((via) => typeof via !== "string")) {
      throw new Error(`Unreviewed high/critical advisory affects ${name}.`);
    }
  }

  for (const exception of matchedExceptions.values()) {
    const allowedPackages = new Set(exception.affectedPackages);
    for (const name of reachable) {
      if (!allowedPackages.has(name)) {
        throw new Error(`Accepted ${exception.advisoryId} reached unreviewed package ${name}.`);
      }
    }
  }

  return {
    acceptedExceptionIds: [...new Set([...matchedExceptions.values()].map(({ advisoryId }) => advisoryId))].sort(),
  };
}

export function runFullLockfileDependencyAudit({
  env = process.env,
  now = new Date(),
  registry = DEPENDENCY_AUDIT_EXCEPTION_REGISTRY,
  spawn = spawnSync,
} = {}) {
  const result = spawn("npm", ["audit", "--json", "--audit-level=high"], { encoding: "utf8", env });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`npm audit exited unexpectedly with status ${result.status ?? "unknown"}.`);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error("npm audit did not emit JSON.");
  }
  return verifyDependencyAuditReport(report, { now, registry });
}

function runCli() {
  try {
    const { acceptedExceptionIds } = runFullLockfileDependencyAudit();
    const accepted = acceptedExceptionIds.length > 0 ? acceptedExceptionIds.join(", ") : "none";
    console.log(`[dependency-audit] accepted exceptions: ${accepted}`);
  } catch (error) {
    console.error(`[dependency-audit] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCli();
}
