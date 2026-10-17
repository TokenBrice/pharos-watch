import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

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
  const eslint = new ESLint({ cache: false, cwd: process.cwd(), overrideConfigFile: "eslint.config.mjs" });

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
});
