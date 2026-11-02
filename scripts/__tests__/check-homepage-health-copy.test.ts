import { describe, expect, it } from "vitest";
import {
  checkHomepageHealthCopy,
  collectHomepageCopyFiles,
  findHomepageHealthCopy,
  isHomepageCopyPath,
} from "../ci/check-homepage-health-copy";
import { withTempRepo } from "./helpers/test-state";

const CALM_HOMEPAGE = {
  "src/app/page.tsx": "export default function Page() { return <main>Updating</main>; }",
  "src/components/home-alt-hero.tsx": "export const Hero = () => <p>Market pulse</p>;",
  // Excluded from the guard: the wrapper owns the neutral crash fallback.
  "src/components/home-section-error-boundary.tsx": "export const notice = 'temporarily unavailable';",
  "src/components/home-alt-mini-cards/peg-health-card.tsx": "export const Card = () => <p>Peg data</p>;",
};

describe("homepage health copy guard", () => {
  it("accepts calm authored homepage source", () => {
    withTempRepo("pharos-homepage-copy", CALM_HOMEPAGE, (cwd) => {
      const stdout: string[] = [];
      expect(checkHomepageHealthCopy({
        cwd,
        stdout: { write: (text) => stdout.push(text) },
        stderr: { write: () => { throw new Error("Unexpected failure output"); } },
      })).toBe(0);
      expect(stdout.join("")).toContain("3 files scanned");
      expect(findHomepageHealthCopy(collectHomepageCopyFiles(cwd), cwd)).toEqual([]);
    });
  });

  it("reports warning phrases and JSX state text with the offending file", () => {
    withTempRepo("pharos-homepage-copy", {
      ...CALM_HOMEPAGE,
      "src/app/page.tsx": "export const notice = 'Data quality warning';",
      "src/components/home-alt-hero.tsx": "export const Hero = () => <p>Data is stale</p>;",
    }, (cwd) => {
      expect(findHomepageHealthCopy(collectHomepageCopyFiles(cwd), cwd)).toEqual([
        { file: "src/app/page.tsx", match: "Data quality warning" },
        { file: "src/components/home-alt-hero.tsx", match: ">Data is stale<" },
      ]);
      expect(checkHomepageHealthCopy({
        cwd,
        stdout: { write: () => { throw new Error("Unexpected passing output"); } },
        stderr: { write: () => {} },
      })).toBe(1);
    });
  });

  it("selects the authored homepage surfaces, not every component", () => {
    for (const file of [
      "src/app/page.tsx",
      "src/components/home-alt-hero.tsx",
      "src/components/homepage-title.tsx",
      "src/components/home-alt-mini-cards/peg-health-card.tsx",
      "scripts/ci/check-homepage-health-copy.ts",
    ]) expect(isHomepageCopyPath(file), file).toBe(true);
    for (const file of [
      "src/components/stablecoin-table.tsx",
      "src/components/home-section-error-boundary.tsx",
      "src/components/home-alt-mini-cards/fixture.json",
      "src/app/depeg/page.tsx",
    ]) expect(isHomepageCopyPath(file), file).toBe(false);
  });
});
