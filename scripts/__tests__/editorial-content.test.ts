import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { CaseStudyContentSchema, MethodologyContentSchema, WeeklyContentSchema } from "@shared/types/editorial-content";
import type { CaseStudy, MethodologyChangelogDetailBlock, SummaryHref } from "@shared/types/editorial-content";
import { buildPrStaticCheckPlan, STRUCTURAL_CHECKS } from "../maintenance/run-pr-static-checks";
import { checkEditorialContent } from "../ci/check-editorial-content";
import { withTempRepo } from "./helpers/test-state";

const load = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
describe("authored editorial JSON", () => {
  it("keeps inferred recursive readonly views, six weights and internal-path hrefs", () => {
    const weights = { kind: "weights", values: ["1", "2", "3", "4", "5", "6"] } as const;
    const nested = { kind: "section", heading: "Nested", blocks: [weights] } as const satisfies MethodologyChangelogDetailBlock;
    expectTypeOf(nested).toMatchTypeOf<MethodologyChangelogDetailBlock>();
    expectTypeOf<Extract<MethodologyChangelogDetailBlock, { kind: "section" }>["blocks"]>().toEqualTypeOf<readonly MethodologyChangelogDetailBlock[]>();
    expectTypeOf<Extract<MethodologyChangelogDetailBlock, { kind: "weights" }>["values"]>().toEqualTypeOf<readonly [string, string, string, string, string, string]>();
    expectTypeOf<CaseStudy["lead"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<SummaryHref>().toEqualTypeOf<`/${string}`>();
    expectTypeOf<"https://example.com">().not.toMatchTypeOf<SummaryHref>();
    const entry = { version: "1.0", title: "Title", date: "2026-10-19", effectiveAt: 0, summary: "Summary", impact: [], commits: [], reconstructed: false };
    expect(MethodologyContentSchema.parse([{ ...entry, detail: [nested] }])[0].detail).toEqual([nested]);
    expect(MethodologyContentSchema.safeParse([{ ...entry, detail: [{ ...nested, unexpected: true }] }]).success).toBe(false);
    for (const values of [weights.values.slice(1), [...weights.values, "7"]]) {
      expect(MethodologyContentSchema.safeParse([{ ...entry, detail: [{ ...nested, blocks: [{ ...weights, values }] }] }]).success).toBe(false);
    }
    const weekly = WeeklyContentSchema.parse(load("src/data/changelogs/2026-08-02.json"));
    expect(WeeklyContentSchema.safeParse({ ...weekly, summary: [{ ...weekly.summary[0], href: "//example.com" }] }).success).toBe(false);
  });

  it("discovers nested authored JSON and TypeScript with the existing editorial exclusions", () => {
    withTempRepo("pharos-editorial-content", {
      "shared/data/stablecoins/coins/demo.json": "{}",
      "public/datasets/stablecoin-cemetery.json": "{\"rows\":[]}",
      "shared/lib/methodology-versions/registry.ts": "export {};",
      "shared/lib/methodology-versions/depeg-resolver.ts": "export {};",
      "shared/lib/methodology-versions/mint-authority.ts": "export {};",
      "shared/data/methodology-changelogs/index.ts": "export {};",
      "src/data/changelogs/index.ts": "export {};",
      "src/lib/case-studies/index.ts": "export {};",
      "src/lib/case-studies/nested/prose.ts": "export {};",
      "src/lib/case-studies/nested/unregistered.json": "{}",
      "src/lib/case-studies/__mocks__/prose.ts": "export {};",
      "src/lib/case-studies/node_modules/prose.ts": "export {};",
      "src/lib/case-studies/__tests__/ignored.json": "not JSON",
      "src/lib/case-studies/.hidden/ignored.json": "not JSON",
      "src/lib/case-studies/.ignored.json": "not JSON",
      "src/lib/case-studies/ignored.md": "Not authored JSON content.",
      "src/app/dependency-map/content.json": readFileSync("src/app/dependency-map/content.json", "utf8"),
      "src/lib/dependency-exposure-content.json": readFileSync("src/lib/dependency-exposure-content.json", "utf8"),
    }, (cwd) => {
      const issues = checkEditorialContent(cwd);
      for (const path of ["nested/prose.ts", "__mocks__/prose.ts", "node_modules/prose.ts"]) {
        expect(issues).toContain(`src/lib/case-studies/${path}: Prose must be authored as JSON, not TypeScript`);
      }
      expect(issues).toContain("src/lib/case-studies/nested/unregistered.json: Content source is not registered");
      expect(issues.some((issue) => issue.includes("ignored"))).toBe(false);
    });
  });

  it("wires authored JSON validation into the owning structural guard", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    expect(packageJson.scripts["check:structural"]).toBe("node --import tsx scripts/maintenance/run-pr-static-checks.ts --structural");
    expect(STRUCTURAL_CHECKS).toContain("check:editorial-content");
    expect(packageJson.scripts["check:editorial-content"]).toContain("scripts/ci/check-editorial-content.ts");
    for (const path of ["shared/data/methodology-changelogs/safety-score/v10.json", "src/data/changelogs/2026-08-02.json", "src/lib/case-studies/usdc-svb-2023.json", "src/app/dependency-map/content.json"]) {
      expect(buildPrStaticCheckPlan([path], { group: "guards" }).commands.map((command) => command.name)).toContain("check:structural");
    }
  });

  it("validates weekly metadata without normalizing authored values", () => {
    const input = load("src/data/changelogs/2026-08-02.json");
    const parsed = WeeklyContentSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(WeeklyContentSchema.safeParse({ ...parsed, dateRange: { from: "2026-02-30", to: "2026-07-27" } }).success).toBe(false);
    expect(WeeklyContentSchema.safeParse({ ...parsed, dateRange: { from: "2026-10-08", to: "2026-10-08" } }).success).toBe(false);
    expect(WeeklyContentSchema.safeParse({ ...parsed, dateRange: { from: "2026-07-26", to: "2026-08-01" } }).success).toBe(false);
    expect(WeeklyContentSchema.safeParse({ ...parsed, summary: [{ ...parsed.summary[0], href: "https://example.com" }] }).success).toBe(false);
    expect(WeeklyContentSchema.safeParse({ ...parsed, stats: { totalCommits: 0 } }).success).toBe(false);
    expect(WeeklyContentSchema.safeParse({ ...parsed, fieldNotes: Array(81).fill("word").join(" ") }).success).toBe(false);
  });

  it("validates case metadata and section identity without changing prose", () => {
    const input = load("src/lib/case-studies/usdc-svb-2023.json");
    const parsed = CaseStudyContentSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(CaseStudyContentSchema.safeParse({ ...parsed, outcome: "recovered" }).success).toBe(false);
    expect(CaseStudyContentSchema.safeParse({ ...parsed, sections: [parsed.sections[0], parsed.sections[0]] }).success).toBe(false);
    expect(CaseStudyContentSchema.safeParse({ ...parsed, metaDescription: "x".repeat(161) }).success).toBe(false);
  });

  it("preserves section-id acceptance with an unambiguous linear-time validator", () => {
    const study = CaseStudyContentSchema.parse(load("src/lib/case-studies/usdc-svb-2023.json"));
    const section = study.sections[0];
    // eslint-disable-next-line security/detect-unsafe-regex -- Legacy acceptance oracle; only bounded inputs are matched.
    const originalPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    const alphabet = ["a", "0", "-", "A", "_", " ", "\n", "\r", "\u2028", "\u2029"];
    let candidates = [""];
    const accepts = (id: string) => CaseStudyContentSchema.safeParse({ ...study, sections: [{ ...section, id }] }).success;
    for (let length = 0; length <= 3; length++) {
      for (const id of candidates) expect(accepts(id), JSON.stringify(id)).toBe(originalPattern.test(id));
      candidates = candidates.flatMap((prefix) => alphabet.map((character) => prefix + character));
    }
    expect(accepts("a-0-b1")).toBe(true);
    expect(accepts(`a${"-".repeat(10_000)}b`)).toBe(false);
  });

});
