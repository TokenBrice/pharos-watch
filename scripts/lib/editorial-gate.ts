/* eslint-disable security/detect-non-literal-fs-filename -- CI-only corpus discovery uses reviewed registry paths. */
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  EDITORIAL_REGISTER_IDS,
  EDITORIAL_STYLE_HASH,
  EDITORIAL_STYLE_VERSION,
  scanEditorialText,
  type EditorialFinding,
} from "@shared/lib/editorial-style";
import { EDITORIAL_POLICY } from "@shared/lib/editorial-style.generated";

import {
  applyEditorialExceptions,
  compareEditorialBaseline,
  editorialBaselineKey,
  readEditorialBaseline,
  readEditorialExceptions,
  validateEditorialExceptions,
  type EditorialBaselineRegression,
  type EditorialException,
  type EditorialObservation,
} from "./editorial-baseline";
import { extractUnitsForSurface } from "./editorial-extractors";
import {
  EDITORIAL_BASELINE_PATH,
  EDITORIAL_EXCEPTIONS_PATH,
  EDITORIAL_SURFACE_REGISTRY,
  editorialPathMatches,
  validateEditorialSurfaceCoverage,
  validateEditorialSurfaceRegistry,
  type EditorialSurfaceEntry,
} from "./editorial-surface-registry";

export interface GateObservation extends EditorialObservation {
  readonly path: string;
  readonly line: number;
  readonly finding: EditorialFinding;
}

export interface EditorialGateResult {
  readonly observations: readonly GateObservation[];
  readonly regressions: readonly EditorialBaselineRegression[];
  readonly blockingRegressions: readonly EditorialBaselineRegression[];
}

export type EditorialPolicyMode = "shadow" | "enforce";
/** Shadow is the rollout default; setting EDITORIAL_POLICY_MODE=enforce flips one config value. */
export const EDITORIAL_POLICY_MODE: EditorialPolicyMode =
  process.env.EDITORIAL_POLICY_MODE === "enforce" ? "enforce" : "shadow";

const INLINE_ALLOW_RE = /editorial-style-allow:\s*([a-z0-9-]+)\s*--\s*(\S.*)$/i;
const UNSCOPED_ALLOW_RE = /(?:banned-phrase-allow|editorial-style-allow)\s*:/i;
const FINGERPRINT_CONTEXT_CHARS = 240;

function normalizeRelativePath(root: string, path: string): string {
  const absolute = resolve(root, path);
  return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : path.replaceAll("\\", "/");
}

export function sourceLineAt(source: string, offset: number): { line: number; text: string } {
  const safeOffset = Math.max(0, Math.min(offset, source.length));
  const lineStart = source.lastIndexOf("\n", Math.max(0, safeOffset - 1)) + 1;
  const lineEnd = source.indexOf("\n", safeOffset);
  return {
    line: source.slice(0, lineStart).split("\n").length,
    text: source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).trim(),
  };
}

/** Stable, occurrence-local fingerprint context, bounded once for both baseline generation and the gate. */
function fingerprintContextAt(text: string, index: number): string {
  const safeIndex = Math.max(0, Math.min(index, text.length));
  let start = Math.max(0, safeIndex - Math.floor(FINGERPRINT_CONTEXT_CHARS / 2));
  const end = Math.min(text.length, start + FINGERPRINT_CONTEXT_CHARS);
  start = Math.max(0, end - FINGERPRINT_CONTEXT_CHARS);
  return text.slice(start, end);
}

function discoverSurfacePaths(surface: EditorialSurfaceEntry, root: string): string[] {
  const paths = surface.paths.flatMap((pattern) => globSync(pattern, { cwd: root }) as string[]);
  const unique = [...new Set(paths.map((path) => normalizeRelativePath(root, path)))].sort();
  if (unique.length === 0) {
    throw new Error(`[editorial-style] Surface "${surface.id}" has no discovered source: ${surface.paths.join(", ")}`);
  }
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

function digestMatchesSurface(surface: EditorialSurfaceEntry, record: string): boolean {
  if (surface.id === "daily-digests") return record.includes("digestType=daily");
  if (surface.id === "weekly-digests") return record.includes("digestType=weekly");
  return true;
}

export function collectGateObservations({
  root = process.cwd(),
  registry = EDITORIAL_SURFACE_REGISTRY,
  exceptionsPath = resolve(root, EDITORIAL_EXCEPTIONS_PATH),
  exceptions,
  now = new Date(),
}: {
  root?: string;
  registry?: readonly EditorialSurfaceEntry[];
  exceptionsPath?: string;
  exceptions?: readonly EditorialException[];
  now?: Date;
} = {}): GateObservation[] {
  const observations: GateObservation[] = [];
  const sourceAllowErrors: string[] = [];
  const unitCounts = new Map<string, number>();
  for (const { surface, path } of discoverEditorialSources(root, registry)) {
    const source = readFileSync(resolve(root, path), "utf8");
    const units = extractUnitsForSurface(surface, path, source);
    unitCounts.set(surface.id, (unitCounts.get(surface.id) ?? 0) + units.length);
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
          context: fingerprintContextAt(unit.text, finding.index),
          finding,
          path,
          line: location.line,
        });
      }
    }
  }
  if (sourceAllowErrors.length > 0) throw new Error(sourceAllowErrors.join("\n"));
  validateEditorialSurfaceCoverage(registry, unitCounts);

  const configuredExceptions = exceptions ?? readEditorialExceptions(exceptionsPath).exceptions;
  const rawKeys = new Set(observations.map((observation) => editorialBaselineKey(observation)));
  validateEditorialExceptions(configuredExceptions, rawKeys, {
    now,
    knownRuleIds: new Set(EDITORIAL_POLICY.rules.map((rule) => rule.id)),
    knownSurfaceIds: new Set(registry.map((surface) => surface.id)),
  });
  const postException = applyEditorialExceptions(observations, configuredExceptions);
  const surfaceById = new Map(registry.map((surface) => [surface.id, surface]));
  return postException.filter((observation) => surfaceById.get(observation.surface)?.tier !== "historical-exempt");
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
  const observations = collectGateObservations({ root, registry, exceptionsPath, now });
  const baseline = readEditorialBaseline(baselinePath);
  if (
    EDITORIAL_POLICY_MODE === "enforce"
    && (baseline.policyVersion !== EDITORIAL_STYLE_VERSION || baseline.policyHash !== EDITORIAL_STYLE_HASH)
  ) {
    throw new Error(
      `[editorial-style] Baseline policy ${baseline.policyVersion}/${baseline.policyHash} does not match ${EDITORIAL_STYLE_VERSION}/${EDITORIAL_STYLE_HASH}; regenerate with npm run generate:editorial-baseline.`,
    );
  }
  const regressions = compareEditorialBaseline(observations, baseline);
  return {
    observations,
    regressions,
    blockingRegressions: regressions.filter((regression) => regression.blocking),
  };
}

export function formatGateDiagnostics(result: EditorialGateResult): string {
  const byKey = new Map(result.observations.map((observation) => [editorialBaselineKey(observation), observation]));
  return result.regressions
    .map((regression) => {
      const observation = regression.observation ?? byKey.get(regression.key);
      return observation
        ? `${observation.path}:${observation.line} [${observation.rule}] ${observation.excerpt}\n${regression.message}`
        : regression.message;
    })
    .join("\n");
}
