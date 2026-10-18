import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import eslintConfig from "../../eslint.config.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
const plugin = eslintConfig.find((config) => config.plugins?.pharos)?.plugins?.pharos;
const rule = plugin?.rules?.["contracts-imports"];
if (!rule) throw new Error("ESLint configuration must register pharos/contracts-imports");
const tester = new RuleTester({ languageOptions: { parser: tsParser } });
const consumer = resolve("src/consumer.ts");
const contract = resolve("shared/contracts/value.ts");

tester.run("pharos/contracts-imports", rule, {
  valid: [
    ...["api-meta", "api-keys", "request-source"].flatMap((subpath) => [
      { code: `import { Value } from "@pharos/contracts/${subpath}";`, filename: consumer },
      { code: `import type { Value } from "@pharos/contracts/${subpath}";`, filename: consumer },
      { code: `export { Value } from "@pharos/contracts/${subpath}";`, filename: resolve("scripts/consumer.ts") },
      { code: `const value = import("@pharos/contracts/${subpath}");`, filename: resolve("worker/src/consumer.ts") },
      { code: `const value = require("@pharos/contracts/${subpath}");`, filename: resolve("functions/consumer.ts") },
      { code: `import Value = require("@pharos/contracts/${subpath}");`, filename: consumer },
      { code: `type Value = import("@pharos/contracts/${subpath}").Value;`, filename: consumer },
    ]),
    { code: 'import { z } from "zod";', filename: contract },
    { code: 'import { Value } from "./api-keys";', filename: contract },
    { code: 'export { Value } from "./api-meta";', filename: contract },
    { code: 'const value = import(`./api-meta`);', filename: contract },
    { code: 'const value = require("./api-meta");', filename: contract },
    { code: 'import { Value } from "../api-meta";', filename: resolve("shared/contracts/internal/value.ts") },
    { code: 'import { Value } from "../contracts-other/value";', filename: consumer },
    { code: 'import { describe } from "vitest"; import { Value } from "@pharos/contracts/api-meta";', filename: resolve("shared/contracts/__tests__/public-api.test.ts") },
  ],
  invalid: [
    ...[
      "@pharos/contracts",
      "@pharos/contracts/private",
      "@pharos/contracts/api-meta/private",
      "@pharos/contracts/api-meta.ts",
      "@pharos/contracts/package.json",
      "@shared/contracts",
      "@shared/contracts/api-meta",
      "@shared/types/../contracts/api-meta",
      "../shared/contracts/api-meta",
      "shared/contracts/api-meta",
      resolve("shared/contracts/api-meta.ts"),
      new URL("../../shared/contracts/api-meta.ts", import.meta.url).href,
    ].flatMap((specifier) => [
      `import type { Value } from ${JSON.stringify(specifier)};`,
      `export { Value } from ${JSON.stringify(specifier)};`,
      `export * from ${JSON.stringify(specifier)};`,
      `const value = import(${JSON.stringify(specifier)});`,
      `const value = require(${JSON.stringify(specifier)});`,
      `import Value = require(${JSON.stringify(specifier)});`,
      `type Value = import(${JSON.stringify(specifier)}).Value;`,
    ]).map((code) => ({ code, filename: consumer, errors: [{ messageId: "public" }] })),
    { code: 'const value = import(`@shared/contracts/api-meta`);', filename: consumer, errors: [{ messageId: "public" }] },
    { code: 'const value = require(`@pharos/contracts/private`);', filename: consumer, errors: [{ messageId: "public" }] },
    ...[
      "../lib/value", "../types/value", "../data/value", "../../src/value", "../../worker/src/value",
      "@shared/lib/value", "@pharos/contracts/api-meta", "zod/v4", "node:fs", "react",
    ].flatMap((specifier) => [
      `import { Value } from ${JSON.stringify(specifier)};`,
      `export * from ${JSON.stringify(specifier)};`,
      `const value = import(${JSON.stringify(specifier)});`,
      `const value = require(${JSON.stringify(specifier)});`,
    ]).map((code) => ({ code, filename: contract, errors: [{ messageId: "dependency" }] })),
    ...[
      "const value = import(path);",
      "const value = import(`./${name}`);",
      "const value = require(path);",
      "const value = require(`./${name}`);",
    ].map((code) => ({ code, filename: contract, errors: [{ messageId: "dynamic" }] })),
  ],
});
