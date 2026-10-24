import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cache: false, cwd: process.cwd(), overrideConfigFile: "eslint.config.mjs" });
// DependencyAudit-1 regression: fs-filename is intentionally off globally;
// regex and timing rules must still fire on every linted runtime surface.
const SECURITY_PROBE = `import { readFileSync } from "node:fs";
const target = process.argv[2] ?? "data.json";
const content = readFileSync(target, "utf8");
const unsafe = /(a+)+$/;
const dynamic = new RegExp(target);
const secret = process.env.PROBE_TOKEN ?? "";
if (secret === content) console.log("match");
console.log(unsafe, dynamic);
`;
const RETAINED_SECURITY_RULES = [
  "security/detect-unsafe-regex",
  "security/detect-non-literal-regexp",
  "security/detect-possible-timing-attacks",
];
const UNSAFE_RULES = [
  "@typescript-eslint/no-unsafe-assignment",
  "@typescript-eslint/no-unsafe-member-access",
  "@typescript-eslint/no-unsafe-call",
  "@typescript-eslint/no-unsafe-argument",
  "@typescript-eslint/no-unsafe-return",
];
const UNSAFE_EXTERNAL_DATA = `
function consume(value: string): number {
  return value.length;
}

export function decode(raw: string) {
  const payload = JSON.parse(raw);
  consume(payload);
  payload.value;
  payload.run();
  return payload;
}
`;
const REVIEWED_UNKNOWN_DECODER = `
export function decode(raw: string): string {
  const payload: unknown = JSON.parse(raw);
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("value" in payload) ||
    typeof payload.value !== "string"
  ) {
    throw new TypeError("Expected an object with a string value");
  }
  return payload.value;
}
`;

describe("ESLint config ratchets", () => {

  it("registers inherited React Hooks rules for CommonJS sources", async () => {
    const config = await eslint.calculateConfigForFile("scripts/__commonjs-probe.cjs");
    expect(config.plugins["react-hooks"]).toBeDefined();
    expect(config.rules["react-hooks/preserve-manual-memoization"][0]).toBe(2);
  });

  it("does not lint frozen compiled compatibility readers", async () => {
    expect(await eslint.isPathIgnored("worker/src/api/__tests__/fixtures/pr-b-mint-burn-readers.cjs")).toBe(true);
  });

  // .mts was outside the old scripts/**/*.{mjs,ts} carve-out; retain both sides.
  it.each([
    "scripts/lib/__security-probe.mts",
    "scripts/__security-probe.mjs",
    "scripts/__security-probe.ts",
    "worker/src/__security-probe.ts",
    "src/lib/__security-probe.ts",
    "shared/lib/__security-probe.ts",
  ])("disables fs-filename while retaining regex and timing rules: %s", async (filePath) => {
    const [result] = await eslint.lintText(SECURITY_PROBE, { filePath });
    const ruleIds = result.messages.map((message) => message.ruleId);
    expect(ruleIds, `${filePath} must not report the fs-filename rule`).not.toContain(
      "security/detect-non-literal-fs-filename",
    );
    for (const ruleId of RETAINED_SECURITY_RULES) {
      expect(ruleIds, `${filePath} must still report ${ruleId}`).toContain(ruleId);
    }
  });

  // Cold type-aware ESLint builds the project watch program before either probe;
  // coverage runs have taken ~35s, beyond the shared 20s test budget.
  it("blocks unsafe external-data operations while permitting a reviewed unknown decoder", async () => {
    const typedEslint = new ESLint({
      cache: false,
      cwd: process.cwd(),
      overrideConfigFile: "eslint.typed.config.mjs",
      overrideConfig: {
        languageOptions: {
          // Watch programs typecheck lintText's input, not the on-disk source, even in CI.
          parserOptions: { disallowAutomaticSingleRunInference: true },
        },
      },
    });
    // Reuse an existing project member for scope/type information without changing the source tree.
    const filePath = "src/lib/utils.ts";
    const [unsafeResult] = await typedEslint.lintText(UNSAFE_EXTERNAL_DATA, { filePath });
    const [safeResult] = await typedEslint.lintText(REVIEWED_UNKNOWN_DECODER, { filePath });

    expect(unsafeResult).toBeDefined();
    expect(safeResult).toBeDefined();

    const unsafeMessages = unsafeResult?.messages ?? [];
    for (const ruleId of UNSAFE_RULES) {
      expect(
        unsafeMessages.some((message) => message.ruleId === ruleId && message.severity === 2),
        `${ruleId} must reject its unsafe operation`,
      ).toBe(true);
    }
    expect(safeResult?.messages.filter((message) => message.severity === 2)).toEqual([]);
  }, 60_000);

  const styleProbes: Array<{ rule: string; name: string; source: string; count: number; filePath?: string }> = [
    ...([
      ["text pair", 'export const A = () => <p className="text-amber-700 dark:text-amber-400">x</p>;', 2],
      ["opacity tint", 'export const c = "bg-red-500/10 border-red-500/30";', 2],
      ["arbitrary opacity", 'export const c = "bg-amber-500/[0.06]";', 1],
      ["side border", 'export const c = "border-l-sky-500/70";', 1],
      ["important", 'export const c = "!fill-rose-400 text-emerald-700!";', 2],
      ["neutral hue", 'export const c = "text-slate-700";', 1],
      ["template chunk", "export const c = `hover:${'x'} bg-emerald-500 px-2`;", 1],
      ["route file", 'export const c = "text-red-700";', 1, "src/app/__state-colour-fixture.tsx"],
      ["lib class constant", 'export const c = "text-red-700";', 1, "src/lib/__state-colour-fixture.ts"],
    ] satisfies Array<[string, string, number, string?]>).map(([name, source, count, filePath]) => ({
      rule: "pharos/no-raw-palette-colour", name, source, count,
      filePath: filePath ?? "src/components/__state-colour-fixture.tsx",
    })),
    ...([
      ["plain", 'export const A = () => <p className="text-[11px]">x</p>;'],
      ["variant", 'export const A = () => <p className="sm:text-[10.5px]">x</p>;'],
      ["leading important", 'export const A = () => <p className="!text-[11px]">x</p>;'],
      ["variant important", 'export const A = () => <p className="md:!text-[11px]">x</p>;'],
      ["trailing important", 'export const A = () => <p className="text-[11px]!">x</p>;'],
      ["arbitrary variant", "export const c = `[&_h2]:text-[10px] font-medium`;"],
      ["route file", 'export const c = "text-[12px]";', "src/app/__type-scale-fixture.tsx"],
      ["lib class constant", 'export const c = "text-[11px]";', "src/lib/__type-scale-fixture.ts"],
    ] satisfies Array<[string, string, string?]>).map(([name, source, filePath]) => ({
      rule: "pharos/no-arbitrary-text-px", name, source, count: 1,
      filePath: filePath ?? "src/components/__type-scale-fixture.tsx",
    })),
    ...([
      ["arbitrary", 'export const A = () => <p className="z-[100]">x</p>;'],
      ["arbitrary variant", 'export const A = () => <p className="sm:z-[5]">x</p>;'],
      ["important", 'export const A = () => <p className="!z-[70]">x</p>;'],
      ["numeric above 10", 'export const A = () => <p className="fixed z-50">x</p>;'],
      ["variant numeric above 10", "export const c = `sm:z-20 flex`;"],
      ["route file", 'export const c = "z-40";', "src/app/__z-index-fixture.tsx"],
    ] satisfies Array<[string, string, string?]>).map(([name, source, filePath]) => ({
      rule: "pharos/no-arbitrary-z-index", name, source, count: 1,
      filePath: filePath ?? "src/components/__z-index-fixture.tsx",
    })),
  ];

  it.each(styleProbes)("$rule rejects $name", async ({ rule, source, count, filePath }) => {
    const [result] = await eslint.lintText(source, { filePath });
    expect(result.messages.filter((message) => message.ruleId === rule)).toHaveLength(count);
  });
});
