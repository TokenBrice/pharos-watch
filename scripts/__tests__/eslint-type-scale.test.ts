import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cache: false, cwd: process.cwd(), overrideConfigFile: "eslint.config.mjs" });

async function arbitraryPxSizes(source: string, filePath = "src/components/__type-scale-fixture.tsx") {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.filter((message) => message.ruleId === "pharos/no-arbitrary-text-px");
}

describe("pharos/no-arbitrary-text-px", () => {
  it.each([
    ["plain", 'export const A = () => <p className="text-[11px]">x</p>;'],
    ["variant", 'export const A = () => <p className="sm:text-[10.5px]">x</p>;'],
    ["leading important", 'export const A = () => <p className="!text-[11px]">x</p>;'],
    ["variant important", 'export const A = () => <p className="md:!text-[11px]">x</p>;'],
    ["trailing important", 'export const A = () => <p className="text-[11px]!">x</p>;'],
    ["arbitrary variant", "export const c = `[&_h2]:text-[10px] font-medium`;"],
    ["route file", 'export const c = "text-[12px]";', "src/app/__type-scale-fixture.tsx"],
  ])("rejects %s", async (_name, source, filePath?: string) => {
    expect(await arbitraryPxSizes(source, filePath)).toHaveLength(1);
  });

  it.each([
    ["scale steps", 'export const c = "text-3xs text-2xs sm:text-xs";'],
    ["rem and clamp display sizes", "export const c = `text-[2.1rem] text-[clamp(1rem,2vw,2rem)]`;"],
    ["other px utilities", 'export const c = "w-[11px] max-w-[300px] leading-[11px]";'],
  ])("allows %s", async (_name, source) => {
    expect(await arbitraryPxSizes(source)).toEqual([]);
  });

  it("does not apply outside src/components and src/app", async () => {
    expect(await arbitraryPxSizes('export const c = "text-[11px]";', "src/lib/__type-scale-fixture.ts")).toEqual([]);
  });
});
