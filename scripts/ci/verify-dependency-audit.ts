#!/usr/bin/env node

import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { CliUsageError, parseStrictCliArgs } from "../lib/cli-args.mjs";

const registryUrl: URL = new URL("./dependency-audit-exceptions.json", import.meta.url);

type Severity = "high" | "critical";

interface AuditException {
  advisoryId: string;
  affectedPackages: string[];
  dependency: string;
  expiresOn: string;
  nodes: string[];
  range: string;
  severity: Severity;
  source: number;
  [key: string]: unknown;
}

interface AuditVulnerability extends Record<string, unknown> {
  effects?: unknown;
  nodes?: unknown;
  severity: Severity;
  via?: unknown;
}

interface DependencyAuditResult {
  acceptedExceptionIds: string[];
}

type AuditSpawn = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export const DEPENDENCY_AUDIT_EXCEPTION_REGISTRY: unknown = JSON.parse(readFileSync(registryUrl, "utf8"));

function isHighOrCritical(vulnerability: unknown): vulnerability is AuditVulnerability {
  return (
    isObject(vulnerability) &&
    (vulnerability.severity === "high" || vulnerability.severity === "critical")
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedUniqueStrings(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`Dependency-audit exception ${fieldName} must be a non-empty string array.`);
  }
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new Error(`Dependency-audit exception ${fieldName} must not contain duplicates.`);
  }
  return sorted;
}

function validateExpiration(expiresOn: unknown, now: Date): asserts expiresOn is string {
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

function validateRegistry(registry: unknown, now: Date): AuditException[] {
  if (!isObject(registry) || registry.version !== 1 || !Array.isArray(registry.exceptions)) {
    throw new Error("Dependency-audit exception registry must declare version 1 and an exceptions array.");
  }

  const exceptionKeys = new Set<string>();
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
      advisoryId: exception.advisoryId,
      affectedPackages: sortedUniqueStrings(exception.affectedPackages, "affectedPackages"),
      dependency: exception.dependency,
      expiresOn: exception.expiresOn,
      nodes: sortedUniqueStrings(exception.nodes, "nodes"),
      range: exception.range,
      severity: exception.severity,
      source: exception.source,
    };
  });
}

function hasExactNodes(vulnerability: AuditVulnerability, exception: AuditException): boolean {
  const nodes = Array.isArray(vulnerability.nodes) ? [...vulnerability.nodes].sort() : [];
  return nodes.length === exception.nodes.length && nodes.every((node, index) => node === exception.nodes[index]);
}

function isExactDirectAdvisory(via: unknown, exception: AuditException): boolean {
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

function findMatchingException(
  name: string,
  vulnerability: AuditVulnerability,
  exceptions: readonly AuditException[],
): AuditException | undefined {
  if (!Array.isArray(vulnerability.via) || vulnerability.via.length !== 1) return undefined;
  const [directAdvisory] = vulnerability.via;
  return exceptions.find(
    (exception) =>
      exception.dependency === name &&
      vulnerability.severity === exception.severity &&
      hasExactNodes(vulnerability, exception) &&
      isExactDirectAdvisory(directAdvisory, exception),
  );
}

function reachableVulnerabilities(
  rootNames: readonly string[],
  vulnerabilities: Record<string, AuditVulnerability>,
): Set<string> {
  const reachable = new Set(rootNames);
  const pending = [...rootNames];

  while (pending.length > 0) {
    const name = pending.pop();
    if (!name) continue;
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
  report: unknown,
  { registry = DEPENDENCY_AUDIT_EXCEPTION_REGISTRY, now = new Date() }: { registry?: unknown; now?: Date } = {},
): DependencyAuditResult {
  const exceptions = validateRegistry(registry, now);
  if (!isObject(report) || !isObject(report.vulnerabilities)) {
    throw new Error("npm audit did not return a valid audit report.");
  }

  const highVulnerabilities = Object.fromEntries(
    Object.entries(report.vulnerabilities).filter(([, vulnerability]) => isHighOrCritical(vulnerability)),
  ) as Record<string, AuditVulnerability>;
  const matchedExceptions = new Map<string, AuditException>();

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
    for (const name of reachableVulnerabilities([exception.dependency], highVulnerabilities)) {
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
  spawn = spawnSync as AuditSpawn,
}: {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  registry?: unknown;
  spawn?: AuditSpawn;
} = {}): DependencyAuditResult {
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

interface AdvisoryPackagePair {
  advisoryId: string;
  package: string;
}

function collectAdvisoryPackagePairs(report: unknown): Map<string, AdvisoryPackagePair> {
  if (!isObject(report) || !isObject(report.vulnerabilities) || report.error) {
    throw new Error("npm audit did not return a valid audit report.");
  }
  const vulnerabilities = report.vulnerabilities;
  const pairs = new Map<string, AdvisoryPackagePair>();
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    if (!isHighOrCritical(vulnerability)) continue;
    const visited = new Set<string>();
    const pending = [name];
    let foundAdvisory = false;
    while (pending.length) {
      const dependency = pending.pop()!;
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      const node = vulnerabilities[dependency];
      if (!isObject(node) || !Array.isArray(node.via) || node.via.length === 0) {
        throw new Error(`npm audit returned an invalid advisory graph for ${name}.`);
      }
      for (const via of node.via) {
        if (typeof via === "string") {
          pending.push(via);
        } else if (isObject(via) && typeof via.url === "string" &&
          /^https:\/\/github\.com\/advisories\/GHSA-[A-Za-z0-9-]+$/.test(via.url)) {
          const advisoryId = via.url.slice(via.url.lastIndexOf("/") + 1);
          pairs.set(JSON.stringify([advisoryId, name]), { advisoryId, package: name });
          foundAdvisory = true;
        } else {
          throw new Error(`npm audit returned an invalid advisory identity for ${name}.`);
        }
      }
    }
    if (!foundAdvisory) throw new Error(`npm audit returned an unresolved advisory graph for ${name}.`);
  }
  return pairs;
}

export function verifyDependencyAuditDelta(
  currentReport: unknown,
  baseReport: unknown,
  { registry = DEPENDENCY_AUDIT_EXCEPTION_REGISTRY, now = new Date() }: { registry?: unknown; now?: Date } = {},
): { preExisting: AdvisoryPackagePair[] } {
  validateRegistry(registry, now);
  const currentPairs = collectAdvisoryPackagePairs(currentReport);
  const basePairs = collectAdvisoryPackagePairs(baseReport);
  const newPairs = [...currentPairs].filter(([key]) => !basePairs.has(key)).map(([, pair]) => pair);
  if (newPairs.length) {
    throw new Error(`New high/critical advisory/package pairs: ${newPairs
      .map((pair) => `${pair.advisoryId} affects ${pair.package}`).sort().join("; ")}.`);
  }
  return {
    preExisting: [...currentPairs.values()].sort((left, right) =>
      left.advisoryId.localeCompare(right.advisoryId) || left.package.localeCompare(right.package)),
  };
}

export function runNewSinceDependencyAudit({
  baseSha,
  cwd = process.cwd(),
  env = process.env,
  now = new Date(),
  registry = DEPENDENCY_AUDIT_EXCEPTION_REGISTRY,
  spawn = spawnSync as AuditSpawn,
  stdout = process.stdout,
}: {
  baseSha: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  registry?: unknown;
  spawn?: AuditSpawn;
  stdout?: { write(chunk: string): unknown };
}): { preExisting: AdvisoryPackagePair[] } {
  if (!/^[a-f0-9]{40}$/i.test(baseSha)) {
    throw new Error("--new-since requires a full base commit SHA; fetch the frozen PR base before auditing.");
  }
  const directory = mkdtempSync(join(tmpdir(), "pharos-base-dependency-audit-"));
  try {
    for (const file of ["package.json", "package-lock.json"]) {
      const result = spawn("git", ["show", `${baseSha}:${file}`], { cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      if (result.error || result.status !== 0) {
        throw new Error(`Cannot read ${file} at base ${baseSha}; fetch the frozen PR base before auditing.`);
      }
      writeFileSync(join(directory, file), result.stdout);
    }
    const reports = [directory, cwd].map((auditCwd) => {
      const result = spawn("npm", ["audit", "--package-lock-only", "--json", "--audit-level=high", "--include=dev"],
        { cwd: auditCwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      if (result.error) throw result.error;
      if (result.status !== 0 && result.status !== 1) {
        throw new Error(`npm audit exited unexpectedly with status ${result.status ?? "unknown"}.`);
      }
      try {
        return JSON.parse(result.stdout) as unknown;
      } catch {
        throw new Error("npm audit did not emit JSON.");
      }
    });
    const delta = verifyDependencyAuditDelta(reports[1], reports[0], { registry, now });
    for (const pair of delta.preExisting) {
      stdout.write(`[dependency-audit] ${pair.advisoryId} affects ${pair.package}: pre-existing, tracked by weekly audit\n`);
    }
    stdout.write(`[dependency-audit] no new high/critical advisory/package pairs since ${baseSha}\n`);
    return delta;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runCli(): void {
  try {
    const { values } = parseStrictCliArgs(process.argv.slice(2), {
      options: { "new-since": { type: "string" } },
    });
    if (values.help) {
      console.log("Usage: verify-dependency-audit.ts [--new-since=<baseSha>]");
      return;
    }
    if (typeof values["new-since"] === "string") {
      runNewSinceDependencyAudit({ baseSha: values["new-since"] });
      return;
    }
    const { acceptedExceptionIds } = runFullLockfileDependencyAudit();
    const accepted = acceptedExceptionIds.length > 0 ? acceptedExceptionIds.join(", ") : "none";
    console.log(`[dependency-audit] accepted exceptions: ${accepted}`);
  } catch (error) {
    console.error(`[dependency-audit] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof CliUsageError ? 2 : 1;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCli();
}
