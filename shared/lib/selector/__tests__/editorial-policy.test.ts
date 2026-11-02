import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EDITORIAL_POLICY } from "../../editorial-style";
import {
  discoverSelectorEditorialCorpus as discover,
  scanSelectorEditorialSource as scan,
} from "../../../../scripts/ci/check-editorial-content";

const SELECTOR_RULE_IDS = new Set(
  EDITORIAL_POLICY.rules
    .filter(
      (rule) =>
        rule.severity.byRegister?.["analytical-explanation"] !== undefined ||
        rule.id === "no-investment-recommendation",
    )
    .map((rule) => rule.id),
);

const tempRoots: string[] = [];
afterEach(() => tempRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("selector editorial policy", () => {
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

  it("scans TS/TSX literals and every interpolated template segment at its source line", () => {
    const source = [
      'const ordinary = "Buy USDC";',
      'const plain = `Buy USDC`;',
      'const template = `Buy USDC ${name}',
      'Buy USDC ${count}',
      'Buy USDC`;',
      'const jsx = <p>Buy USDC</p>;',
      'const allowed = `Buy USDC ${name}`; // banned-phrase-allow: quoted policy',
    ].join("\n");
    expect(scan("fixture.tsx", source).map(({ line, rule }) => ({ line, rule }))).toEqual(
      [1, 2, 3, 4, 5, 6].map((line) => ({ line, rule: "no-investment-recommendation" })),
    );
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
