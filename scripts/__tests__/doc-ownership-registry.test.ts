import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectMarkdownReferences,
  mergeMarkdownSectionRanges,
  parseMarkdownSections,
  requiresDocNavigation,
  resolveMarkdownSectionRange,
  type MarkdownSections,
} from "../lib/doc-markdown.mts";
import { getVerifiedDocFiles } from "../lib/doc-files.mts";
import { createOwnershipGlobMatcher, enumerateDocReferences, type DocReference as StructuredDocReference, type ReadingSelector } from "../lib/doc-ownership-registry.mts";
import { assertExecutableTestFiles } from "../lib/critical-ownership.mts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const COVERAGE_ROOTS = ["src/", "shared/", "worker/", "functions/", "scripts/", "docs/", ".github/"];
const SPECIFIC_COVERAGE_THRESHOLD = 80;

type DocReference = string | StructuredDocReference;
type RegistryMapping = {
  alsoRead?: string[];
  background?: DocReference[];
  checks?: string[];
  docs: DocReference[];
  reading?: ReadingSelector[];
  required?: StructuredDocReference[];
  id: string;
  sources: string[];
  tier?: "specific" | "fallback";
  testOwnership?: Array<{ sources: string[]; tests: string[] }>;
};
type RegistryExclusion = { reason: string; sources: string[] };
type OwnershipRegistry = {
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

function collectFailure(failures: string[], label: string, assertion: () => void): void {
  try { assertion(); } catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
}

describe("Markdown section ranges", () => {
  it("uses renderer slugs, UTF-8 source, nested sections, and global duplicate headings", () => {
    const content = "# Guide\n\n## Café\né😀\n### Child\nnested\n## Café\nsecond\n# End\n";
    const document = parseMarkdownSections(content);
    expect([...document.sections.keys()]).toEqual([...collectMarkdownReferences(content).anchors]);
    const first = resolveMarkdownSectionRange(document, "café");
    expect(first).toEqual({ startLine: 2, endLine: 6, start: content.indexOf("## Café"), end: content.lastIndexOf("## Café") });
    const section = content.slice(first.start, first.end);
    expect(section).toBe("## Café\né😀\n### Child\nnested\n");
    expect(Buffer.byteLength(section, "utf8")).toBeGreaterThan(section.length);
    const second = resolveMarkdownSectionRange(document, "café-1");
    expect(content.slice(second.start, second.end)).toBe("## Café\nsecond\n");
    const child = resolveMarkdownSectionRange(document, "child");
    expect(content.slice(child.start, child.end)).toBe("### Child\nnested\n");
  });

  it("ignores backtick and tilde fenced headings and supports renderer setext headings", () => {
    const content = "# Guide\n## Real\n```md\n## Fake\n```\n~~~md\n# Also fake\n~~~\nText\n## Next\nend\n\nSetext\n======\nlast";
    const document = parseMarkdownSections(content);
    expect([...document.sections.keys()]).toEqual(["guide", "real", "next", "setext"]);
    const range = resolveMarkdownSectionRange(document, "real");
    expect(content.slice(range.start, range.end)).toBe("## Real\n```md\n## Fake\n```\n~~~md\n# Also fake\n~~~\nText\n");
    const setext = resolveMarkdownSectionRange(document, "setext");
    expect(content.slice(setext.start, setext.end)).toBe("Setext\n======\nlast");
    expect(() => resolveMarkdownSectionRange(document, "fake")).toThrow("Missing Markdown anchor: #fake");
  });

  it("preserves the legacy join-without-final-newline section budget convention", () => {
    const document = parseMarkdownSections("# Guide\n## One\né\n## Two\nlast\n");
    const range = resolveMarkdownSectionRange(document, "one");
    const legacy = document.lines.slice(range.startLine, range.endLine).join("\n");
    expect(legacy).toBe("## One\né");
    expect(Buffer.byteLength(legacy)).toBe(9);
    expect(Buffer.byteLength(document.content.slice(range.start, range.end))).toBe(10);
    const last = resolveMarkdownSectionRange(document, "two");
    expect(document.lines.slice(last.startLine, last.endLine).join("\n")).toBe("## Two\nlast\n");
  });

  it("unions overlapping and adjacent sections without mutating source ranges", () => {
    const document = parseMarkdownSections("# Guide\n## One\none\n### Child\nchild\n## Two\ntwo\n# End\n");
    const one = resolveMarkdownSectionRange(document, "one");
    const child = resolveMarkdownSectionRange(document, "child");
    const two = resolveMarkdownSectionRange(document, "two");
    const original = { ...one };
    expect(mergeMarkdownSectionRanges([two, child, one, one])).toEqual([
      { ...one, end: two.end, endLine: two.endLine },
    ]);
    expect(one).toEqual(original);
    expect(mergeMarkdownSectionRanges([child, document.whole, two])).toEqual([document.whole]);
    expect(mergeMarkdownSectionRanges([])).toEqual([]);
  });
});

describe("ownership reference enumeration", () => {
  it("retains every selector mode, required ref and runbook label for downstream consumers", () => {
    const runbook: StructuredDocReference = { path: "docs/runbooks/selector.md",
      runbook: { label: "Selector recovery", kind: "procedure" } };
    const mapping = {
      docs: ["default.md"], background: ["background.md"], required: [{ path: "required.md" }],
      reading: [{ sources: ["src/**"], local: [runbook], contract: [{ path: "contract.md" }],
        required: [{ path: "selector-required.md", anchor: "rule" }] }],
    };
    expect(enumerateDocReferences(mapping)).toEqual([
      { path: "default.md" }, { path: "required.md" }, runbook, { path: "contract.md" },
      { path: "selector-required.md", anchor: "rule" }, { path: "background.md" },
    ]);
    expect(enumerateDocReferences(mapping, { includeBackground: false }).map((reference) => reference.path))
      .toEqual(["default.md", "required.md", runbook.path, "contract.md", "selector-required.md"]);
  });
});

describe("doc-ownership registry integrity", () => {
  it("keeps unconditional root guidance and hints out of the routing model", () => {
    expect(ownership).not.toHaveProperty("baseDocs");
    expect(ownership).not.toHaveProperty("coreRules");
    for (const mapping of mappings) expect(mapping, mapping.id).not.toHaveProperty("hints");
  });

  it("authors only exceptional checks, leaving baseline selectors authoritative", () => {
    for (const mapping of mappings) {
      for (const command of mapping.checks ?? []) {
        expect(command, mapping.id).not.toMatch(/^npm run (?:lint:changed|typecheck(?::worker)?|check:(?:stablecoin-data|site-csp-sync|cron-sync|cron-connections|migrations|doc-sync|generated-artifacts))(?: |$)/);
      }
    }
    expect(mappings.find((mapping) => mapping.id === "stablecoin-registry")?.checks)
      .toContain("npm run check:failure-scenarios");
  });

  it("selects every owned scoring source instead of falling back to the broad publication roster", () => {
    const scoring = mappings.find((mapping) => mapping.id === "safety-score-v9");
    expect(scoring).toBeDefined();
    const owned = trackedFiles.filter((file) => matchesAny(file, scoring!.sources));
    expect(owned.length).toBeGreaterThan(0);
    for (const file of owned) {
      expect(scoring!.reading?.some((selector) => matchesAny(file, selector.sources)), file).toBe(true);
    }
  });

  it("keeps distinct scoring-document inputs explicitly selected by their existing owners", () => {
    for (const file of [
      "docs/safety-score-map.md", "docs/process/report-cards-appendix.md",
      "docs/report-cards.md", "docs/process/report-cards-evidence-log.md",
    ]) {
      const owner = mappings.find((mapping) =>
        mapping.tier !== "fallback" && matchesAny(file, mapping.sources) &&
        mapping.reading?.some((selector) => matchesAny(file, selector.sources)),
      );
      expect(owner, file).toBeDefined();
    }
  });

  it("routes price-gap review coverage to the pricing owner and its active-coverage appendix", () => {
    const file = "worker/src/lib/stablecoin-publication-coverage.ts";
    const pricing = mappings.find((mapping) => mapping.id === "pricing-pipeline");
    expect(pricing && matchesAny(file, pricing.sources)).toBe(true);
    const selector = pricing!.reading?.find((entry) => matchesAny(file, entry.sources));
    expect(selector?.local).toContainEqual({
      path: "docs/process/pricing-pipeline-appendix.md", anchor: "active-price-coverage-health",
    });
    expect(pricing!.required).toContainEqual({ path: "docs/architecture.md", anchor: "adr-3" });
  });

  it("routes the generated llms index to bounded frontend discovery sections", () => {
    const file = "public/llms.txt";
    const frontend = mappings.find((mapping) => mapping.id === "frontend-routes");
    expect(frontend && matchesAny(file, frontend.sources)).toBe(true);
    const selector = frontend!.reading?.find((entry) => matchesAny(file, entry.sources));
    expect(selector?.local).toEqual([
      { path: "docs/architecture.md", anchor: "frontend-runtime-and-seo-surface" },
      { path: "docs/stablecoin-detail-page.md", anchor: "route-shape" },
    ]);
  });

  it("routes the public licence text and About principles copy to the About contract", () => {
    const about = mappings.find((mapping) => mapping.id === "about-page");
    expect(about).toBeDefined();
    for (const file of ["LICENSE", "src/lib/about-principles-content.ts"]) {
      expect(about && matchesAny(file, about.sources), file).toBe(true);
    }
  });

  it("keeps Functions in CI check ownership while selecting runtime and applicable proxy contracts", () => {
    const policy = mappings.find((mapping) => mapping.id === "validation-ci-policy");
    expect(policy?.sources).toContain("functions/**");
    expect(policy?.checks).toEqual(["npx vitest run scripts/__tests__"]);
    const generic = policy?.reading?.find((selector) => selector.sources.includes("functions/**"));
    expect(generic?.local).toEqual([
      { path: "docs/architecture.md", anchor: "pages-function-endpoints-not-worker-api" },
      { path: "docs/worker-infrastructure.md", anchor: "http-request-handling-entry" },
    ]);
    const refs = enumerateDocReferences(policy!);
    expect(refs).toEqual(expect.arrayContaining([
      { path: "docs/operator-origin-access.md", anchor: "pages-functions-proxy" },
      { path: "docs/process/worker-infrastructure-appendix.md", anchor: "site-data-auth" },
      { path: "docs/deployment-process.md", anchor: "ci-deploy-sequence" },
    ]));
    expect(policy?.background).toContainEqual({ path: "docs/testing.md", anchor: "ci-pipeline" });
  });

  const references: Array<{ path: string; anchor?: string }> = [
    ...mappings.flatMap((mapping) => [
      ...enumerateDocReferences(mapping),
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
  it("routes every verified doc under docs through a primary or background reference", () => {
    const routedDocs = new Set(mappings.flatMap((mapping) => enumerateDocReferences(mapping)).map((reference) => reference.path));
    const unrouted = getVerifiedDocFiles(REPO_ROOT)
      .map((path) => relative(REPO_ROOT, path))
      .filter((path) => path.startsWith("docs/") && !routedDocs.has(path));
    expect(unrouted, "Every verified doc needs a docs/background/reading/required owner, not just a source glob").toEqual([]);
  });
  it("keeps primary Markdown sections within 25KB and ratchets legacy exceptions", () => {
    // Existing out-of-scope sections only. Remove entries once bounded; new
    // primary sections must stay within 25KB.
    const legacySectionCeilings: Record<string, number> = {
      "docs/digest-pipeline.md#generation": 32_723,
    };
    const remainingExceptions = new Set(Object.keys(legacySectionCeilings));
    const domainIds = [
      "live-reserves", "yield-intelligence", "homepage", "about-page",
      "coverage-page", "start-page", "feedback-pipeline", "compliance", "worker-admin-api",
    ];
    const documentCache = new Map<string, MarkdownSections>();
    const failures: string[] = [];
    // Every section is visited before asserting; an unreadable document or
    // anchor is reported with its path and never counted as an in-budget section.
    const check = (label: string, assertion: () => void) => collectFailure(failures, label, assertion);
    for (const mapping of mappings) {
      const newDomain = domainIds.includes(mapping.id);
      if (newDomain) check(mapping.id, () => expect(mapping.checks ?? [], mapping.id).toEqual([]));
      for (const reference of enumerateDocReferences(mapping, { includeBackground: false })) {
        if (!reference.path.endsWith(".md")) continue;
        if (newDomain) check(mapping.id, () => expect(reference.anchor, mapping.id).toBeTruthy());
        const key = reference.path + (reference.anchor ? `#${reference.anchor}` : "");
        let bytes: number | undefined;
        check(key, () => {
          let document = documentCache.get(reference.path);
          if (!document) {
            document = parseMarkdownSections(readFileSync(resolve(REPO_ROOT, reference.path), "utf8"));
            documentCache.set(reference.path, document);
          }
          const range = resolveMarkdownSectionRange(document, reference.anchor);
          // Keep the historic byte ratchet: joining selected split lines omits
          // the separator before the next heading, unlike route payload bytes.
          bytes = Buffer.byteLength(document.lines.slice(range.startLine, range.endLine).join("\n"));
        });
        if (bytes === undefined) {
          // Track the exception independently of a successful read.
          remainingExceptions.delete(key);
          continue;
        }
        const measured = bytes;
        check(key, () => expect(measured, key).toBeLessThanOrEqual(newDomain ? 25_000 : legacySectionCeilings[key] ?? 25_000));
        if (Object.hasOwn(legacySectionCeilings, key)) {
          check(key, () => expect(measured, `Remove resolved section exception: ${key}`).toBeGreaterThan(25_000));
          remainingExceptions.delete(key);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
    expect([...remainingExceptions], "Remove exceptions no longer routed as primary sections").toEqual([]);
  });
  it("collects every failing assertion instead of stopping at the first", () => {
    const failures: string[] = [];
    collectFailure(failures, "oversized-a", () => expect(30_000, "a").toBeLessThanOrEqual(25_000));
    collectFailure(failures, "missing-b", () => { throw new Error("ENOENT: docs/missing.md"); });
    collectFailure(failures, "oversized-c", () => expect(26_000, "c").toBeLessThanOrEqual(25_000));
    collectFailure(failures, "fits-d", () => expect(1_000, "d").toBeLessThanOrEqual(25_000));
    expect(failures).toHaveLength(3);
    expect(failures.map((failure) => failure.split(":")[0])).toEqual(["oversized-a", "missing-b", "oversized-c"]);
    expect(failures[1]).toContain("docs/missing.md");
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
