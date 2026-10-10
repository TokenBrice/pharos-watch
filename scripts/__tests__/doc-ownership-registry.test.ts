import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { collectMarkdownReferences, requiresDocNavigation } from "../lib/doc-markdown.mts";
import { getVerifiedDocFiles } from "../lib/doc-files.mts";
import { canonicalizeOwnershipSourcePattern, createOwnershipGlobMatcher, PATH_FAMILIES } from "../lib/doc-ownership-registry.mts";
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

  it("normalizes only skill facade sources to canonical tracked paths", () => {
    for (const facade of [".agents", ".claude"]) {
      expect(canonicalizeOwnershipSourcePattern(`${facade}/skills/**/SKILL.md`)).toBe(".codex/skills/**/SKILL.md");
    }
    expect(canonicalizeOwnershipSourcePattern(".codex/skills/**")).toBe(".codex/skills/**");
    expect(canonicalizeOwnershipSourcePattern(".claude/settings.json")).toBe(".claude/settings.json");
  });

  it("keeps curated runbook navigation metadata out of runtime routing references", () => {
    for (const reference of PATH_FAMILIES.flatMap((family) => [...family.docs, ...family.background])) {
      expect(reference).not.toHaveProperty("runbook");
    }
  });

  it("uses mappings as the sole authored routing model", () => {
    expect(mappings.length).toBeGreaterThan(0);
    // DEC-14: nine bounded domain/admin mappings, without additional check trees.
    expect(mappings.length).toBeLessThanOrEqual(29);
    expect(ownership.taskFamilies).toBeUndefined();
    expect(new Set(mappings.map((mapping) => mapping.id)).size).toBe(mappings.length);
    expect(mappings.find((mapping) => mapping.id === "documentation")?.tier).toBe("fallback");
    expect(mappings.find((mapping) => mapping.id === "frontend-routes")?.checks).toEqual([
      "npm run lint:changed",
      "npm run typecheck",
      "npx vitest run src",
    ]);
    expect(mappings.find((mapping) => mapping.id === "documentation")?.checks).toBeUndefined();
    for (const id of ["worker-runtime", "shared-runtime"]) {
      expect(mappings.find((mapping) => mapping.id === id)?.checks).toEqual(expect.arrayContaining([
        "npm run lint:changed", "npm run typecheck:worker", "npm run check:generated-artifacts",
      ]));
    }
  });

  it.each([
    "worker/src/cron/sync-v9-supply-attribution.ts",
    "worker/src/lib/safety-score-v9/supply-attribution.ts",
    "worker/src/lib/safety-score-v9/economic-supply-observer.ts",
    "worker/src/lib/safety-score-v9/ccip-pending-observer.ts",
    "worker/src/lib/safety-score-v9/layerzero-oft-pending-observer.ts",
    "worker/src/lib/safety-score-v9/l2-messenger-pending-observer.ts",
    "worker/src/lib/safety-score-v9/transfer-materiality.ts",
  ])("routes supply producers to attribution and in-flight accounting: %s", (file) => {
    const primaryDocs = mappings
      .filter((mapping) => matchesAny(file, mapping.sources))
      .flatMap((mapping) => mapping.docs.map(normalizeDoc));
    expect(primaryDocs).toEqual(expect.arrayContaining([
      { path: "docs/process/report-cards-appendix.md", anchor: "supply-attribution-and-in-flight-accounting" },
      { path: "docs/process/report-cards-appendix.md", anchor: "bridge-in-flight-accounting" },
    ]));
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
  it("keeps npm run checks wired to package scripts", () => {
    for (const mapping of mappings) {
      for (const check of mapping.checks ?? []) {
        for (const match of check.matchAll(/\bnpm run\s+([^\s]+)/g)) {
          expect(Object.hasOwn(packageScripts, match[1]), `${mapping.id}: ${match[1]}`).toBe(true);
        }
      }
    }
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

  it("rejects every dead mapping source pattern and dead exclusions", () => {
    const unmatchedSources: string[] = [];
    for (const mapping of mappings) {
      expect(mapping.sources.length, mapping.id).toBeGreaterThan(0);
      for (const source of mapping.sources) {
        const match = createOwnershipGlobMatcher(canonicalizeOwnershipSourcePattern(source));
        if (!trackedFiles.some(match)) unmatchedSources.push(`${mapping.id}: ${source}`);
      }
    }
    expect(unmatchedSources, `Unmatched ownership source patterns:\n${unmatchedSources.join("\n")}`).toEqual([]);
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

  it("declares a source-bound owner for every verified document", () => {
    const ownedDocs = new Set(mappings.flatMap((mapping) =>
      [...mapping.docs, ...(mapping.background ?? [])].map(normalizeDoc).map((doc) => doc.path)));
    const verifiedDocs = getVerifiedDocFiles(REPO_ROOT).map((path) => relative(REPO_ROOT, path));
    expect(verifiedDocs.filter((path) => !ownedDocs.has(path))).toEqual([]);
    for (const path of verifiedDocs) {
      const owners = mappings.filter((mapping) =>
        [...mapping.docs, ...(mapping.background ?? [])].map(normalizeDoc).some((doc) => doc.path === path));
      expect(owners.some((mapping) => matchesAny(path, mapping.sources)), path).toBe(true);
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

  it("covers every tracked depth-two directory with a mapping or exclusion", () => {
    const coveredPatterns = [
      ...mappings.flatMap((mapping) => mapping.sources),
      ...exclusions.flatMap((exclusion) => exclusion.sources),
    ];
    const filesByDirectory = new Map<string, string[]>();
    for (const file of trackedFiles) {
      if (!COVERAGE_ROOTS.some((root) => file.startsWith(root))) continue;
      const parts = file.split("/");
      const directory = parts.slice(0, Math.min(3, parts.length - 1)).join("/");
      if (!directory.includes("/")) continue;
      const group = filesByDirectory.get(directory) ?? [];
      group.push(file);
      filesByDirectory.set(directory, group);
    }
    const uncoveredDirectories = [...filesByDirectory].filter(
      ([, files]) => !files.some((file) => matchesAny(file, coveredPatterns)),
    ).map(([directory]) => directory);
    expect(uncoveredDirectories).toEqual([]);
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
