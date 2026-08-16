import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import security from "eslint-plugin-security";

const layoutScriptRestrictedSyntax = [
  {
    selector:
      "JSXOpeningElement[name.name='Script'] > JSXAttribute[name.name='strategy'][value.value='beforeInteractive']",
    message:
      "beforeInteractive Script in a layout file matches a phishing-kit signature on every static page. Move the logic into a route-scoped client component instead.",
  },
  {
    // Inline executable <script>. JSON-LD (`type="application/ld+json"`)
    // is data, not code — explicitly allowed.
    selector:
      "JSXOpeningElement[name.name='script']:not(:has(JSXAttribute[name.name='type'][value.value='application/ld+json']))",
    message:
      "Inline executable <script> in a layout file matches phishing-kit signatures on every static page. Use next/script in a route-scoped client component, or render an external script src.",
  },
];

const apiPathRestrictedSyntax = [
  {
    selector: "CallExpression[callee.type!='MemberExpression'] > Literal[value=/^\\/api\\//]",
    message: "Use API_PATHS or FRONTEND_API_QUERY_DESCRIPTORS instead of a /api/ string literal.",
  },
  {
    selector: "CallExpression[callee.type!='MemberExpression'] > TemplateLiteral > TemplateElement[value.cooked=/^\\/api\\//]",
    message: "Use API_PATHS or FRONTEND_API_QUERY_DESCRIPTORS instead of a /api/ template literal.",
  },
];

// Everything outside `worker/` that ESLint lints. Kept as one list so the
// ADR-2 frontend→worker ban and any block that overrides `no-restricted-imports`
// for a subset of these paths stay in sync (flat config *replaces* a rule's
// options when two config objects match the same file, it does not merge them).
const NON_WORKER_SOURCE_GLOBS = [
  "src/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
  "shared/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
  "scripts/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
  "functions/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
];

// ADR-2, frontend→worker half: nothing under src/, shared/, scripts/ or
// functions/ may reach into worker/src/. The reviewed exceptions are the
// `BOUNDARY_WAIVERS` registry in `scripts/ci/check-worker-import-boundary.ts`
// (capped at MAX_BOUNDARY_WAIVERS, documented in
// docs/process/boundary-waivers.md); that script cross-checks that every waived
// file is ignored here, so the two lists cannot drift apart.
const frontendToWorkerRestrictedImportPatterns = [
  {
    group: ["worker/src", "worker/src/**", "**/worker/src", "**/worker/src/**"],
    message:
      "ADR-2: src/, shared/, scripts/ and functions/ must not import worker/src/**. Promote runtime-neutral logic into shared/ instead, or add a reviewed entry to BOUNDARY_WAIVERS (docs/process/boundary-waivers.md).",
  },
];

// Waived by docs/process/boundary-waivers.md → keep in sync with
// BOUNDARY_WAIVERS in scripts/ci/check-worker-import-boundary.ts.
const FRONTEND_TO_WORKER_WAIVED_FILES = ["scripts/ci/check-frozen-invariants.ts"];

// Cached StablecoinData current-supply reads in route/component/API code go
// through `getCirculatingRaw()`; `sumPegBuckets` is the raw bucket adder and
// belongs to the ingestion/normalization layer that builds those objects.
const supplyHelperRestrictedImportPaths = [
  {
    name: "@shared/lib/supply",
    importNames: ["sumPegBuckets"],
    message: "Route/component/API StablecoinData current supply should use getCirculatingRaw(), not sumPegBuckets().",
  },
];

// Raw-bucket parsers that legitimately sum peg buckets before a StablecoinData
// object exists. Ported verbatim from the retired
// `scripts/ci/check-supply-helper-usage.mjs` waiver list:
//   - backfill-depegs-extraction.ts       — parses raw DefiLlama token-history bucket rows.
//   - stablecoin-detail/cache-fallback.ts — sums a caller-provided fallback bucket map.
//   - backfill-supply-history.ts          — normalizes raw DefiLlama detail/history bucket maps.
const SUPPLY_HELPER_WAIVED_FILES = [
  "worker/src/api/backfill-depegs-extraction.ts",
  "worker/src/api/stablecoin-detail/cache-fallback.ts",
  "worker/src/api/backfill-supply-history.ts",
];

const workerRestrictedImportPaths = [
  // Bare "viem" re-exports clients/transports; force the codec-only entry point.
  {
    name: "viem",
    message: "Worker code may only import pure ABI codecs from viem/utils, not bare viem (clients/transports).",
  },
];

const workerRestrictedImportPatterns = [
  {
    group: ["@/lib/*", "src/lib/*", "../src/lib/*", "../../src/lib/*", "../../../src/lib/*", "../../../../src/lib/*"],
    message: "Worker code must import cross-runtime modules from @shared/*, not src/lib/*.",
  },
  {
    // Worker only needs viem's pure ABI codecs from viem/utils. Any other viem
    // subpath (clients/transports/actions) would pull the websocket transport
    // surface (and its `ws` advisory) into the bundle. Keep viem/utils allowed.
    group: ["viem/*", "!viem/utils"],
    message: "Worker code may only import pure ABI codecs from viem/utils, not viem clients/transports.",
  },
];

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
    // Gate/tooling caches (e.g. the local Worker bundle proof) are
    // gitignored build outputs, never lintable source.
    ".cache/**",
    ".claude/**",
    ".worktrees/**",
    "worktrees/**",
    ".codex-autorunner/**",
    "next-env.d.ts",
    // Wrangler auto-generated build artifacts
    "worker/.wrangler/**",
    // Local-only agent scratch + planning artifacts (gitignored per repo convention)
    "agents/**",
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
    files: ["scripts/**/*.{mjs,ts}"],
    rules: {
      "security/detect-non-literal-fs-filename": "off",
    },
  },
  {
    // React Compiler rules flag patterns that are merely suboptimal for the
    // compiler, but `lint` runs with --max-warnings=0, so a "warn" tier fails
    // the gate exactly like "error" would. Keep these as errors so the
    // configured severity matches actual enforcement; use a scoped
    // eslint-disable with justification for the rare legitimate exception.
    // Suppress no-img-element — static export with unoptimized images makes
    // next/image functionally identical to <img>.
    rules: {
      "react-hooks/preserve-manual-memoization": "error",
      "react-hooks/set-state-in-effect": "error",
      "react-hooks/purity": "error",
      "react-hooks/incompatible-library": "error",
      "@next/next/no-img-element": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Root layouts ship to every static page, so inline scripts here are seen
    // by classifiers on URLs that have no legitimate need for the pattern.
    // `beforeInteractive` inline scripts in particular match credential-
    // harvesting phishing-kit signatures (read hash → parse token → store in
    // window global → replaceState). Keep token / URL-fragment handling
    // route-scoped via a client component on the page that actually needs it.
    files: ["src/app/**/layout.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...layoutScriptRestrictedSyntax],
    },
  },
  {
    files: ["worker/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: workerRestrictedImportPaths, patterns: workerRestrictedImportPatterns },
      ],
    },
  },
  {
    // Worker API handlers additionally answer to the canonical-supply rule. The
    // three raw-bucket parsers are excluded from this block, which drops them
    // back onto the plain worker restrictions above.
    files: ["worker/src/api/**/*.{ts,tsx}"],
    ignores: SUPPLY_HELPER_WAIVED_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [...workerRestrictedImportPaths, ...supplyHelperRestrictedImportPaths],
          patterns: workerRestrictedImportPatterns,
        },
      ],
    },
  },
  {
    files: NON_WORKER_SOURCE_GLOBS,
    ignores: FRONTEND_TO_WORKER_WAIVED_FILES,
    rules: {
      "no-restricted-imports": ["error", { patterns: frontendToWorkerRestrictedImportPatterns }],
    },
  },
  {
    files: ["shared/lib/**/*.ts"],
    ignores: ["shared/lib/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@shared/*"],
              message: "Within shared/lib/, use relative imports (./file) instead of @shared/* aliases.",
            },
            ...frontendToWorkerRestrictedImportPatterns,
          ],
        },
      ],
    },
  },
  {
    // Route and component code reads cached StablecoinData supply through
    // getCirculatingRaw(). Re-states the ADR-2 patterns because flat config
    // replaces rule options rather than merging them.
    files: ["src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: supplyHelperRestrictedImportPaths,
          patterns: frontendToWorkerRestrictedImportPatterns,
        },
      ],
    },
  },
  {
    // Force callers to route /api/ paths through the shared registry so the
    // surface stays grep-able and typed. The selector only catches literals
    // passed as function-call arguments — object/JSX-attribute literals (doc
    // pages, config tables) are intentionally allowed.
    files: ["src/**/*.{ts,tsx}", "shared/**/*.{ts,tsx}", "worker/**/*.{ts,tsx}", "functions/**/*.{ts,tsx}"],
    ignores: [
      "shared/lib/api-endpoints/**",
      "scripts/**",
      "**/__tests__/**",
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...apiPathRestrictedSyntax],
    },
  },
  {
    // ESLint flat config replaces duplicate rule keys for overlapping files.
    // Re-apply both selector sets for layouts so the broad /api/ literal guard
    // does not disable the site-wide layout script security guard above.
    files: ["src/app/**/layout.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...layoutScriptRestrictedSyntax,
        ...apiPathRestrictedSyntax,
      ],
    },
  },
]);

export default eslintConfig;
