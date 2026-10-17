import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { collectMarkdownReferences, requiresDocNavigation } from "../lib/doc-markdown.mts";
import { createOwnershipGlobMatcher } from "../lib/doc-ownership-registry.mts";
import { assertExecutableTestFiles } from "../lib/critical-ownership.mts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const COVERAGE_ROOTS = ["src/", "shared/", "worker/", "functions/", "scripts/", "docs/", ".github/"];
const SPECIFIC_COVERAGE_THRESHOLD = 80;

type DocReference = string | { anchor: string; path: string };
type RegistryMapping = {
  alsoRead?: string[];
  background?: DocReference[];
  checks?: string[];
  docs: DocReference[];
  id: string;
  sources: string[];
  tier?: "specific" | "fallback";
  testOwnership?: Array<{ sources: string[]; tests: string[] }>;
};
type RegistryExclusion = { reason: string; sources: string[] };
type OwnershipRegistry = {
  baseDocs?: string[];
  exclusions?: RegistryExclusion[];
  mappings?: RegistryMapping[];
  taskFamilies?: unknown;
};

const ownership = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "docs/doc-ownership.json"), "utf8"),
) as OwnershipRegistry;
const mappings = ownership.mappings ?? [];
const exclusions = ownership.exclusions ?? [];
const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).split("\0").filter(Boolean);

function normalizeDoc(reference: DocReference): { anchor?: string; path: string } {
  return typeof reference === "string" ? { path: reference } : reference;
}

const matcherCache = new Map<readonly string[], (file: string) => boolean>();

function matchesAny(file: string, patterns: readonly string[]): boolean {
  let match = matcherCache.get(patterns);
  if (!match) {
    match = getMappingMatcher(patterns);
    matcherCache.set(patterns, match);
  }
  return match(file);
}

function getMappingMatcher(sources: readonly string[]): (file: string) => boolean {
  const matchers = sources.map(createOwnershipGlobMatcher);
  return (file: string) => matchers.some((matcher) => matcher(file));
}

describe("doc-ownership registry integrity", () => {
  it("authors only exceptional checks, leaving baseline selectors authoritative", () => {
    for (const mapping of mappings) {
      for (const command of mapping.checks ?? []) {
        expect(command, mapping.id).not.toMatch(/^npm run (?:lint:changed|typecheck(?::worker)?|check:(?:stablecoin-data|site-csp-sync|cron-sync|cron-connections|migrations|telegram-load|doc-sync|generated-artifacts))(?: |$)/);
      }
    }
    expect(mappings.find((mapping) => mapping.id === "stablecoin-registry")?.checks)
      .toContain("npm run check:failure-scenarios");
  });

  const references: Array<{ path: string; anchor?: string }> = [
    ...(ownership.baseDocs ?? []).map((path) => ({ path })),
    ...mappings.flatMap((mapping) => [
      ...mapping.docs.map(normalizeDoc),
      ...(mapping.background ?? []).map(normalizeDoc),
      ...(mapping.alsoRead ?? []).map((path) => ({ path })),
    ]),
  ];

  it.each([...new Set(references.map((reference) => reference.path))])("keeps document, scoped context, and anchors present: %s", (path) => {
    expect(path).not.toMatch(/\s/);
    expect(existsSync(resolve(REPO_ROOT, path)), path).toBe(true);
    const content = readFileSync(resolve(REPO_ROOT, path), "utf8");
    const fileReferences = references.filter((reference) => reference.path === path);
    const anchors = fileReferences.some((reference) => reference.anchor)
      ? collectMarkdownReferences(content).anchors : new Set<string>();
    const bounded = path.endsWith(".md") && requiresDocNavigation(content);
    for (const reference of fileReferences) {
      if (reference.anchor) expect(anchors.has(reference.anchor), `${path}#${reference.anchor}`).toBe(true);
      if (bounded) expect(reference.anchor, `${path} requires a bounded anchor`).toBeTruthy();
    }
  });
  it("keeps primary Markdown sections within 25KB and ratchets legacy exceptions", () => {
    // Existing out-of-scope sections only. Remove entries once bounded; new
    // primary sections must stay within 25KB.
    const legacySectionCeilings: Record<string, number> = {
      "docs/supply-snapshot.md#supply-pipeline": 38_212,
      // Release B added nullable flow/supply/PSI, nominal-price, and audit-verdict
      // wire contracts; the 2026-10-07 hardening added served-generation yield
      // identity, PSI omission arrays, and scheduler liveness. Retain its ratchet.
      "docs/api-reference.md#public-endpoints": 47_460,
      "docs/telegram-alerts.md#commands": 33_389,
      "docs/digest-pipeline.md#generation": 43_892,
      // Main's env-interface, scripts, and status backend exceptions no longer
      // apply after bounded routing/restructuring; retain the default 25KB cap.
    };
    const remainingExceptions = new Set(Object.keys(legacySectionCeilings));
    const domainIds = [
      "live-reserves", "yield-intelligence", "homepage", "about-page",
      "coverage-page", "start-page", "feedback-pipeline", "compliance", "worker-admin-api",
    ];
    for (const mapping of mappings) {
      const newDomain = domainIds.includes(mapping.id);
      if (newDomain) expect(mapping.checks ?? [], mapping.id).toEqual([]);
      for (const reference of mapping.docs.map(normalizeDoc)) {
        if (!reference.path.endsWith(".md")) continue;
        if (newDomain) expect(reference.anchor, mapping.id).toBeTruthy();
        const key = reference.path + (reference.anchor ? `#${reference.anchor}` : "");
        const lines = readFileSync(resolve(REPO_ROOT, reference.path), "utf8").split("\n");
        let start = reference.anchor ? -1 : 0;
        let level = 0;
        let end = lines.length;
        let fence: string | undefined;
        for (let index = 0; reference.anchor && index < lines.length; index++) {
          const marker = /^\s*(`{3,}|~{3,})/.exec(lines[index])?.[1];
          if (marker) {
            if (!fence) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
            continue;
          }
          if (fence) continue;
          const heading = /^(#{1,6}) /.exec(lines[index]);
          if (!heading) continue;
          if (start >= 0 && heading[1].length <= level) {
            end = index;
            break;
          }
          if (start < 0 && collectMarkdownReferences(lines[index]).anchors.has(reference.anchor!)) {
            start = index;
            level = heading[1].length;
          }
        }
        expect(start, key).toBeGreaterThanOrEqual(0);
        const bytes = Buffer.byteLength(lines.slice(start, end).join("\n"));
        expect(bytes, key).toBeLessThanOrEqual(newDomain ? 25_000 : legacySectionCeilings[key] ?? 25_000);
        if (Object.hasOwn(legacySectionCeilings, key)) {
          expect(bytes, `Remove resolved section exception: ${key}`).toBeGreaterThan(25_000);
          remainingExceptions.delete(key);
        }
      }
    }
    expect([...remainingExceptions], "Remove exceptions no longer routed as primary sections").toEqual([]);
  });
  it("keeps declared invariant inputs live and their tests executable", () => {
    for (const mapping of mappings) {
      for (const declaration of mapping.testOwnership ?? []) {
        expect(declaration.sources.length, mapping.id).toBeGreaterThan(0);
        for (const source of declaration.sources) {
          expect(trackedFiles.some((file) => matchesAny(file, [source])), `${mapping.id}: ${source}`).toBe(true);
        }
        expect(() => assertExecutableTestFiles(declaration.tests, { cwd: REPO_ROOT })).not.toThrow();
      }
    }
  });

  it.each([
    "live-reserves", "dex-liquidity", "worker-infrastructure", "report-cards", "pricing-pipeline",
  ])("keeps the current %s contract below 40KB with a navigable appendix", (name) => {
    const contract = readFileSync(resolve(REPO_ROOT, `docs/${name}.md`), "utf8");
    const appendixPath = `docs/process/${name}-appendix.md`;
    const appendix = readFileSync(resolve(REPO_ROOT, appendixPath), "utf8");
    expect(Buffer.byteLength(contract, "utf8")).toBeLessThan(40_000);
    expect(collectMarkdownReferences(contract).links.some((link) => link.includes(appendixPath.slice(5)))).toBe(true);
    expect(appendix).toMatch(/^> \*\*Agent navigation\*\*/m);
  });

  it("reports fallback-inclusive coverage while enforcing honest specific coverage", () => {
    const inScope = trackedFiles.filter((file) => COVERAGE_ROOTS.some((root) => file.startsWith(root)));
    const specificMappings = mappings.filter((mapping) => mapping.tier !== "fallback");
    const fallbackMappings = mappings.filter((mapping) => mapping.tier === "fallback");
    const specificMatchers = specificMappings.map((mapping) => (file: string) => matchesAny(file, mapping.sources));
    const fallbackMatchers = fallbackMappings.map((mapping) => (file: string) => matchesAny(file, mapping.sources));
    const exclusionMatchers = exclusions.map((exclusion) => (file: string) => matchesAny(file, exclusion.sources));
    let specificallyCoveredCount = 0;
    const fallbackOnly: string[] = [];
    const uncovered: string[] = [];
    for (const file of inScope) {
      const excluded = exclusionMatchers.some((matcher) => matcher(file));
      let specific = false;
      for (const matcher of specificMatchers) {
        if (matcher(file)) {
          specific = true;
          break;
        }
      }
      if (specific || excluded) {
        specificallyCoveredCount += 1;
        continue;
      }
      if (fallbackMatchers.some((matcher) => matcher(file))) {
        fallbackOnly.push(file);
      } else {
        uncovered.push(file);
      }
    }
    const specificCoverage = (specificallyCoveredCount / inScope.length) * 100;
    const fallbackInclusiveCoverage = ((inScope.length - uncovered.length) / inScope.length) * 100;
    console.info(
      `doc-ownership coverage: specific ${specificCoverage.toFixed(2)}%; ` +
      `fallback-inclusive ${fallbackInclusiveCoverage.toFixed(2)}% ` +
      `(${fallbackOnly.length} fallback-only, ${uncovered.length} uncovered)`,
    );
    expect(
      specificCoverage,
      `Fallback-only files:\n${fallbackOnly.join("\n")}\n\nUncovered files:\n${uncovered.join("\n")}`,
    ).toBeGreaterThanOrEqual(SPECIFIC_COVERAGE_THRESHOLD);
    expect(fallbackInclusiveCoverage, `Uncovered files:\n${uncovered.join("\n")}`).toBeGreaterThanOrEqual(95);
  });
});
