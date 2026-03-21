import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import security from "eslint-plugin-security";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    ".claude/**",
    ".worktrees/**",
    "worktrees/**",
    ".codex-autorunner/**",
    "next-env.d.ts",
    // Wrangler auto-generated build artifacts
    "worker/.wrangler/**",
  ]),
  {
    plugins: { security },
    rules: {
      ...security.configs.recommended.rules,
      // detect-object-injection flags every obj[variable] access — overwhelmingly
      // false positives in application code (548 hits, none genuine).
      "security/detect-object-injection": "off",
    },
  },
  {
    // Repo-local maintenance scripts intentionally walk dynamic paths inside the
    // checked-out workspace. The security rule is useful for runtime code, but
    // it produces false positives for these controlled CLI scripts.
    files: ["scripts/**/*.mjs"],
    rules: {
      "security/detect-non-literal-fs-filename": "off",
    },
  },
  {
    // Downgrade React Compiler rules to warnings — these flag valid patterns
    // that aren't optimal for the compiler but work correctly at runtime.
    // Suppress no-img-element — static export with unoptimized images makes
    // next/image functionally identical to <img>.
    rules: {
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/incompatible-library": "warn",
      "@next/next/no-img-element": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["worker/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/lib/*",
                "src/lib/*",
                "../src/lib/*",
                "../../src/lib/*",
                "../../../src/lib/*",
                "../../../../src/lib/*",
              ],
              message: "Worker code must import cross-runtime modules from @shared/*, not src/lib/*.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["shared/lib/**/*.ts"],
    ignores: ["shared/lib/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [{
            group: ["@shared/*"],
            message: "Within shared/lib/, use relative imports (./file) instead of @shared/* aliases.",
          }],
        },
      ],
    },
  },
]);

export default eslintConfig;
