import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const COVERAGE_ROOTS = ["src/", "shared/", "worker/", "functions/", "scripts/", "docs/", ".github/"];
const SPECIFIC_COVERAGE_THRESHOLD = 80;

type DocReference = string | { anchor: string; path: string };
type RegistryMapping = {
  alsoRead?: string[];
  background?: DocReference[];
  checks: string[];
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

function githubSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+\{#[^}]+\}\s*$/, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .replace(/\s/g, "-");
}

function headingAnchors(path: string): Set<string> {
  const counts = new Map<string, number>();
  const anchors = new Set<string>();
  const contents = readFileSync(resolve(REPO_ROOT, path), "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (!match) continue;
    const explicit = match[1].match(/\s+\{#([^}]+)\}\s*$/)?.[1];
    const base = explicit ?? githubSlug(match[1]);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

function matchesAny(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(file, pattern));
}

describe("doc-ownership registry integrity", () => {
  it("uses mappings as the sole authored routing model", () => {
    expect(mappings.length).toBeGreaterThan(0);
    expect(ownership.taskFamilies).toBeUndefined();
    expect(new Set(mappings.map((mapping) => mapping.id)).size).toBe(mappings.length);
    for (const id of ["frontend-routes", "worker-cron", "worker-runtime", "shared-runtime"]) {
      expect(mappings.find((mapping) => mapping.id === id)?.tier, id).toBe("fallback");
    }
  });

  it("keeps every document, scoped context file, and anchor present", () => {
    const references: Array<{ path: string; anchor?: string }> = [
      ...(ownership.baseDocs ?? []).map((path) => ({ path })),
      ...mappings.flatMap((mapping) => [
        ...mapping.docs.map(normalizeDoc),
        ...(mapping.background ?? []).map(normalizeDoc),
        ...(mapping.alsoRead ?? []).map((path) => ({ path })),
      ]),
    ];

    for (const reference of references) {
      expect(reference.path).not.toMatch(/\s/);
      expect(existsSync(resolve(REPO_ROOT, reference.path)), reference.path).toBe(true);
      if (reference.anchor) {
        expect(
          headingAnchors(reference.path).has(reference.anchor),
          `${reference.path}#${reference.anchor}`,
        ).toBe(true);
      }

      if (reference.path.endsWith(".md")) {
        const lineCount = readFileSync(resolve(REPO_ROOT, reference.path), "utf8").split(/\r?\n/).length;
        if (lineCount > 400) {
          expect(reference.anchor, `${reference.path} requires a bounded anchor`).toBeTruthy();
        }
      }
    }
  });

  it("keeps every npm run check wired to a package script", () => {
    for (const mapping of mappings) {
      for (const check of mapping.checks) {
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

  it("owns every previously unowned verified doc", () => {
    const required = [
      "docs/alt-pegs-page.md", "docs/bluechip-ratings.md", "docs/compliance-page.md",
      "docs/data-visualization.md", "docs/dependency-map.md", "docs/freezing-stablecoins.md",
      "docs/funding-page.md", "docs/genius-tracker.md", "docs/learn-page.md", "docs/live-reserves.md",
      "docs/mica-tracker.md", "docs/privacy-page.md", "docs/process/adding-a-stablecoin.md",
      "docs/process/ddrr-calibration.md", "docs/process/mechanism-overlay-evidence-standard.md",
      "docs/process/stablecoin-research-sidecars.md", "docs/process/worker-runtime-experiments.md",
      "docs/redemption-backstops.md", "docs/screener-page.md", "docs/screener-picker-page.md",
      "docs/sitemap-tree-page.md", "docs/stablecoin-taxonomy-pages.md",
      "docs/yield-intelligence-operations.md",
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
    let specificallyCoveredCount = 0;
    const fallbackOnly: string[] = [];
    const uncovered: string[] = [];
    for (const file of inScope) {
      const excluded = exclusions.some((exclusion) => matchesAny(file, exclusion.sources));
      const specific = specificMappings.some((mapping) => matchesAny(file, mapping.sources));
      if (specific || excluded) {
        specificallyCoveredCount += 1;
        continue;
      }
      if (fallbackMappings.some((mapping) => matchesAny(file, mapping.sources))) {
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
