import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCiValidateCommands } from "../test-merge-gate.mjs";

function extractRunCommands(yaml) {
  return Array.from(yaml.matchAll(/^\s*-\s+run:\s+(.+)$/gm), (match) => match[1].trim());
}

describe("validate-ci parity", () => {
  it("keeps the shared CI validate workflow aligned with the merge-gate contract", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");

    expect(extractRunCommands(workflow)).toEqual([
      "npm ci",
      ...buildCiValidateCommands(),
    ]);
  });
});
