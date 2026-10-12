import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cache: false, cwd: process.cwd(), overrideConfigFile: "eslint.config.mjs" });

async function zIndexMessages(source: string, filePath = "src/components/__z-index-fixture.tsx") {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.filter((message) => message.ruleId === "pharos/no-arbitrary-z-index");
}

describe("pharos/no-arbitrary-z-index", () => {
  it.each([
    ["arbitrary", 'export const A = () => <p className="z-[100]">x</p>;'],
    ["arbitrary variant", 'export const A = () => <p className="sm:z-[5]">x</p>;'],
    ["important", 'export const A = () => <p className="!z-[70]">x</p>;'],
    ["numeric above 10", 'export const A = () => <p className="fixed z-50">x</p>;'],
    ["variant numeric above 10", "export const c = `sm:z-20 flex`;"],
    ["route file", 'export const c = "z-40";', "src/app/__z-index-fixture.tsx"],
  ])("rejects %s", async (_name, source, filePath?: string) => {
    expect(await zIndexMessages(source, filePath)).toHaveLength(1);
  });

  it.each([
    ["local layers", 'export const c = "z-0 z-1 z-5 hover:z-10 -z-10";'],
    ["named layers", 'export const c = "z-chrome z-chrome-dock z-modal focus:z-skip z-toast z-progress";'],
    ["unrelated utilities", 'export const c = "size-10 w-[50px] top-z-50 data-z-[5]";'],
  ])("allows %s", async (_name, source) => {
    expect(await zIndexMessages(source)).toEqual([]);
  });

  it("does not apply outside src/components and src/app", async () => {
    expect(await zIndexMessages('export const c = "z-[100]";', "src/lib/__z-index-fixture.ts")).toEqual([]);
  });
});
