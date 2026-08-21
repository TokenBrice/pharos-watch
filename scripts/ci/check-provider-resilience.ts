#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { reportViolations } from "../lib/report-violations.mts";
import { collectSourceFiles, runAsCli } from "../lib/source-files.mts";
import {
  PROVIDER_RESILIENCE_REGISTRY,
  REQUIRED_PROVIDER_SURFACE_FAMILIES,
} from "../lib/provider-resilience-registry.mjs";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
const DEFAULT_DIRECT_FETCH_ROOTS = ["worker/src"];
const EXCLUDED_DIRS = new Set(["__tests__", "__mocks__", "test-helpers"]);

interface ProviderResilienceEntry {
  id?: string;
  description?: string;
  family?: string;
  files?: readonly string[];
  tests?: readonly string[];
  requiredMarkers?: readonly string[];
  allowBareFetch?: boolean;
  directFetchJustification?: string;
  resilience?: {
    transport?: string;
    timeout?: string;
    body?: string;
    circuitSources?: readonly string[];
  };
}

interface ProviderViolation {
  kind: string;
  message: string;
  file?: string;
  line?: number;
  text?: string;
  id?: string;
  marker?: string;
  circuitSource?: string;
  family?: string;
}

interface FetchCall {
  file: string;
  line: number;
  text: string;
}

function normalizeRelPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function lineNumberForIndex(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

export function findBareFetchCalls(source: string, file = "<source>"): FetchCall[] {
  const calls: FetchCall[] = [];
  const pattern = /\bfetch\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    const lineStart = source.lastIndexOf("\n", index) + 1;
    const lineEnd = source.indexOf("\n", index);
    const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    const before = line[index - lineStart - 1] ?? "";
    if (before === "." || before === "$" || /[A-Za-z0-9_]/.test(before)) continue;

    const beforeText = line.slice(0, index - lineStart).trim();
    if (beforeText === "async" || beforeText.endsWith(" async") || beforeText.endsWith("function")) continue;

    calls.push({
      file,
      line: lineNumberForIndex(source, index),
      text: trimmed,
    });
  }
  return calls;
}

function readRelFile(cwd: string, relPath: string): string {
  return readFileSync(resolve(cwd, relPath), "utf8");
}

function collectDirectFetchFiles(cwd: string, roots: readonly string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    const rootPath = resolve(cwd, root);
    if (!existsSync(rootPath)) continue;
    files.push(...collectSourceFiles(rootPath, { extensions: SOURCE_EXTENSIONS, excludedDirs: EXCLUDED_DIRS }));
  }
  return files
    .filter((file) => SOURCE_EXTENSIONS.has(extname(file)))
    .map((file) => normalizeRelPath(relative(cwd, file)))
    .sort();
}

function addViolation(
  violations: ProviderViolation[],
  kind: string,
  message: string,
  details: Omit<ProviderViolation, "kind" | "message"> = {},
): void {
  violations.push({ kind, message, ...details });
}

function validateRegistryEntryShape(entry: ProviderResilienceEntry | undefined, violations: ProviderViolation[]): void {
  if (!entry || typeof entry !== "object") {
    addViolation(violations, "invalid-entry", "Registry entry must be an object.");
    return;
  }
  if (typeof entry.id !== "string" || entry.id.length === 0) {
    addViolation(violations, "invalid-entry-id", "Registry entry is missing a non-empty id.");
  }
  if (typeof entry.family !== "string" || entry.family.length === 0) {
    addViolation(violations, "invalid-entry-family", `${entry.id ?? "<unknown>"} is missing a non-empty family.`);
  }
  if (!Array.isArray(entry.files) || entry.files.length === 0) {
    addViolation(violations, "missing-files", `${entry.id ?? "<unknown>"} must list source files.`);
  }
  if (!Array.isArray(entry.tests) || entry.tests.length === 0) {
    addViolation(violations, "missing-tests", `${entry.id ?? "<unknown>"} must list regression tests.`);
  }
  if (!Array.isArray(entry.requiredMarkers) || entry.requiredMarkers.length === 0) {
    addViolation(violations, "missing-required-markers", `${entry.id ?? "<unknown>"} must list source markers.`);
  }
  if (entry.allowBareFetch && (typeof entry.directFetchJustification !== "string" || entry.directFetchJustification.length < 20)) {
    addViolation(violations, "missing-direct-fetch-justification", `${entry.id ?? "<unknown>"} allows bare fetch without a durable justification.`);
  }
  if (!entry.resilience || typeof entry.resilience !== "object") {
    addViolation(violations, "missing-resilience", `${entry.id ?? "<unknown>"} must describe resilience posture.`);
    return;
  }
  for (const key of ["transport", "timeout", "body"] as const) {
    if (typeof entry.resilience[key] !== "string" || entry.resilience[key].length === 0) {
      addViolation(violations, "missing-resilience-field", `${entry.id ?? "<unknown>"} is missing resilience.${key}.`);
    }
  }
  if (!Array.isArray(entry.resilience.circuitSources)) {
    addViolation(violations, "missing-circuit-source-list", `${entry.id ?? "<unknown>"} must set resilience.circuitSources, even when empty.`);
  }
}

export function scanProviderResilience({
  cwd = process.cwd(),
  registry = PROVIDER_RESILIENCE_REGISTRY,
  requiredFamilies = REQUIRED_PROVIDER_SURFACE_FAMILIES,
  directFetchRoots = DEFAULT_DIRECT_FETCH_ROOTS,
}: {
  cwd?: string;
  registry?: readonly ProviderResilienceEntry[];
  requiredFamilies?: readonly string[];
  directFetchRoots?: readonly string[];
} = {}): { entries: number; registeredFiles: number; violations: ProviderViolation[] } {
  const violations: ProviderViolation[] = [];
  const seenIds = new Set<string>();
  const entriesByFile = new Map<string, ProviderResilienceEntry[]>();

  for (const entry of registry) {
    validateRegistryEntryShape(entry, violations);
    if (!entry?.id) continue;

    if (seenIds.has(entry.id)) {
      addViolation(violations, "duplicate-id", `Duplicate provider resilience registry id: ${entry.id}`, { id: entry.id });
    }
    seenIds.add(entry.id);

    let combinedSource = "";
    for (const relPath of entry.files ?? []) {
      const normalized = normalizeRelPath(relPath);
      if (!existsSync(resolve(cwd, normalized))) {
        addViolation(violations, "missing-source-file", `${entry.id} references missing source file ${normalized}`, {
          id: entry.id,
          file: normalized,
        });
        continue;
      }
      combinedSource += `\n/* ${normalized} */\n${readRelFile(cwd, normalized)}`;
      const entries = entriesByFile.get(normalized) ?? [];
      entries.push(entry);
      entriesByFile.set(normalized, entries);
    }

    for (const relPath of entry.tests ?? []) {
      const normalized = normalizeRelPath(relPath);
      if (!existsSync(resolve(cwd, normalized))) {
        addViolation(violations, "missing-test-file", `${entry.id} references missing test file ${normalized}`, {
          id: entry.id,
          file: normalized,
        });
      }
    }

    for (const marker of entry.requiredMarkers ?? []) {
      if (typeof marker !== "string" || marker.length === 0) {
        addViolation(violations, "invalid-marker", `${entry.id} has an empty required marker.`, { id: entry.id });
        continue;
      }
      if (!combinedSource.includes(marker)) {
        addViolation(violations, "missing-marker", `${entry.id} is missing required marker: ${marker}`, {
          id: entry.id,
          marker,
        });
      }
    }

    for (const circuitSource of entry.resilience?.circuitSources ?? []) {
      if (typeof circuitSource !== "string" || circuitSource.length === 0) {
        addViolation(violations, "invalid-circuit-source", `${entry.id} has an empty circuit source.`, { id: entry.id });
        continue;
      }
      if (circuitSource.startsWith("CIRCUIT_SOURCE.") && !combinedSource.includes(circuitSource)) {
        addViolation(violations, "missing-circuit-source-marker", `${entry.id} is missing circuit source marker ${circuitSource}`, {
          id: entry.id,
          circuitSource,
        });
      }
    }
  }

  for (const family of requiredFamilies) {
    if (!registry.some((entry) => entry.family === family)) {
      addViolation(violations, "missing-required-family", `Registry is missing required provider surface family: ${family}`, {
        family,
      });
    }
  }

  for (const relPath of collectDirectFetchFiles(cwd, directFetchRoots)) {
    const source = readRelFile(cwd, relPath);
    const calls = findBareFetchCalls(source, relPath);
    if (calls.length === 0) continue;

    const entries = entriesByFile.get(relPath) ?? [];
    if (entries.length === 0) {
      for (const call of calls) {
        addViolation(violations, "unregistered-direct-fetch", `${call.file}:${call.line} bare fetch is not covered by the provider resilience registry.`, call);
      }
      continue;
    }

    if (!entries.some((entry) => entry.allowBareFetch === true)) {
      for (const call of calls) {
        addViolation(violations, "direct-fetch-not-allowed", `${call.file}:${call.line} bare fetch is not allowed by its provider resilience registry entry.`, call);
      }
    }
  }

  return {
    entries: registry.length,
    registeredFiles: entriesByFile.size,
    violations,
  };
}

export function main(cwd = process.cwd()): number {
  const report = scanProviderResilience({ cwd });
  const status = reportViolations({
    label: "Provider resilience registry",
    violations: report.violations.map((violation) => `[${violation.kind}] ${violation.message}`),
    hint: "Fix: register the provider surface with timeout/body/circuit/test coverage, or route outbound HTTP through an existing resilient helper.",
  });
  if (status !== 0) return status;

  process.stdout.write(
    `Provider resilience registry: OK (${report.entries} surfaces, ${report.registeredFiles} files registered)\n`,
  );
  return 0;
}

runAsCli(import.meta.url, main);
