import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { collectMarkdownReferences, requiresDocNavigation } from "../lib/doc-markdown.mts";
import { createOwnershipGlobMatcher } from "../lib/doc-ownership-registry.mts";

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
const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};
const packageScripts = packageJson.scripts ?? {};
const mappings = ownership.mappings ?? [];
const exclusions = ownership.exclusions ?? [];
const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).split("\0").filter(Boolean);

function normalizeDoc(reference: DocReference): { anchor?: string; path: string } {
  return typeof reference === "string" ? { path: reference } : reference;
}

function matchesAny(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => createOwnershipGlobMatcher(pattern)(file));
}

function getMappingMatcher(sources: readonly string[]): (file: string) => boolean {
  const matchers = sources.map(createOwnershipGlobMatcher);
  return (file: string) => matchers.some((matcher) => matcher(file));
}

describe("doc-ownership registry integrity", () => {
  it("requires bounded references for a short document at the byte threshold", () => {
    expect(requiresDocNavigation("x".repeat(50 * 1024))).toBe(true);
    expect(requiresDocNavigation("short document")).toBe(false);
  });

  it("matches globstar directories at zero or multiple depths", () => {
    const match = createOwnershipGlobMatcher("scripts/**/check-*.ts");
    expect(match("scripts/check-docs.ts")).toBe(true);
    expect(match("scripts/ci/nested/check-docs.ts")).toBe(true);
    expect(match("worker/check-docs.ts")).toBe(false);
  });

  it("uses mappings as the sole authored routing model", () => {
    expect(mappings.length).toBeGreaterThan(0);
    expect(mappings.length).toBeLessThanOrEqual(20);
    expect(ownership.taskFamilies).toBeUndefined();
    expect(new Set(mappings.map((mapping) => mapping.id)).size).toBe(mappings.length);
    expect(mappings.find((mapping) => mapping.id === "documentation")?.tier).toBe("fallback");
    expect(mappings.find((mapping) => mapping.id === "frontend-routes")?.checks).toEqual([
      "npm run lint:changed",
      "npm run typecheck",
      "npx vitest run src",
    ]);
    expect(mappings.filter((mapping) => ["worker-runtime", "shared-runtime", "documentation"].includes(mapping.id))
      .every((mapping) => mapping.checks === undefined)).toBe(true);
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
  it("keeps npm run checks wired to package scripts", () => {
    for (const mapping of mappings) {
      for (const check of mapping.checks ?? []) {
        for (const match of check.matchAll(/\bnpm run\s+([^\s]+)/g)) {
          expect(Object.hasOwn(packageScripts, match[1]), `${mapping.id}: ${match[1]}`).toBe(true);
        }
      }
    }
  });

  it("rejects dead mappings and dead exclusions", () => {
    for (const mapping of mappings) {
      expect(mapping.sources.length, mapping.id).toBeGreaterThan(0);
      expect(
        trackedFiles.some((file) => matchesAny(file, mapping.sources)),
        `${mapping.id}: ${mapping.sources.join(", ")}`,
      ).toBe(true);
    }
    for (const exclusion of exclusions) {
      expect(exclusion.reason.trim()).not.toBe("");
      expect(trackedFiles.some((file) => matchesAny(file, exclusion.sources)), exclusion.reason).toBe(true);
    }
  });

  it("keeps critical contract docs owned while generic routes use the frontend contract", () => {
    const required = [
      "docs/stablecoin-data.md",
      "docs/process/adding-a-stablecoin.md",
      "docs/process/stablecoin-research-sidecars.md",
      "docs/pricing-pipeline.md",
      "docs/supply-snapshot.md",
      "docs/api-endpoint-authoring.md",
      "docs/worker-infrastructure.md",
      "docs/process/cron-trigger-policy.md",
      "docs/telegram-architecture.md",
      "docs/telegram-alerts.md",
      "docs/telegram-mini-app.md",
      "docs/deployment-process.md",
      "docs/report-cards.md",
      "docs/mint-authority-scoring.md",
      "docs/safety-score-map.md",
      "docs/status-dashboard.md",
      "docs/testing.md",
      "docs/scripts.md",
      "docs/process/agent-start-here.md",
    ];
    const ownedDocs = new Set(
      mappings.flatMap((mapping) => [...mapping.docs, ...(mapping.background ?? [])]
        .map(normalizeDoc)
        .map((doc) => doc.path)),
    );
    expect(required.filter((path) => !ownedDocs.has(path))).toEqual([]);
  });

  it("covers every tracked depth-two directory with a mapping or exclusion", () => {
    const coveredPatterns = [
      ...mappings.flatMap((mapping) => mapping.sources),
      ...exclusions.flatMap((exclusion) => exclusion.sources),
    ];
    const directories = new Set(
      trackedFiles
        .filter((file) => COVERAGE_ROOTS.some((root) => file.startsWith(root)))
        .map((file) => {
          const parts = file.split("/");
          return parts.slice(0, Math.min(3, parts.length - 1)).join("/");
        })
        .filter((path) => path.includes("/")),
    );
    const uncoveredDirectories = [...directories].filter(
      (directory) => !trackedFiles.some((file) => file.startsWith(`${directory}/`) && matchesAny(file, coveredPatterns)),
    );
    expect(uncoveredDirectories).toEqual([]);
  });

  it("reports fallback-inclusive coverage while enforcing honest specific coverage", () => {
    const inScope = trackedFiles.filter((file) => COVERAGE_ROOTS.some((root) => file.startsWith(root)));
    const specificMappings = mappings.filter((mapping) => mapping.tier !== "fallback");
    const fallbackMappings = mappings.filter((mapping) => mapping.tier === "fallback");
    const specificMatchers = specificMappings.map((mapping) => getMappingMatcher(mapping.sources));
    const fallbackMatchers = fallbackMappings.map((mapping) => getMappingMatcher(mapping.sources));
    const exclusionMatchers = exclusions.map((exclusion) => getMappingMatcher(exclusion.sources));
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
