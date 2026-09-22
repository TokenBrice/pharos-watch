// Type-aware ESLint lane (separate from the fast `npm run lint`).
//
// The default lint is intentionally NOT type-aware (no parserOptions.project) so
// it stays fast and cache-friendly. This lane blocks floating/misused promises
// across runtime backend code and unsafe `any` propagation at external-data
// boundaries, including the frontend library and hook surfaces.
//
// The two tsconfigs are referenced explicitly because the worker is excluded
// from the root tsconfig (D1 type conflicts) and has its own.
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

const TYPED_RULES = {
  "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true, ignoreIIFE: true }],
  "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
};

const UNSAFE_BOUNDARY_RULES = {
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-unsafe-return": "error",
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
    files: [
      "worker/src/lib/**/*.ts",
      "worker/src/lib/**/*.tsx",
      "worker/src/api/**/*.ts",
      "worker/src/api/**/*.tsx",
    ],
    ignores: IGNORES,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./worker/tsconfig.json", tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin, security },
    rules: UNSAFE_BOUNDARY_RULES,
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
  {
    files: [
      "shared/lib/**/*.ts",
      "functions/**/*.ts",
      "functions/**/*.tsx",
      "src/lib/**/*.ts",
      "src/lib/**/*.tsx",
      "src/hooks/**/*.ts",
      "src/hooks/**/*.tsx",
    ],
    ignores: IGNORES,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.typecheck.json", tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin, security },
    rules: UNSAFE_BOUNDARY_RULES,
  },
);
