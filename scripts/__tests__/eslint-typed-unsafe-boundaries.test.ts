import { ESLint } from "eslint";
import { expect, it } from "vitest";

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

it("blocks unsafe external-data operations while permitting a reviewed unknown decoder", async () => {
  const eslint = new ESLint({
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
  const [unsafeResult] = await eslint.lintText(UNSAFE_EXTERNAL_DATA, { filePath });
  const [safeResult] = await eslint.lintText(REVIEWED_UNKNOWN_DECODER, { filePath });

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
});
