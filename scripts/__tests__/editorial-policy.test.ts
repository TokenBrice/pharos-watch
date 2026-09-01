/* eslint-disable security/detect-non-literal-fs-filename -- CI-only corpus discovery uses reviewed registry paths. */
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  EDITORIAL_REGISTER_IDS,
  EDITORIAL_STYLE_HASH,
  EDITORIAL_STYLE_VERSION,
  scanEditorialText,
  type EditorialFinding,
} from "@shared/lib/editorial-style";

import {
  EDITORIAL_BASELINE_PATH,
  EDITORIAL_EXCEPTIONS_PATH,
  EDITORIAL_SURFACE_REGISTRY,
  EDITORIAL_POLICY_TEST_PATH,
  editorialPathMatches,
  validateEditorialSurfaceRegistry,
  type EditorialSurfaceEntry,
} from "../lib/editorial-surface-registry";
import {
  applyEditorialExceptions,
  buildEditorialBaseline,
  compareEditorialBaseline,
  editorialBaselineKey,
  readEditorialBaseline,
  readEditorialExceptions,
  validateEditorialExceptions,
  type EditorialBaselineRegression,
  type EditorialObservation,
} from "../lib/editorial-baseline";
import { extractUnitsForSurface } from "../lib/editorial-extractors";

interface GateObservation extends EditorialObservation {
  readonly path: string;
  readonly line: number;
  readonly finding: EditorialFinding;
}

export interface EditorialGateResult {
  readonly observations: readonly GateObservation[];
  readonly regressions: readonly EditorialBaselineRegression[];
}

const INLINE_ALLOW_RE = /editorial-style-allow:\s*([a-z0-9-]+)\s*--\s*(\S.*)$/i;
export type EditorialPolicyMode = "shadow" | "enforce";
/** Shadow is the rollout default; setting EDITORIAL_POLICY_MODE=enforce flips one config value. */
export const EDITORIAL_POLICY_MODE: EditorialPolicyMode =
  process.env.EDITORIAL_POLICY_MODE === "enforce" ? "enforce" : "shadow";
const UNSCOPED_ALLOW_RE = /(?:banned-phrase-allow|editorial-style-allow)\s*:/i;

function normalizeRelativePath(root: string, path: string): string {
  const absolute = resolve(root, path);
  return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : path.replaceAll("\\", "/");
}

function sourceLineAt(source: string, offset: number): { line: number; text: string } {
  const safeOffset = Math.max(0, Math.min(offset, source.length));
  const lineStart = source.lastIndexOf("\n", Math.max(0, safeOffset - 1)) + 1;
  const lineEnd = source.indexOf("\n", safeOffset);
  return {
    line: source.slice(0, lineStart).split("\n").length,
    text: source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).trim().slice(0, 240),
  };
}

function discoverSurfacePaths(surface: EditorialSurfaceEntry, root: string): string[] {
  const paths = surface.paths.flatMap((pattern) => globSync(pattern, { cwd: root, nodir: true }) as string[]);
  const unique = [...new Set(paths.map((path) => normalizeRelativePath(root, path)))].sort();
  if (unique.length === 0) throw new Error(`[editorial-style] Surface "${surface.id}" has no discovered source: ${surface.paths.join(", ")}`);
  return unique;
}

export function discoverEditorialSources(
  root = process.cwd(),
  registry: readonly EditorialSurfaceEntry[] = EDITORIAL_SURFACE_REGISTRY,
): Array<{ surface: EditorialSurfaceEntry; path: string }> {
  validateEditorialSurfaceRegistry(registry, new Set(EDITORIAL_REGISTER_IDS));
  return registry.flatMap((surface) => discoverSurfacePaths(surface, root).map((path) => ({ surface, path })));
}

/** Refuses prose paths that are not declared by an editorial surface. */
export function assertEditorialSourcesRegistered(
  paths: readonly string[],
  registry: readonly EditorialSurfaceEntry[] = EDITORIAL_SURFACE_REGISTRY,
): void {
  validateEditorialSurfaceRegistry(registry, new Set(EDITORIAL_REGISTER_IDS));
  const unregistered = paths.filter((path) => !registry.some((surface) => surface.paths.some((pattern) => editorialPathMatches(pattern, path))));
  if (unregistered.length > 0) {
    throw new Error(`[editorial-style] Unregistered editorial corpus path(s): ${unregistered.join(", ")}`);
  }
}

function surfaceOnlyObservations(
  observations: readonly GateObservation[],
  surfaceById: ReadonlyMap<string, EditorialSurfaceEntry>,
): GateObservation[] {
  return observations.filter((observation) => surfaceById.get(observation.surface)?.tier !== "historical-exempt");
}

function digestMatchesSurface(surface: EditorialSurfaceEntry, record: string): boolean {
  if (surface.id === "daily-digests") return record.includes("digestType=daily");
  if (surface.id === "weekly-digests") return record.includes("digestType=weekly");
  return true;
}

function collectGateObservations(
  root: string,
  registry: readonly EditorialSurfaceEntry[],
): { observations: GateObservation[]; sourceAllowErrors: string[] } {
  const observations: GateObservation[] = [];
  const sourceAllowErrors: string[] = [];
  for (const { surface, path } of discoverEditorialSources(root, registry)) {
    const source = readFileSync(resolve(root, path), "utf8");
    const units = extractUnitsForSurface(surface, path, source);
    const usedInlineAllows = new Set<string>();
    for (const unit of units) {
      if (!digestMatchesSurface(surface, unit.record) || unit.ownership !== "pharos") continue;
      const findings = scanEditorialText(unit.text, {
        register: surface.register,
        field: unit.field,
        ownership: unit.ownership,
        exemptions: unit.exemptions,
      });
      for (const finding of findings) {
        const location = sourceLineAt(source, unit.sourceOffset + finding.index);
        const allow = location.text.match(INLINE_ALLOW_RE);
        if (UNSCOPED_ALLOW_RE.test(location.text) && !allow) {
          sourceAllowErrors.push(`${path}:${location.line} uses an unscoped editorial allow; use editorial-style-allow: <rule-id> -- <reason>`);
        }
        const key = editorialBaselineKey({ surface: surface.id, record: unit.record, field: unit.field, rule: finding.ruleId });
        if (allow?.[1]?.toLowerCase() === finding.ruleId.toLowerCase() && !usedInlineAllows.has(key)) {
          usedInlineAllows.add(key);
          continue;
        }
        observations.push({
          surface: surface.id,
          record: unit.record,
          field: unit.field,
          rule: finding.ruleId,
          excerpt: finding.excerpt,
          context: location.text,
          finding,
          path,
          line: location.line,
        });
      }
    }
  }
  return { observations, sourceAllowErrors };
}

export function runEditorialPolicyGate({
  root = process.cwd(),
  baselinePath = resolve(root, EDITORIAL_BASELINE_PATH),
  exceptionsPath = resolve(root, EDITORIAL_EXCEPTIONS_PATH),
  now = new Date(),
  registry = EDITORIAL_SURFACE_REGISTRY,
}: {
  root?: string;
  baselinePath?: string;
  exceptionsPath?: string;
  now?: Date;
  registry?: readonly EditorialSurfaceEntry[];
} = {}): EditorialGateResult {
  const { observations, sourceAllowErrors } = collectGateObservations(root, registry);
  if (sourceAllowErrors.length > 0) throw new Error(sourceAllowErrors.join("\n"));
  const exceptionFile = readEditorialExceptions(exceptionsPath);
  const rawKeys = new Set(observations.map((observation) => editorialBaselineKey(observation)));
  validateEditorialExceptions(exceptionFile.exceptions, rawKeys, { now });
  const observationsWithSidecar = applyEditorialExceptions(observations, exceptionFile.exceptions);
  const surfaceById = new Map(registry.map((surface) => [surface.id, surface]));
  const baselineObservations = surfaceOnlyObservations(observationsWithSidecar, surfaceById);
  const baseline = readEditorialBaseline(baselinePath);
  if (baseline.policyVersion !== EDITORIAL_STYLE_VERSION || baseline.policyHash !== EDITORIAL_STYLE_HASH) {
    throw new Error(
      `[editorial-style] Baseline policy ${baseline.policyVersion}/${baseline.policyHash} does not match ${EDITORIAL_STYLE_VERSION}/${EDITORIAL_STYLE_HASH}; regenerate with node --import tsx scripts/maintenance/generate-editorial-baseline.ts.`,
    );
  }
  const regressions = compareEditorialBaseline(baselineObservations, baseline);
  return { observations: baselineObservations, regressions };
}

function formatGateDiagnostics(result: EditorialGateResult): string {
  const byKey = new Map(result.observations.map((observation) => [editorialBaselineKey(observation), observation]));
  return result.regressions
    .map((regression) => {
      const observation = byKey.get(regression.key);
      return observation
        ? `${observation.path}:${observation.line} [${observation.rule}] ${observation.excerpt}\n${regression.message}`
        : regression.message;
    })
    .join("\n");
}

describe("editorial corpus policy gate", () => {
  it("records corpus findings in shadow mode and reserves blocking for the config flip", () => {
    const result = runEditorialPolicyGate();
    expect(result.observations).toEqual(expect.any(Array));
    if (EDITORIAL_POLICY_MODE === "enforce") {
      expect(result.regressions, formatGateDiagnostics(result)).toEqual([]);
    }
  });

  it("keeps every source family registered and every surface assigned a known register", () => {
    expect(EDITORIAL_POLICY_TEST_PATH).toBe("scripts/__tests__/editorial-policy.test.ts");
    validateEditorialSurfaceRegistry(EDITORIAL_SURFACE_REGISTRY, new Set(EDITORIAL_REGISTER_IDS));
    expect(new Set(EDITORIAL_SURFACE_REGISTRY.map((surface) => surface.extractor))).toEqual(
      new Set(["json-fields", "structured-data", "markdown-body"]),
    );
  });

  it("refuses an unregistered prose corpus instead of silently ignoring it", () => {
    expect(() => assertEditorialSourcesRegistered(["data/new-prose-corpus.json"])).toThrow(/Unregistered editorial corpus/);
  });

  it("does not permit an unscoped Selector-style allow", () => {
    expect(() => {
      const root = "fixture.ts";
      const source = "const text = 'Supply fell — the peg held.'; // banned-phrase-allow: old\n";
      const location = sourceLineAt(source, source.indexOf("Supply"));
      if (UNSCOPED_ALLOW_RE.test(location.text) && !INLINE_ALLOW_RE.test(location.text)) throw new Error("unscoped");
      void root;
    }).toThrow("unscoped");
  });
  it("records a newly injected hard violation as a regression without blocking shadow mode", () => {
    const root = mkdtempSync(resolve(tmpdir(), "pharos-editorial-gate-"));
    try {
      writeFileSync(resolve(root, "fixture.json"), JSON.stringify({ text: "Supply fell — the peg held." }));
      const baselinePath = resolve(root, "baseline.json");
      const exceptionsPath = resolve(root, "exceptions.json");
      writeFileSync(
        baselinePath,
        `${JSON.stringify(buildEditorialBaseline([], {
          policyVersion: EDITORIAL_STYLE_VERSION,
          policyHash: EDITORIAL_STYLE_HASH,
          generatedAt: "2026-09-01T00:00:00.000Z",
        }))}\n`,
      );
      writeFileSync(exceptionsPath, `${JSON.stringify({ version: 1, exceptions: [] })}\n`);
      const result = runEditorialPolicyGate({
        root,
        baselinePath,
        exceptionsPath,
        registry: [{
          id: "fixture-json",
          register: "daily",
          paths: ["fixture.json"],
          extractor: "json-fields",
          ownership: "pharos",
          tier: "committed-corpus",
          options: { fields: ["text"], rootRecord: "file" },
        }],
      });
      expect(result.observations.length).toBeGreaterThan(0);
      expect(result.regressions.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires non-expired owned exceptions and supports permanent debt explicitly", () => {
    const selector = {
      surface: "fixture-json",
      record: "fixture",
      field: "text",
      ruleId: "no-clause-dash",
      reason: "Statutory quotation retained until legal review.",
      owner: "content",
    };
    const key = editorialBaselineKey({ ...selector, rule: selector.ruleId });
    const now = new Date("2026-09-01T00:00:00.000Z");
    expect(() => validateEditorialExceptions(
      [{ ...selector, expiresAt: "2026-10-01T00:00:00.000Z" }],
      new Set([key]),
      { now },
    )).not.toThrow();
    expect(() => validateEditorialExceptions(
      [{ ...selector, expiresAt: "2026-08-31T00:00:00.000Z" }],
      new Set([key]),
      { now },
    )).toThrow(/expired/);
    expect(() => validateEditorialExceptions(
      [{ ...selector, permanent: true }],
      new Set([key]),
      { now },
    )).not.toThrow();
    expect(() => validateEditorialExceptions(
      [{ ...selector, permanent: true, expiresAt: "2026-10-01T00:00:00.000Z" }],
      new Set([key]),
      { now },
    )).toThrow(/must not carry expiresAt/);
    expect(() => validateEditorialExceptions(
      [{ ...selector, permanent: true }],
      new Set(),
      { now },
    )).toThrow(/Orphaned/);
  });

  it("consumes only one occurrence for a field-level exception", () => {
    const observation = {
      surface: "fixture-json",
      record: "fixture",
      field: "text",
      rule: "no-clause-dash",
      excerpt: "—",
    } satisfies EditorialObservation;
    const exception = {
      surface: observation.surface,
      record: observation.record,
      field: observation.field,
      ruleId: observation.rule,
      reason: "One retained legal quotation.",
      owner: "content",
      permanent: true,
    };
    expect(applyEditorialExceptions([observation, observation], [exception])).toHaveLength(1);
  });

  it("keeps identity labels out of the prose unit set", () => {
    const surface = EDITORIAL_SURFACE_REGISTRY.find((candidate) => candidate.id === "domain-sidecars")!;
    const source = JSON.stringify({
      mintAuthority: {
        controls: [{ label: "Safe — owner", role: "admin", note: "Authority remains mutable." }],
        controlRef: "Safe — owner",
      },
    });
    const units = extractUnitsForSurface(surface, "shared/data/stablecoins/domains/fixture.json", source);
    expect(units.some((unit) => unit.field.includes("controls.*.label"))).toBe(false);
    expect(units.some((unit) => unit.field.endsWith(".note"))).toBe(true);
  });

  it("honors quoted external titles without creating baseline observations", () => {
    const source = '[{"date":"2026-09-01","kind":"incident","label":"External — title","quoted":true,"note":"quoted"}]';
    const surface = EDITORIAL_SURFACE_REGISTRY.find((candidate) => candidate.id === "annotations")!;
    const units = extractUnitsForSurface(surface, "shared/data/annotations/coins/fixture.json", source);
    expect(units.some((unit) => unit.ownership === "quoted")).toBe(true);
    expect(scanEditorialText(units[0]?.text ?? "", { register: surface.register, ownership: "quoted" })).toEqual([]);
  });

  it("keeps the full-corpus sweep out of the PR planner command itself", () => {
    expect(existsSync(resolve(process.cwd(), EDITORIAL_BASELINE_PATH))).toBe(true);
  });
});
