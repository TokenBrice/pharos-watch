/* eslint-disable security/detect-non-literal-fs-filename -- Test-only repository discovery and temporary fixtures. */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { EDITORIAL_POLICY, scanEditorialText } from "../../editorial-style";

const REQUIRED_TARGETS = [
  "shared/lib/selector/what-to-watch-templates.ts",
  "shared/lib/selector/why-keys.ts",
  "shared/lib/selector",
  "src/app/screener/picker",
  "src/components/selector",
  "scripts/fixtures/selector-editorial-examples.md",
];
const CORPUS_GLOBS = [
  "shared/lib/selector/**/*.ts",
  "src/app/screener/picker/**/*.{ts,tsx}",
  "src/components/selector/**/*.{ts,tsx}",
  "scripts/fixtures/selector-editorial-examples.md",
];
const SELECTOR_RULE_IDS = new Set(
  EDITORIAL_POLICY.rules
    .filter(
      (rule) =>
        rule.severity.byRegister?.["analytical-explanation"] !== undefined ||
        rule.id === "no-investment-recommendation",
    )
    .map((rule) => rule.id),
);
function discover(root = process.cwd(), patterns = CORPUS_GLOBS, required = REQUIRED_TARGETS): string[] {
  for (const path of required) {
    if (!existsSync(join(root, path))) throw new Error(`required scan target missing: ${path}`);
  }
  return [...new Set(globSync(patterns, { cwd: root }))]
    .filter((path) => !path.split("/").some((part) => part.startsWith(".") || part === "__tests__"))
    .filter((path) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path))
    .map((path) => join(root, path));
}

function scan(file: string, source: string) {
  const findings: Array<{ file: string; line: number; rule: string; match: string; excerpt: string }> = [];
  const sourceLines = source.split("\n");
  const units: Array<{ text: string; offset: number }> = [];
  if (file.endsWith(".md")) {
    units.push({ text: source, offset: 0 });
  } else {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) {
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
      // This retained local suite owns the Selector-specific central rules only.
      if (!SELECTOR_RULE_IDS.has(finding.ruleId)) continue;
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

const tempRoots: string[] = [];
afterEach(() => tempRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("selector editorial policy", () => {
  it("keeps the discovered editorial corpus clean", () => {
    const files = discover();
    const findings = files.flatMap((file) => scan(file, readFileSync(file, "utf8")));
    expect(
      findings,
      findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.match}\n${f.excerpt}`).join("\n"),
    ).toEqual([]);
  });

  it("uses every active central-policy rule and honors same-line allows", () => {
    const activeRules = EDITORIAL_POLICY.rules.filter((rule) => SELECTOR_RULE_IDS.has(rule.id));
    for (const rule of activeRules) {
      const findings = scan("fixture.md", rule.examples.violating[0]!);
      expect(findings.map((finding) => finding.rule), rule.id).toContain(rule.id);
    }
    expect(scan("fixture.md", "hold safely // banned-phrase-allow: quoted policy\nBuy USDC.")).toEqual([
      { file: "fixture.md", line: 2, rule: "no-investment-recommendation", match: "Buy USDC", excerpt: "Buy USDC." },
    ]);
    expect(scan("fixture.md", "safer safety safely safeguard unsafe fail-safe")).toEqual([]);
  });

  it("fails missing targets and skips tests, dot dirs, specs, and non-target extensions", () => {
    const root = mkdtempSync(join(tmpdir(), "selector-policy-"));
    tempRoots.push(root);
    for (const dir of ["surface", "surface/__tests__", "surface/.hidden"])
      mkdirSync(join(root, dir), { recursive: true });
    for (const file of [
      "surface/visible.ts",
      "surface/skip.test.ts",
      "surface/skip.spec.ts",
      "surface/skip.md",
      "surface/__tests__/skip.ts",
      "surface/.hidden/skip.ts",
    ])
      writeFileSync(join(root, file), "Buy USDC.", "utf8");
    expect(discover(root, ["surface/**/*.ts"], ["surface"]).map((path) => path.slice(root.length + 1))).toEqual([
      "surface/visible.ts",
    ]);
    expect(() => discover(root, [], ["missing.ts"])).toThrow("required scan target missing: missing.ts");
    expect(() => discover(root, [], ["missing"])).toThrow("required scan target missing: missing");
  });
});
