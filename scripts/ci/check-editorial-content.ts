import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { createMethodologyVersion } from "@shared/lib/methodology-versions/base";
import { METHODOLOGY_CHANGELOG_REGISTRY } from "@shared/lib/methodology-versions/registry";
import { MINT_AUTHORITY_METHODOLOGY_PATH, MINT_AUTHORITY_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { EDITORIAL_POLICY, scanEditorialText } from "@shared/lib/editorial-style";
import { PUBLIC_ROUTE_PATHS } from "../../src/lib/public-route-inventory";
import { CaseStudyContentSchema, DependencyExposureContentSchema, DependencyMapContentSchema, MethodologyContentSchema, WeeklyContentSchema } from "@shared/types/editorial-content";
import { editorialReferenceIssues } from "../lib/editorial-content";
import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { collectSourceFiles } from "../lib/source-files.mts";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getActiveByArchetype } from "@shared/lib/stablecoins/by-mechanism";
import { resolveMechanismArchetype } from "@shared/lib/classification/resolve-mechanism-archetype";
import { ARCHETYPE_CONTENT } from "../../src/lib/mechanism-explainers";

const USAGE = "Usage: npm run check:editorial-content\nValidate authored JSON content, registry membership, metadata, ADR-3, and internal references.";

function registeredJsonFiles(repoRoot: string, owners: readonly string[]): Set<string> {
  const registered = new Set<string>();
  for (const owner of owners) {
    const path = join(repoRoot, owner);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.endsWith(".json")) {
        registered.add(resolve(dirname(path), statement.moduleSpecifier.text));
      }
    }
  }
  return registered;
}

/**
 * Selector/picker surfaces carry authored prose outside the JSON lanes. Their
 * corpus gate lives here so it runs once in the PR structural lane instead of
 * inside the shared unit suite.
 */
const SELECTOR_EDITORIAL_REQUIRED_TARGETS = [
  "shared/lib/selector/what-to-watch-templates.ts",
  "shared/lib/selector/why-keys.ts",
  "shared/lib/selector",
  "src/app/screener/picker",
  "src/components/selector",
  "scripts/fixtures/selector-editorial-examples.md",
];
const SELECTOR_EDITORIAL_CORPUS_GLOBS = [
  "shared/lib/selector/**/*.ts",
  "src/app/screener/picker/**/*.{ts,tsx}",
  "src/components/selector/**/*.{ts,tsx}",
  "scripts/fixtures/selector-editorial-examples.md",
];
const SELECTOR_EDITORIAL_RULE_IDS = new Set(
  EDITORIAL_POLICY.rules
    .filter(
      (rule) =>
        rule.severity.byRegister?.["analytical-explanation"] !== undefined ||
        rule.id === "no-investment-recommendation",
    )
    .map((rule) => rule.id),
);

export interface SelectorEditorialFinding {
  file: string;
  line: number;
  rule: string;
  match: string;
  excerpt: string;
}

export function discoverSelectorEditorialCorpus(
  root = process.cwd(),
  patterns = SELECTOR_EDITORIAL_CORPUS_GLOBS,
  required = SELECTOR_EDITORIAL_REQUIRED_TARGETS,
): string[] {
  for (const path of required) {
    if (!existsSync(join(root, path))) throw new Error(`required scan target missing: ${path}`);
  }
  return [...new Set(globSync(patterns, { cwd: root }))]
    .filter((path) => !path.split("/").some((part) => part.startsWith(".") || part === "__tests__"))
    .filter((path) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path))
    .map((path) => join(root, path));
}

export function scanSelectorEditorialSource(file: string, source: string): SelectorEditorialFinding[] {
  const findings: SelectorEditorialFinding[] = [];
  const sourceLines = source.split("\n");
  const units: Array<{ text: string; offset: number }> = [];
  if (file.endsWith(".md")) {
    units.push({ text: source, offset: 0 });
  } else {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        units.push({ text: node.text, offset: node.getStart(sourceFile) + 1 });
      } else if (ts.isJsxText(node)) {
        units.push({ text: node.getText(sourceFile), offset: node.getStart(sourceFile) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  for (const unit of units) {
    for (const finding of scanEditorialText(unit.text, { register: "analytical-explanation" })) {
      // Existing universal-rule debt is ratcheted by the repository corpus gate.
      // The Selector surfaces own the Selector-specific central rules only.
      if (!SELECTOR_EDITORIAL_RULE_IDS.has(finding.ruleId)) continue;
      const index = unit.offset + finding.index;
      const line = source.slice(0, index).split("\n").length;
      const excerpt = sourceLines[line - 1] ?? "";
      if (!excerpt.includes("banned-phrase-allow:")) {
        findings.push({ file, line, rule: finding.ruleId, match: finding.excerpt, excerpt: excerpt.trim().slice(0, 160) });
      }
    }
  }
  return findings;
}

/** The explainer fields the guard reads; the authored modules narrow to these. */
export interface MechanismExplainerContent {
  readonly archetype: string;
  readonly representativeCoins: readonly { readonly coinId: string; readonly note: string }[];
  readonly whatToWatch: readonly string[];
}

type MechanismExplainerMeta = Parameters<typeof resolveMechanismArchetype>[0] & {
  readonly pegMechanism?: string | null;
};

export interface MechanismExplainerSources {
  readonly archetypes: readonly string[];
  readonly content: Readonly<Record<string, MechanismExplainerContent>>;
  readonly metaById: ReadonlyMap<string, MechanismExplainerMeta>;
  readonly resolveArchetype: (
    coin: MechanismExplainerMeta,
    registry: ReadonlyMap<string, MechanismExplainerMeta>,
  ) => string | null;
  readonly activeNavMembers: readonly unknown[];
}

/**
 * Authored mechanism-explainer prose is content, not runtime code: every
 * representative coin must resolve to its own archetype, DEWS bullets may not
 * promise coverage the engine skips, and the OUSG note may not contradict the
 * reviewed reserve composition it describes.
 *
 * `overrides` exists so the owning test can drive one rule at a time; the guard
 * itself always runs against the authored sources and the real repo files.
 */
export function mechanismExplainerIssues(
  repoRoot: string,
  overrides: Partial<MechanismExplainerSources> = {},
): string[] {
  const sources: MechanismExplainerSources = {
    archetypes: MECHANISM_ARCHETYPE_VALUES,
    content: ARCHETYPE_CONTENT,
    metaById: TRACKED_META_BY_ID,
    resolveArchetype: resolveMechanismArchetype,
    activeNavMembers: getActiveByArchetype("synthetic-delta-neutral").filter((coin) => coin.flags.navToken),
    ...overrides,
  };
  const issues: string[] = [];
  for (const archetype of sources.archetypes) {
    const content = sources.content[archetype];
    if (content.archetype !== archetype) {
      issues.push(`src/lib/mechanism-explainers: ${archetype} content declares archetype ${content.archetype}`);
    }
    for (const entry of content.representativeCoins) {
      const meta = sources.metaById.get(entry.coinId);
      if (!meta) {
        issues.push(`src/lib/mechanism-explainers: ${archetype} representative coin ${entry.coinId} is not tracked`);
        continue;
      }
      const resolved = sources.resolveArchetype(meta, sources.metaById);
      if (resolved !== archetype) {
        issues.push(`src/lib/mechanism-explainers: ${archetype} representative coin ${entry.coinId} resolves to ${resolved}`);
      }
      if (archetype === "rwa-credit-fund" && /quarterly/i.test(entry.note)) {
        const mechanism = (meta.pegMechanism ?? "").toLowerCase();
        if (!mechanism.includes("quarter")) {
          issues.push(`src/lib/mechanism-explainers: ${entry.coinId} claims quarterly redemptions without a reviewed quarterly mechanism`);
        }
      }
    }
    for (const bullet of content.whatToWatch.filter((entry) => /DEWS/.test(entry))) {
      if (/full[^.]*coverage/i.test(bullet)) {
        issues.push(`src/lib/mechanism-explainers: ${archetype} DEWS bullet claims full coverage: ${bullet}`);
      }
    }
  }

  // NAV wrappers are not scored by DEWS, so its bullet must name that exception.
  if (sources.activeNavMembers.length === 0) {
    issues.push("src/lib/mechanism-explainers: synthetic-delta-neutral has no active NAV wrapper to qualify DEWS coverage");
  }
  const navDewsBullets = sources.content["synthetic-delta-neutral"].whatToWatch.filter((bullet) => /DEWS/.test(bullet));
  if (navDewsBullets.length === 0) {
    issues.push("src/lib/mechanism-explainers: synthetic-delta-neutral DEWS bullet no longer names the NAV exception");
  }
  for (const bullet of navDewsBullets) {
    if (/full/i.test(bullet) || !/NAV/.test(bullet)) {
      issues.push(`src/lib/mechanism-explainers: synthetic-delta-neutral DEWS bullet overstates coverage: ${bullet}`);
    }
  }

  const ousgNote = sources.content.tbill.representativeCoins.find((entry) => entry.coinId === "ousg-ondo-finance")?.note;
  if (!ousgNote) {
    issues.push("src/lib/mechanism-explainers: tbill OUSG example is missing its note");
  } else {
    try {
      const { reserves } = JSON.parse(
        readFileSync(join(repoRoot, "shared/data/stablecoins/domains/reserves/ousg-ondo-finance.json"), "utf8"),
      ) as { reserves: Array<{ name: string; pct: number }> };
      const topReserve = [...reserves].sort((left, right) => right.pct - left.pct)[0]?.name ?? "";
      if (!topReserve.includes("State Street")) {
        issues.push(`src/lib/mechanism-explainers: OUSG reviewed reserves no longer lead with State Street (${topReserve})`);
      }
    } catch (error) {
      issues.push(`shared/data/stablecoins/domains/reserves/ousg-ondo-finance.json: ${String(error)}`);
    }
    if (/mostly BUIDL|FedFund/i.test(ousgNote)) {
      issues.push("src/lib/mechanism-explainers: OUSG note names a reserve mix its reviewed composition contradicts");
    }
    if (!ousgNote.includes("OUSGInstantManager")) {
      issues.push("src/lib/mechanism-explainers: OUSG note no longer names the OUSGInstantManager route");
    }
  }
  return issues;
}

export function checkEditorialContent(repoRoot = process.cwd()): string[] {
  const issues: string[] = [];
  const routes = new Set(PUBLIC_ROUTE_PATHS);
  const references = {
    routes,
    coinIds: new Set(readdirSync(join(repoRoot, "shared/data/stablecoins/coins")).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5))),
    cemeteryIds: new Set<string>((JSON.parse(readFileSync(join(repoRoot, "public/datasets/stablecoin-cemetery.json"), "utf8")).rows as { id: string }[]).map((row) => row.id)),
  };
  const surfaces = [
    { dir: "shared/data/methodology-changelogs", schema: MethodologyContentSchema, owners: ["shared/lib/methodology-versions/registry.ts", "shared/lib/methodology-versions/depeg-resolver.ts", "shared/lib/methodology-versions/mint-authority.ts"] },
    { dir: "src/data/changelogs", schema: WeeklyContentSchema, owners: ["src/data/changelogs/index.ts"] },
    { dir: "src/lib/case-studies", schema: CaseStudyContentSchema, owners: ["src/lib/case-studies/index.ts"] },
  ];
  const validData = new Map<string, unknown>();
  for (const surface of surfaces) {
    const registered = registeredJsonFiles(repoRoot, surface.owners);
    const sources = collectSourceFiles(join(repoRoot, surface.dir), {
      extensions: [".json", ".ts"],
      excludedDirs: ["__tests__"],
      skipDotEntries: true,
    });
    const jsonFiles = new Set(sources.filter((path) => path.endsWith(".json")));
    for (const path of registered) if (!jsonFiles.has(path)) issues.push(`${relative(repoRoot, path)}: Registered content source is missing`);
    for (const path of sources) {
      const label = relative(repoRoot, path);
      if (path.endsWith(".ts")) {
        if (!["index.ts", "types.ts"].includes(basename(path))) issues.push(`${label}: Prose must be authored as JSON, not TypeScript`);
        continue;
      }
      if (!registered.has(path)) issues.push(`${label}: Content source is not registered`);
      let input: unknown;
      try { input = JSON.parse(readFileSync(path, "utf8")); }
      catch (error) { issues.push(`${label}: ${String(error)}`); continue; }
      const parsed = surface.schema.safeParse(input);
      if (!parsed.success) {
        issues.push(...parsed.error.issues.map((issue) => `${label}:${issue.path.join(".")}: ${issue.message}`));
        continue;
      }
      validData.set(label, parsed.data);
      issues.push(...editorialReferenceIssues(parsed.data, references).map((issue) => `${label}:${issue}`));
      if (surface.dir === "src/data/changelogs") {
        const entry = WeeklyContentSchema.parse(parsed.data);
        if (basename(path, ".json") !== entry.dateRange.to) issues.push(`${label}: Filename must match dateRange.to`);
      } else if (surface.dir === "src/lib/case-studies") {
        const study = CaseStudyContentSchema.parse(parsed.data);
        if (basename(path, ".json") !== study.slug) issues.push(`${label}: Filename must match slug`);
      }
    }
  }
  for (const [path, schema] of [
    ["src/app/dependency-map/content.json", DependencyMapContentSchema],
    ["src/lib/dependency-exposure-content.json", DependencyExposureContentSchema],
  ] as const) {
    const parsed = schema.safeParse(JSON.parse(readFileSync(join(repoRoot, path), "utf8")));
    if (!parsed.success) issues.push(...parsed.error.issues.map((issue) => `${path}:${issue.path.join(".")}: ${issue.message}`));
    else issues.push(...editorialReferenceIssues(parsed.data, references).map((issue) => `${path}:${issue}`));
  }
  // Keep the same version factory as runtime consumers; JSON is not an ADR-3 bypass.
  for (const lane of METHODOLOGY_CHANGELOG_REGISTRY) {
    try { createMethodologyVersion({ currentVersion: lane.currentLabel.slice(1), changelogPath: lane.publicPath, changelog: lane.entries }); }
    catch (error) { issues.push(`${lane.publicPath}: ${String(error)}`); }
  }
  issues.push(...mechanismExplainerIssues(repoRoot));
  const mint = validData.get("shared/data/methodology-changelogs/mint-authority/v1.json");
  if (mint) {
    try { createMethodologyVersion({ currentVersion: MINT_AUTHORITY_METHODOLOGY_VERSION, changelogPath: MINT_AUTHORITY_METHODOLOGY_PATH, changelog: MethodologyContentSchema.parse(mint) }); }
    catch (error) { issues.push(`mint-authority: ${String(error)}`); }
  }
  try {
    for (const file of discoverSelectorEditorialCorpus(repoRoot)) {
      for (const finding of scanSelectorEditorialSource(file, readFileSync(file, "utf8"))) {
        issues.push(`${relative(repoRoot, file)}:${finding.line} [${finding.rule}] ${finding.match} — ${finding.excerpt}`);
      }
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  return issues;
}

runDirectCli(import.meta.url, () => {
  const { values } = parseStrictCliArgs(process.argv.slice(2));
  if (writeCliHelpIfRequested(values, USAGE)) return;
  const issues = checkEditorialContent();
  if (issues.length) throw new Error(`Editorial content validation failed:\n${issues.join("\n")}`);
  console.log("Editorial JSON metadata, registry membership, ADR-3, and internal references validated.");
}, { label: "check:editorial-content", usage: USAGE });
