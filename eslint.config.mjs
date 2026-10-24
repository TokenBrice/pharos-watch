import { defineConfig, globalIgnores } from "eslint/config";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
// functions/ may reach into worker/src/.
const frontendToWorkerRestrictedImportPatterns = [
  {
    group: ["worker/src", "worker/src/**", "**/worker/src", "**/worker/src/**"],
    message:
      "ADR-2: src/, shared/, scripts/ and functions/ must not import worker/src/**. Promote runtime-neutral logic into shared/ instead, or add a reviewed entry in eslint.config.mjs (docs/process/boundary-waivers.md).",
  },
];

// The sole reviewed waiver documented in docs/process/boundary-waivers.md.
const FRONTEND_TO_WORKER_WAIVED_FILES = ["scripts/ci/check-frozen-invariants.ts"];

function isWithinPath(parentDir, candidatePath) {
  const relativePath = relative(parentDir, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

const repoRoot = dirname(fileURLToPath(import.meta.url));
const contractsRoot = realpathSync(resolve(repoRoot, "shared/contracts"));
const contractsManifest = JSON.parse(readFileSync(resolve(contractsRoot, "package.json"), "utf8"));
const contractsPublicImports = new Set(
  Object.keys(contractsManifest.exports).map((subpath) => `${contractsManifest.name}/${subpath.slice(2)}`),
);

function canonicalImportTarget(target) {
  try {
    return realpathSync(target);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    // Extensionless and not-yet-created modules still inherit their directory's symlinks.
    const parent = dirname(target);
    return parent === target ? target : resolve(canonicalImportTarget(parent), relative(parent, target));
  }
}

function physicalImportTarget(filename, specifier) {
  let target;
  if (specifier.startsWith(".")) target = resolve(dirname(filename), specifier);
  else if (isAbsolute(specifier)) target = resolve(specifier);
  else if (specifier.startsWith("@shared/")) target = resolve(repoRoot, "shared", specifier.slice("@shared/".length));
  else if (specifier.startsWith("@/")) target = resolve(repoRoot, "src", specifier.slice(2));
  else if (specifier.startsWith("shared/")) target = resolve(repoRoot, specifier);
  else if (specifier.startsWith("file:")) target = fileURLToPath(specifier);
  else return null;
  return canonicalImportTarget(target);
}

function staticImportSpecifier(node) {
  if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
    return typeof node.source?.value === "string" ? node.source.value : null;
  }
  if (node.type === "TSImportType") {
    return typeof node.source?.value === "string" ? node.source.value : null;
  }
  if (node.type === "TSExternalModuleReference") {
    return typeof node.expression?.value === "string" ? node.expression.value : null;
  }
  if (node.type === "ImportExpression") {
    if (node.source.type === "TemplateLiteral" && node.source.expressions.length === 0) {
      return node.source.quasis[0].value.cooked;
    }
    return node.source.type === "Literal" && typeof node.source.value === "string" ? node.source.value : null;
  }
  if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require") {
    const argument = node.arguments[0];
    if (argument?.type === "TemplateLiteral" && argument.expressions.length === 0) {
      return argument.quasis[0].value.cooked;
    }
    return argument?.type === "Literal" && typeof argument.value === "string" ? argument.value : null;
  }
  return null;
}

const deletedSupplyHelperNames = {
  "getCirculatingRaw": true,
  "getPrevDayRaw": true,
  "getPrevWeekRaw": true,
  "sumPegBuckets": true,
};

const pharosBoundaryPlugin = {
  rules: {
    "shared-types-imports": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          broad: "Import runtime values from @shared/types/<submodule>; reserve @shared/types for import type.",
          dependency: "shared/types and shared/contracts modules must not import shared/lib modules.",
        },
      },
      create(context) {
        const filename = context.filename;
        const inSharedTypes = (isWithinPath(resolve(process.cwd(), "shared/types"), filename)
          || isWithinPath(contractsRoot, filename))
          && !filename.replaceAll("\\", "/").includes("/__tests__/")
          && !/\.test\.tsx?$/.test(filename);
        function check(node) {
          const specifier = staticImportSpecifier(node);
          if (!specifier) return;
          if (node.type === "ImportDeclaration" && specifier === "@shared/types"
            && node.importKind !== "type"
            && node.specifiers.some((item) => item.type === "ImportSpecifier" && item.importKind !== "type")) {
            context.report({ node, messageId: "broad" });
          }
          if (inSharedTypes && (
            specifier === "@shared/lib" || specifier.startsWith("@shared/lib/")
            || (specifier.startsWith(".") && isWithinPath(resolve(process.cwd(), "shared/lib"), resolve(dirname(filename), specifier)))
          )) {
            context.report({ node, messageId: "dependency" });
          }
        }
        return { ImportDeclaration: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
      },
    },
    "contracts-imports": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          public: "Import contracts only through exact @pharos/contracts exported subpaths; package-root, private, alias and physical imports bypass the public API.",
          dependency: "Contract sources may import only zod and relative modules within shared/contracts.",
          dynamic: "Contract sources require literal module specifiers so their dependency boundary can be checked.",
        },
      },
      create(context) {
        const filename = context.filename;
        // Package tests are consumers of the public exports, not package implementation.
        const inContracts = isWithinPath(contractsRoot, canonicalImportTarget(filename))
          && !filename.replaceAll("\\", "/").includes("/__tests__/")
          && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filename);
        function check(node) {
          if (node.type === "CallExpression" && (node.callee.type !== "Identifier" || node.callee.name !== "require")) return;
          const specifier = staticImportSpecifier(node);
          if (!specifier) {
            if (inContracts && (node.type === "ImportExpression" || node.type === "CallExpression")) {
              context.report({ node, messageId: "dynamic" });
            }
            return;
          }
          const target = physicalImportTarget(filename, specifier);
          const throughWorkspaceLink = /(?:^|[/\\])node_modules[/\\]@pharos[/\\]contracts(?:[/\\]|$)/.test(specifier);
          if (inContracts) {
            if (specifier !== "zod" && !(specifier.startsWith(".") && !throughWorkspaceLink
              && target && isWithinPath(contractsRoot, target))) {
              context.report({ node, messageId: "dependency" });
            }
          } else if (
            ((specifier === contractsManifest.name || specifier.startsWith(`${contractsManifest.name}/`))
              && !contractsPublicImports.has(specifier))
            || specifier === "@shared/contracts" || specifier.startsWith("@shared/contracts/")
            || throughWorkspaceLink
            || (target && isWithinPath(contractsRoot, target))
          ) {
            context.report({ node, messageId: "public" });
          }
        }
        return {
          ImportDeclaration: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
          ImportExpression: check,
          CallExpression: check,
          TSImportType: check,
          TSExternalModuleReference: check,
        };
      },
    },
    "no-zero-coercing-supply-helpers": {
      meta: {
        type: "problem",
        schema: [],
        messages: { unavailable: "Deleted zero-coercing supply helper: use the OrNull variant and explicitly preserve unavailable supply." },
      },
      create(context) {
        return {
          Identifier(node) {
            if (Object.hasOwn(deletedSupplyHelperNames, node.name)) context.report({ node, messageId: "unavailable" });
          },
          "MemberExpression[computed=true] > Literal.property"(node) {
            if (Object.hasOwn(deletedSupplyHelperNames, node.value)) context.report({ node, messageId: "unavailable" });
          },
        };
      },
    },
    "no-arbitrary-text-px": {
      meta: {
        type: "suggestion",
        schema: [],
        messages: {
          px: "Arbitrary font size {{value}}: use the type scale (text-3xs 10px, text-2xs 11px, text-xs … text-5xl) or a shared utility (docs/design-tokens.md#type-scale).",
        },
      },
      create(context) {
        // Class tokens such as `text-[11px]`, `sm:text-[10.5px]` or the
        // important forms `md:!text-[11px]` / `text-[11px]!` inside any string
        // or template chunk; text-[clamp(...)]/rem display sizes stay legal.
        const pattern = /(?:^|[\s:"'`])(!?text-\[[\d.]+px\]!?)/g;
        function check(node, text) {
          if (typeof text !== "string") return;
          for (const match of text.matchAll(pattern)) context.report({ node, messageId: "px", data: { value: match[1] } });
        }
        return {
          Literal: (node) => check(node, node.value),
          TemplateElement: (node) => check(node, node.value.cooked),
        };
      },
    },
    "no-arbitrary-radius": {
      meta: {
        type: "suggestion",
        schema: [],
        messages: {
          radius: "Arbitrary or bare radius {{value}}: use the radius scale (rounded-xs 2px, rounded-sm 4px, rounded-md, rounded-lg, rounded-xl, rounded-2xl, rounded-full) per the radius rule in docs/design-tokens.md.",
        },
      },
      create(context) {
        // `rounded-[3px]`, `rounded-t-[3px]` and the bare `rounded` / `rounded-t`
        // (an unnamed 4px) inside any string or template chunk, with variants
        // and important forms. Prose ("rounded display scores") has capitals or
        // sentence punctuation that class lists never carry, so bare words there
        // are not classes. String checks, not a regex, keep it linear.
        const sides = new Set(["t", "r", "b", "l", "s", "e", "x", "y", "tl", "tr", "bl", "br", "ss", "se", "es", "ee"]);
        const isSide = (part) => part === "" || (part.startsWith("-") && sides.has(part.slice(1)));
        function classify(token) {
          const core = token.slice(token.lastIndexOf(":") + 1).replace(/^!/, "").replace(/!$/, "");
          if (!core.startsWith("rounded")) return null;
          const rest = core.slice("rounded".length);
          if (rest.endsWith("]")) {
            const bracket = rest.indexOf("-[");
            return bracket >= 0 && isSide(rest.slice(0, bracket)) ? "arbitrary" : null;
          }
          return isSide(rest) ? "bare" : null;
        }
        function check(node, text) {
          if (typeof text !== "string") return;
          const prose = /[A-Z]|[.!?](?:\s|$)/.test(text);
          for (const token of text.split(/\s|["'`]/)) {
            const kind = token && classify(token);
            if (kind === "arbitrary" || (kind === "bare" && !prose)) {
              context.report({ node, messageId: "radius", data: { value: token } });
            }
          }
        }
        return {
          Literal: (node) => check(node, node.value),
          TemplateElement: (node) => check(node, node.value.cooked),
        };
      },
    },
    "no-arbitrary-z-index": {
      meta: {
        type: "suggestion",
        schema: [],
        messages: {
          z: "Arbitrary or page-level z-index {{value}}: use a named layer (z-chrome, z-chrome-dock, z-chrome-header, z-progress, z-regime, z-modal, z-toast, z-skip) or a local z-0..z-10 (docs/design-tokens.md).",
        },
      },
      create(context) {
        // `z-[…]` and numeric `z-N` above 10, with variants and important forms.
        const pattern = /(?:^|[\s:"'`])(!?-?z-(?:\[[^\]\s]*\]|\d+)!?)(?![\w-])/g;
        function check(node, text) {
          if (typeof text !== "string") return;
          for (const match of text.matchAll(pattern)) {
            const digits = /^!?-?z-(\d+)!?$/.exec(match[1]);
            if (digits && Number(digits[1]) <= 10) continue;
            context.report({ node, messageId: "z", data: { value: match[1] } });
          }
        }
        return {
          Literal: (node) => check(node, node.value),
          TemplateElement: (node) => check(node, node.value.cooked),
        };
      },
    },
    "no-raw-palette-colour": {
      meta: {
        type: "suggestion",
        schema: [],
        messages: {
          raw: "Raw palette colour {{value}}: use a UI-state utility (text-state-warn, bg-state-danger-subtle, border-state-info, bg-state-positive-solid/15 …) or, for a classification scale, the palette in shared/lib/classification.ts (docs/design-tokens.md#ui-state-utilities).",
        },
      },
      create(context) {
        // Colour utilities on a Tailwind palette hue step (`text-amber-700`,
        // `dark:bg-red-500/10`, `border-l-sky-500/70`, `!fill-rose-400`) inside
        // any string or template chunk; arbitrary `[color:var(--x)]` stays legal.
        // Per-token test (variants stripped) keeps the pattern linear.
        const pattern =
          /^!?(?:text|bg|border(?:-[trblxy])?|ring|ring-offset|fill|stroke|from|to|via|outline|decoration|divide|shadow|accent|caret|placeholder)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-(?:50|[1-9]00|950)(?:\/|!|$)/;
        function check(node, text) {
          if (typeof text !== "string") return;
          for (const token of text.split(/\s|["'`]/)) {
            if (token && pattern.test(token.slice(token.lastIndexOf(":") + 1))) {
              context.report({ node, messageId: "raw", data: { value: token } });
            }
          }
        }
        return {
          Literal: (node) => check(node, node.value),
          TemplateElement: (node) => check(node, node.value.cooked),
        };
      },
    },
    "require-shared-alias": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          alias: "ADR-2: imports into root shared/ from src/, worker/ or functions/ must use @shared/*, not relative paths.",
        },
      },
      create(context) {
        const sharedRoot = resolve(process.cwd(), "shared");

        function check(node) {
          const specifier = staticImportSpecifier(node);
          if (!specifier || (!specifier.startsWith("./") && !specifier.startsWith("../"))) return;
          const target = resolve(dirname(context.filename), specifier);
          if (isWithinPath(sharedRoot, target)) context.report({ node, messageId: "alias" });
        }

        return {
          ImportDeclaration: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
          ImportExpression: check,
        };
      },
    },
    "frontend-dynamic-import-boundaries": {
      meta: { type: "problem", schema: [], messages: { worker: "ADR-2: non-Worker code must not import worker/src/**." } },
      create(context) {
        return {
          ImportExpression(node) {
            const specifier = staticImportSpecifier(node);
            if (!specifier) return;
            const target = specifier.startsWith(".")
              ? resolve(dirname(context.filename), specifier)
              : resolve(process.cwd(), specifier);
            if (isWithinPath(resolve(process.cwd(), "worker/src"), target)) {
              context.report({ node, messageId: "worker" });
            }
          },
        };
      },
    },
    "worker-import-boundaries": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          workerFrontend: "ADR-2: worker code must not import frontend src/** modules; promote runtime-neutral logic into shared/**.",
          apiCron: "Worker API and cron modules must not import each other; move shared logic into worker/src/lib or shared/**.",
        },
      },
      create(context) {
        const filename = context.filename;
        const normalizedFilename = filename.replaceAll("\\\\", "/");
        const workerRoot = resolve(process.cwd(), "worker/src");
        const apiRoot = resolve(workerRoot, "api");
        const cronRoot = resolve(workerRoot, "cron");
        const inTests = normalizedFilename.includes("/__tests__/");

        function check(node) {
          const specifier = staticImportSpecifier(node);
          if (!specifier) return;
          if (specifier.includes("@/") || specifier.includes("src/")) {
            context.report({ node, messageId: "workerFrontend" });
          }
          if (inTests || !specifier.startsWith(".")) return;
          const target = resolve(dirname(filename), specifier);
          const apiToCron = isWithinPath(apiRoot, filename) && isWithinPath(cronRoot, target);
          const cronToApi = isWithinPath(cronRoot, filename) && isWithinPath(apiRoot, target);
          if (apiToCron || cronToApi) context.report({ node, messageId: "apiCron" });
        }

        return {
          ImportDeclaration: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
          ImportExpression: check,
        };
      },
    },
  },
};

const workerRestrictedImportPaths = [
  // Bare "viem" re-exports clients/transports; force the codec-only entry point.
  {
    name: "viem",
    message: "Worker code may only import pure ABI codecs from viem/utils, not bare viem (clients/transports).",
  },
];

const workerRestrictedImportPatterns = [
  {
    // Worker only needs viem's pure ABI codecs from viem/utils. Any other viem
    // subpath (clients/transports/actions) would pull the websocket transport
    // surface (and its `ws` advisory) into the bundle. Keep viem/utils allowed,
    // plus viem/siwe: the donor key claim needs the EIP-4361 parser/validator,
    // which are pure string helpers (viem is `sideEffects: false`).
    group: ["viem/*", "!viem/utils", "!viem/siwe"],
    message: "Worker code may only import pure ABI codecs from viem/utils, not viem clients/transports.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals.map((config) => config.name === "next"
    ? { ...config, files: [...config.files, "**/*.cjs"] }
    : config),
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
    // Frozen compatibility readers are compiled historical bytes, not source.
    "worker/src/api/__tests__/fixtures/pr-b-mint-burn-readers.cjs",
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
      // detect-non-literal-fs-filename flags every dynamic fs path; repo
      // scripts and tests intentionally walk dynamic paths under the
      // workspace, so after owner review the rule is off globally
      // (docs/testing.md#eslint-configuration).
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
    plugins: { pharos: pharosBoundaryPlugin },
    rules: {
      "pharos/worker-import-boundaries": "error",
      "no-restricted-imports": [
        "error",
        { paths: workerRestrictedImportPaths, patterns: workerRestrictedImportPatterns },
      ],
    },
  },
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"],
    plugins: { pharos: pharosBoundaryPlugin },
    rules: {
      "pharos/no-zero-coercing-supply-helpers": "error",
    },
  },
  {
    // Worker tests additionally sign fixtures with throwaway private keys.
    // viem/accounts is pure signing and never reaches the deployed bundle.
    files: ["worker/src/**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: workerRestrictedImportPaths,
          patterns: workerRestrictedImportPatterns.map((pattern) =>
            pattern.group.includes("viem/*")
              ? { ...pattern, group: [...pattern.group, "!viem/accounts"] }
              : pattern,
          ),
        },
      ],
    },
  },
  {
    files: ["{functions,shared,src,scripts}/**/*.{ts,tsx}", "worker/src/**/*.{ts,tsx}"],
    plugins: { pharos: pharosBoundaryPlugin },
    rules: { "pharos/shared-types-imports": "error" },
  },
  {
    files: [...NON_WORKER_SOURCE_GLOBS, "worker/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"],
    plugins: { pharos: pharosBoundaryPlugin },
    rules: { "pharos/contracts-imports": "error" },
  },
  {
    files: NON_WORKER_SOURCE_GLOBS,
    ignores: FRONTEND_TO_WORKER_WAIVED_FILES,
    plugins: { pharos: pharosBoundaryPlugin },
    rules: {
      "pharos/frontend-dynamic-import-boundaries": "error",
      "no-restricted-imports": ["error", { patterns: frontendToWorkerRestrictedImportPatterns }],
    },
  },
  {
    // The homepage never renders data-health UI (docs/homepage.md#data-health):
    // data renders as-is, no data is a neutral placeholder, and ops state lives
    // in admin/alerts. Re-applies the ADR-2 patterns because flat config
    // replaces this rule's options for overlapping files.
    files: [
      "src/app/page.tsx",
      "src/components/home-*.{ts,tsx}",
      "src/components/homepage-*.{ts,tsx}",
      "src/components/home-alt-mini-cards/**/*.{ts,tsx}",
      "src/components/home-alt-callouts/**/*.{ts,tsx}",
    ],
    ignores: ["**/__tests__/**", "**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...frontendToWorkerRestrictedImportPatterns,
            {
              group: [
                "**/stale-data-banner",
                "**/query-freshness-notices",
                "**/query-error-notice",
                "**/data-health-banner",
                "**/query-state-notice",
                "**/yield/yield-data-health",
                "**/safety-score-v9-status-notice",
                "**/ops-status-chip",
                "**/section-error-boundary",
              ],
              message:
                "The homepage never renders data-health warnings (docs/homepage.md#data-health): render data as-is, or a neutral placeholder when there is none (use HomeSectionErrorBoundary for crash fallbacks). Ops state lives in admin/alerts.",
            },
          ],
        },
      ],
    },
  },
  {
    // Caller spelling is a separate boundary from the Worker/frontend bans.
    // shared/ internals retain relative imports, and local shared dirs are not
    // the root runtime-neutral boundary.
    files: [
      "src/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
      "worker/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
      "functions/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
    ],
    plugins: { pharos: pharosBoundaryPlugin },
    rules: {
      "pharos/require-shared-alias": "error",
    },
  },
  {
    // Type-scale guardrail (docs/design-tokens.md#type-scale): no grandfathered
    // call sites; src/lib class-string constants are covered too.
    files: ["src/components/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    // Editorial carve-outs keep their bespoke type registers (SWEEP.md §4).
    ignores: [
      "**/__tests__/**",
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
      "src/app/cemetery/**",
      "src/components/cemetery/**",
      "src/app/digest/**",
      "src/components/digest-*.tsx",
      "src/components/daily-digest.tsx",
      "src/components/home-alt-mini-cards/daily-digest-card.tsx",
      "src/components/editorial-masthead.tsx",
      "src/components/editorial-colophon.tsx",
      "src/app/timeline/**",
      "src/components/tape/**",
      "src/components/homepage-tape.tsx",
      "src/components/tape-for-coin-teaser.tsx",
      "src/app/depeg/[[]event[]]/**",
      "src/app/blog/**",
      "src/components/ai-summary*.tsx",
      "src/components/page-error-editorial.tsx",
      "src/app/not-found.tsx",
    ],
    plugins: { pharos: pharosBoundaryPlugin },
    rules: {
      "pharos/no-arbitrary-text-px": "error",
      // Radius guardrail (docs/design-tokens.md, radius rule): same scope.
      "pharos/no-arbitrary-radius": "error",
    },
  },
  {
    // shadcn primitives keep their upstream radii.
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: { "pharos/no-arbitrary-radius": "off" },
  },
  {
    // Stacking guardrail (docs/design-tokens.md): page-level layers
    // are named; only local z-0..z-10 stays numeric.
    files: ["src/components/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}"],
    ignores: ["**/__tests__/**", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    plugins: { pharos: pharosBoundaryPlugin },
    rules: {
      "pharos/no-arbitrary-z-index": "error",
    },
  },
  {
    // UI-state colour guardrail (docs/design-tokens.md#ui-state-utilities).
    // Editorial carve-outs keep their bespoke palettes; nothing else is
    // grandfathered.
    // Classification scales live in shared/lib/classification (not linted
    // here); src/lib class-string constants are covered too.
    files: ["src/components/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    ignores: [
      "**/__tests__/**",
      // Own palettes: the Telegram mini-app sets its own color-scheme and the
      // tape wire stream is editorial art.
      "src/app/pharoswatchbot/**",
      "src/lib/tape-class-style.ts",
      "src/components/home-alt-mini-cards/daily-digest-card.tsx",
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
      "src/app/cemetery/**",
      "src/components/cemetery/**",
      "src/app/digest/**",
      "src/components/digest-*",
      "src/components/daily-digest*",
      "src/components/editorial-*",
      "src/app/timeline/**",
      "src/components/tape/**",
      "src/components/homepage-tape*",
      "src/app/blog/**",
      "src/app/depeg/[[]event]/**",
      "src/components/ai-summary*",
      "src/app/**/error.tsx",
      "src/app/global-error.tsx",
      "src/app/not-found.tsx",
      "src/components/page-error-editorial.tsx",
    ],
    plugins: { pharos: pharosBoundaryPlugin },
    rules: {
      "pharos/no-raw-palette-colour": "error",
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
