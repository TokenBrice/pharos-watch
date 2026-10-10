import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { createMethodologyVersion } from "@shared/lib/methodology-versions/base";
import { METHODOLOGY_CHANGELOG_REGISTRY } from "@shared/lib/methodology-versions/registry";
import { MINT_AUTHORITY_METHODOLOGY_PATH, MINT_AUTHORITY_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { PUBLIC_ROUTE_PATHS } from "../../src/lib/public-route-inventory";
import { CaseStudyContentSchema, DependencyExposureContentSchema, DependencyMapContentSchema, MethodologyContentSchema, WeeklyContentSchema, editorialReferenceIssues } from "../lib/editorial-content";
import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

const USAGE = "Usage: npm run check:editorial-content\nValidate authored JSON content, registry membership, metadata, ADR-3, and internal references.";

function contentFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name === "__tests__") return [];
    const path = join(root, entry.name);
    return entry.isDirectory() ? contentFiles(path) : entry.name.endsWith(".json") || entry.name.endsWith(".ts") ? [path] : [];
  });
}

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
    const sources = contentFiles(join(repoRoot, surface.dir));
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
  const mint = validData.get("shared/data/methodology-changelogs/mint-authority/v1.json");
  if (mint) {
    try { createMethodologyVersion({ currentVersion: MINT_AUTHORITY_METHODOLOGY_VERSION, changelogPath: MINT_AUTHORITY_METHODOLOGY_PATH, changelog: MethodologyContentSchema.parse(mint) }); }
    catch (error) { issues.push(`mint-authority: ${String(error)}`); }
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
