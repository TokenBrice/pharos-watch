import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
    ".worktrees/**",
    ".codex-autorunner/**",
    "next-env.d.ts",
    // Wrangler auto-generated build artifacts
    "worker/.wrangler/**",
  ]),
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
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
    },
  },
  {
    files: ["worker/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
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
      }],
    },
  },
]);

export default eslintConfig;
