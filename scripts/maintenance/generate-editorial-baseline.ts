#!/usr/bin/env node

import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  EDITORIAL_STYLE_HASH,
  EDITORIAL_STYLE_VERSION,
  scanEditorialText,
} from "@shared/lib/editorial-style";

import {
  EDITORIAL_BASELINE_PATH,
  EDITORIAL_SURFACE_REGISTRY,
  type EditorialSurfaceEntry,
} from "../lib/editorial-surface-registry";
import {
  buildEditorialBaseline,
  type EditorialObservation,
  writeEditorialBaseline,
} from "../lib/editorial-baseline";
import { extractUnitsForSurface } from "../lib/editorial-extractors";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

function discoverSurfacePaths(surface: EditorialSurfaceEntry, root: string): string[] {
  return [...new Set(surface.paths.flatMap((pattern) => globSync(pattern, { cwd: root }) as string[]))].sort();
}

function sourceLine(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const lineEnd = source.indexOf("\n", offset);
  return source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).trim();
}

export function collectEditorialObservations(root = ROOT): EditorialObservation[] {
  const observations: EditorialObservation[] = [];
  for (const surface of EDITORIAL_SURFACE_REGISTRY) {
    if (surface.tier === "historical-exempt") continue;
    for (const relativePath of discoverSurfacePaths(surface, root)) {
      const path = resolve(root, relativePath);
      const source = readFileSync(path, "utf8");
      const units = extractUnitsForSurface(surface, relativePath, source);
      for (const unit of units) {
        if (unit.ownership !== "pharos") continue;
        if (surface.id === "daily-digests" && !unit.record.includes("digestType=daily")) continue;
        if (surface.id === "weekly-digests" && !unit.record.includes("digestType=weekly")) continue;
        const findings = scanEditorialText(unit.text, {
          register: surface.register,
          field: unit.field,
          ownership: unit.ownership,
          exemptions: unit.exemptions,
        });
        for (const finding of findings) {
          const offset = unit.sourceOffset + finding.index;
          const lineStart = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
          observations.push({
            surface: surface.id,
            record: unit.record,
            field: unit.field,
            rule: finding.ruleId,
            excerpt: finding.excerpt,
            context: sourceLine(source, offset),
            finding,
            path: relativePath,
            line: source.slice(0, lineStart).split("\n").length,
          });
        }
      }
    }
  }
  return observations;
}

export function generateEditorialBaseline(root = ROOT) {
  return buildEditorialBaseline(collectEditorialObservations(root), {
    policyVersion: EDITORIAL_STYLE_VERSION,
    policyHash: EDITORIAL_STYLE_HASH,
  });
}

function main(): void {
  const baseline = generateEditorialBaseline();
  const output = resolve(ROOT, EDITORIAL_BASELINE_PATH);
  writeEditorialBaseline(output, baseline);
  console.log(
    `[editorial-baseline] wrote ${baseline.entries.length} selector/rule entries (${baseline.entries.reduce((total, entry) => total + entry.count, 0)} findings) to ${EDITORIAL_BASELINE_PATH}`,
  );
}

if (isDirectRun(import.meta.url, process.argv[1])) main();
