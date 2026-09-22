import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
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
  const fixtureDirectory = mkdtempSync(resolve(process.cwd(), "src/lib/typed-lint-fixture-"));
  const unsafePath = resolve(fixtureDirectory, "unsafe.ts");
  const safePath = resolve(fixtureDirectory, "safe.ts");
  writeFileSync(unsafePath, UNSAFE_EXTERNAL_DATA);
  writeFileSync(safePath, REVIEWED_UNKNOWN_DECODER);

  try {
    const eslint = new ESLint({
      cache: false,
      cwd: process.cwd(),
      overrideConfigFile: "eslint.typed.config.mjs",
    });
    const results = await eslint.lintFiles([unsafePath, safePath]);
    const unsafeResult = results.find((result) => basename(result.filePath) === "unsafe.ts");
    const safeResult = results.find((result) => basename(result.filePath) === "safe.ts");

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
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});
