/* eslint-disable security/detect-non-literal-fs-filename -- Test-only repository discovery and temporary fixtures. */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
const RULES = [
  ["Pharos recommends", /\bPharos\s+recommends?\b/gi, "Pharos recommends"],
  ["Top pick", /\btop\s+pick\b/gi, "top pick"],
  ["Safe (unqualified)", /(?<![A-Za-z-])safe(?![A-Za-z])/gi, "safe"],
  ["Best yield-bearing", /\bbest\s+yield(?:-|\s+)bearing\b/gi, "best yield-bearing"],
  ["Trusted by", /\btrusted\s+by\b/gi, "trusted by"],
  ["Battle-tested", /\bbattle(?:-|\s+)tested\b/gi, "battle-tested"],
  ["Probably/likely/reliably (epistemic hedge)", /\b(?:probably|likely|reliably)\b/gi, "probably"],
  ["We recommend (buy/hold/use)", /\bwe recommend (?:you )?(?:buy|hold|use)\b/gi, "we recommend you buy"],
  ["Easy/simple/convenient", /\b(?:easy|simple|convenient)\b/gi, "easy"],
  [
    "Strongest current reading on that axis",
    /\bstrongest\s+current\s+reading\s+on\s+that\s+axis\b/gi,
    "strongest current reading on that axis",
  ],
  ["Deprecated rail", /\bdeprecated\s+rail\b/gi, "deprecated rail"],
  ["Cannot tolerate", /\bcannot\s+tolerate\b/gi, "cannot tolerate"],
  [
    "Use [X] for [venue/custody/yield/trading]",
    /\buse\s+\w+\s+for\s+(?:venue\s+access|custody|yield|trading)\b/gi,
    "use USDC for custody",
  ],
  ["Surfaced opportunities", /\bsurfaced\s+opportunities\b/gi, "surfaced opportunities"],
  ["Hold safely", /\bhold\s+safely\b/gi, "hold safely"],
  ["Raw whyKey join fallback", /\bwhyKeys\b[^\n]*\.join\s*\(/gi, "whyKeys.join(', ')"],
  ["Raw reasonKey interpolation fallback", /\$\{\s*(?:entry\.)?reasonKey\s*\}/g, "`${entry.reasonKey}`"],
] as const;

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
  for (const [rule, regex] of RULES) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source))) {
      const line = source.slice(0, match.index).split("\n").length;
      const excerpt = source.split("\n")[line - 1];
      if (!excerpt.includes("banned-phrase-allow:"))
        findings.push({ file, line, rule, match: match[0], excerpt: excerpt.trim().slice(0, 160) });
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

  it("reports every rule with actionable diagnostics and honors same-line allows", () => {
    const all = scan("fixture.tsx", RULES.map((rule) => rule[2]).join("\n"));
    expect(RULES).toHaveLength(17);
    expect(new Set(all.map((finding) => finding.rule))).toEqual(new Set(RULES.map((rule) => rule[0])));
    expect(scan("fixture.tsx", "hold safely // banned-phrase-allow: quoted policy\ntop pick")).toEqual([
      { file: "fixture.tsx", line: 2, rule: "Top pick", match: "top pick", excerpt: "top pick" },
    ]);
    expect(
      scan(
        "fixture.tsx",
        "safer safety safely safeguard unsafe fail-safe\nconst whyKeys = []; const reasonKey = 'weak';",
      ),
    ).toEqual([]);
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
      writeFileSync(join(root, file), "top pick", "utf8");
    expect(discover(root, ["surface/**/*.ts"], ["surface"]).map((path) => path.slice(root.length + 1))).toEqual([
      "surface/visible.ts",
    ]);
    expect(() => discover(root, [], ["missing.ts"])).toThrow("required scan target missing: missing.ts");
    expect(() => discover(root, [], ["missing"])).toThrow("required scan target missing: missing");
  });
});
