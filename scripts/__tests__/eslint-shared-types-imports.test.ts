import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import eslintConfig from "../../eslint.config.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
const plugin = eslintConfig.find((config) => config.plugins?.pharos)?.plugins?.pharos;
const rule = plugin?.rules?.["shared-types-imports"];
if (!rule) throw new Error("ESLint configuration must register pharos/shared-types-imports");
const tester = new RuleTester({ languageOptions: { parser: tsParser } });
const filename = resolve("shared/types/value.ts");

tester.run("pharos/shared-types-imports", rule, {
  valid: [
    { code: 'import type { StablecoinData } from "@shared/types";', filename: resolve("src/allowed.ts") },
    { code: 'import { type StablecoinData as Row } from "@shared/types";', filename: resolve("src/allowed.ts") },
    { code: 'import { StablecoinListResponseSchema } from "@shared/types/core";', filename: resolve("src/allowed.ts") },
    { code: 'import type { Value } from "@shared/lib/value";', filename: resolve("shared/types/__tests__/value.ts") },
    { code: 'import type { Value } from "../lib/value";', filename: resolve("shared/types/value.test.ts") },
    { code: 'import type { Value } from "./value";', filename },
    { code: 'import type { Value } from "../../lib-other/value";', filename },
    { code: 'import { z } from "zod";', filename: resolve("shared/contracts/api-meta.ts") },
    { code: 'import { Value } from "./api-keys";', filename: resolve("shared/contracts/request-source.ts") },
  ],
  invalid: [
    ...[
      'import { StablecoinListResponseSchema, type StablecoinData } from "@shared/types";',
      'import { StablecoinListResponseSchema as Schema } from "@shared/types";',
    ].map((code) => ({ code, filename: resolve("src/rejected.ts"), errors: [{ messageId: "broad" }] })),
    ...[
      'import type { PricingSourceKey } from "../lib/pricing-source-registry";',
      'import type { Value } from "@shared/lib/value";',
      'import { Value } from "@shared/lib";',
      'export { Value } from "@shared/lib/value";',
      'export type { Value } from "../lib/value";',
      'export * from "../lib/value";',
    ].map((code) => ({ code, filename, errors: [{ messageId: "dependency" }] })),
    ...[
      'import type { Value } from "../lib/value";',
      'export { Value } from "@shared/lib/value";',
      'export * from "../lib/value";',
    ].map((code) => ({ code, filename: resolve("shared/contracts/api-meta.ts"), errors: [{ messageId: "dependency" }] })),
  ],
});
