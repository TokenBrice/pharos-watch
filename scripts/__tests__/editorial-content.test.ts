import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkEditorialContent } from "../ci/check-editorial-content";
import { CaseStudyContentSchema, MethodologyContentSchema, WeeklyContentSchema, editorialReferenceIssues } from "../lib/editorial-content";
import { createMethodologyVersion } from "@shared/lib/methodology-versions/base";
import { buildPrStaticCheckPlan } from "../maintenance/run-pr-static-checks";

const load = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const references = { routes: new Set(["/methodology/", "/learn/case-studies/usdc-svb-2023/"]), coinIds: new Set(["usdc-circle"]), cemeteryIds: new Set(["terrausd"]) };

describe("authored editorial JSON", () => {
  it("validates every registered content source and its internal references", () => {
    expect(checkEditorialContent()).toEqual([]);
  });

  it("wires authored JSON validation into the owning structural guard", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    expect(packageJson.scripts["check:structural"].split(" && ")).toContain("npm run check:editorial-content");
    expect(packageJson.scripts["check:editorial-content"]).toContain("scripts/ci/check-editorial-content.ts");
    for (const path of ["shared/data/methodology-changelogs/safety-score/v10.json", "src/data/changelogs/2026-07-27.json", "src/lib/case-studies/usdc-svb-2023.json", "src/app/dependency-map/content.json"]) {
      expect(buildPrStaticCheckPlan([path], { group: "guards" }).commands.map((command) => command.name)).toContain("check:structural");
    }
  });

  it("validates weekly metadata without normalizing authored values", () => {
    const input = load("src/data/changelogs/2026-07-27.json");
    const parsed = WeeklyContentSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(WeeklyContentSchema.safeParse({ ...parsed, dateRange: { from: "2026-02-30", to: "2026-07-27" } }).success).toBe(false);
    expect(WeeklyContentSchema.safeParse({ ...parsed, summary: [{ ...parsed.summary[0], href: "https://example.com" }] }).success).toBe(false);
    expect(WeeklyContentSchema.safeParse({ ...parsed, stats: { totalCommits: 0 } }).success).toBe(false);
    expect(WeeklyContentSchema.safeParse({ ...parsed, fieldNotes: Array(81).fill("word").join(" ") }).success).toBe(false);
  });

  it("keeps structured methodology detail shapes and ADR-3 checks", () => {
    const input = load("shared/data/methodology-changelogs/safety-score/v10.json");
    const parsed = MethodologyContentSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(MethodologyContentSchema.safeParse([{ ...parsed[0], detail: [{ kind: "weights", values: ["1", "2"] }] }]).success).toBe(false);
    expect(MethodologyContentSchema.safeParse([{ ...parsed[0], detail: [{ kind: "unknown", text: "body" }] }]).success).toBe(false);
    expect(() => createMethodologyVersion({ currentVersion: "10.141", changelogPath: "/methodology/scoring-changelog/", changelog: [{ ...parsed[0], version: "10.141" }] })).toThrow(/two decimal digits/);
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

  it("rejects broken internal links and identity references while retaining external citations", () => {
    expect(editorialReferenceIssues({ href: "/methodology/?mode=detail#safety-scores-methodology", primaryCoinId: "usdc-circle", source: { href: "https://example.com/report" } }, references)).toEqual([]);
    const issues = editorialReferenceIssues({ href: "/learn/case-studies/missing/", coinId: "missing-coin", cemeteryId: "missing-cemetery", relatedCoinIds: ["missing-related"] }, references);
    expect(issues).toHaveLength(4);
    expect(issues.join("\n")).toContain("Unknown internal route");
    expect(issues.join("\n")).toContain("Unknown coin id");
    expect(issues.join("\n")).toContain("Unknown cemetery id");
  });
});
