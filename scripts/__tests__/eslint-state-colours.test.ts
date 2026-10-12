import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cache: false, cwd: process.cwd(), overrideConfigFile: "eslint.config.mjs" });

async function rawPaletteColours(source: string, filePath = "src/components/__state-colour-fixture.tsx") {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.filter((message) => message.ruleId === "pharos/no-raw-palette-colour");
}

describe("pharos/no-raw-palette-colour", () => {
  it.each([
    ["text pair", 'export const A = () => <p className="text-amber-700 dark:text-amber-400">x</p>;', 2],
    ["opacity tint", 'export const c = "bg-red-500/10 border-red-500/30";', 2],
    ["arbitrary opacity", 'export const c = "bg-amber-500/[0.06]";', 1],
    ["side border", 'export const c = "border-l-sky-500/70";', 1],
    ["important", 'export const c = "!fill-rose-400 text-emerald-700!";', 2],
    ["neutral hue", 'export const c = "text-slate-700";', 1],
    ["template chunk", "export const c = `hover:${'x'} bg-emerald-500 px-2`;", 1],
    ["route file", 'export const c = "text-red-700";', 1, "src/app/__state-colour-fixture.tsx"],
    ["lib class constant", 'export const c = "text-red-700";', 1, "src/lib/__state-colour-fixture.ts"],
  ])("rejects %s", async (_name, source, count, filePath?: string) => {
    expect(await rawPaletteColours(source, filePath)).toHaveLength(count);
  });

  it.each([
    ["state utilities", 'export const c = "text-state-warn bg-state-danger-subtle border-state-info bg-state-positive-solid/15";'],
    ["semantic tokens", 'export const c = "text-muted-foreground bg-card border-border/60 text-[color:var(--severity-mild)]";'],
    ["non-colour utilities", 'export const c = "w-500 shadow-sm ring-2 text-sm from-transparent";'],
  ])("allows %s", async (_name, source) => {
    expect(await rawPaletteColours(source)).toEqual([]);
  });

  it.each([
    "shared/lib/classification/__fixture.ts",
    "src/lib/tape-class-style.ts",
    "src/app/pharoswatchbot/__fixture.tsx",
    "src/components/flow-machine-scene-fixture.tsx",
    "src/app/cemetery/__fixture.tsx",
    "src/components/digest-fixture.tsx",
    "src/app/depeg/[event]/__fixture.tsx",
    "src/app/stablecoin/[id]/error.tsx",
  ])("does not apply to %s", async (filePath) => {
    expect(await rawPaletteColours('export const c = "text-amber-700";', filePath)).toEqual([]);
  });
});
