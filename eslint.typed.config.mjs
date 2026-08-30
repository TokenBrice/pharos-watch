// Type-aware ESLint lane (separate from the fast `npm run lint`).
//
// The default lint is intentionally NOT type-aware (no parserOptions.project) so
// it stays fast and cache-friendly. This lane runs the small set of typed rules
// that require type information — chiefly floating/misused promises, which the
// audit flagged as an unguarded gap on worker async / D1 / ctx.waitUntil paths.
//
// Scope is the runtime backend surface (worker + Pages Functions +
// runtime-neutral shared logic), where an unawaited promise is a real
// correctness/observability hazard. The two tsconfigs are referenced explicitly
// because the worker is excluded from the root tsconfig (D1 type conflicts) and
// has its own.
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

const TYPED_RULES = {
  "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true, ignoreIIFE: true }],
  "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
};

const IGNORES = [
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/test-helpers/**",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.ts",
  "**/*.generated.ts",
];

export default tseslint.config(
  {
    // Source files carry inline disables for the main config's `security/*`
    // rules; register the plugin (rules off) so those directives resolve, and
    // don't report them as unused — they're live in the fast lane.
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  {
    files: ["worker/src/**/*.ts", "worker/src/**/*.tsx"],
    ignores: IGNORES,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./worker/tsconfig.json", tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin, security },
    rules: TYPED_RULES,
  },
  {
    files: ["shared/lib/**/*.ts", "functions/**/*.ts", "functions/**/*.tsx"],
    ignores: IGNORES,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.typecheck.json", tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin, security },
    rules: TYPED_RULES,
  },
);
