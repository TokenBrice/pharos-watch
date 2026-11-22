import { createHash, type Hash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

import { PAGES_RELEASE_BUILD_ID_EXCLUSIONS } from "./scripts/lib/pages-release-data.mts";

const rechartsVendorPattern =
  /[\\/]node_modules[\\/](?:recharts|victory-vendor|d3-(?:array|color|ease|format|interpolate|path|scale|shape|time|time-format))[\\/]/;

/**
 * Next stamps its build ID into every exported page (the RSC `"b"` field) and
 * into the `/_next/static/<id>/` directory, so its default random ID makes an
 * identical rebuild replace the whole Pages artifact. Derive the ID from the
 * inputs that can change client JavaScript/CSS instead: application and shared
 * modules (including the generated data they bundle), build-time `fs` data, the
 * root build config, the lockfile and the environment Next inlines.
 */
export const BUILD_ID_INPUT_DIRECTORIES = ["data", "shared", "src"] as const;
export const BUILD_ID_INPUT_FILES = [
  "next.config.ts",
  "package.json",
  "package-lock.json",
  "postcss.config.mjs",
  "tsconfig.json",
  "tsconfig.base.json",
] as const;
/**
 * Server-only and Worker-only `shared/data/` inputs that never enter client
 * JavaScript/CSS (`src/app/globals.css` already excludes `shared/data/` from
 * Tailwind scanning). Client-imported siblings stay hashed so client bundle
 * changes still rotate the ID: `methodology-changelogs/depeg-resolver`,
 * `safety-score-v9/chain-maturity-reviews-v1.ts`,
 * `safety-score-v9/methodology-policy-candidate-v1.json`, and the client
 * `stablecoins/` catalogs (`canonical-order`, `coins.client.*`,
 * `coins.compliance.*`, `coins.telegram-mini-app.*`, `listing-decisions`).
 */
const SERVER_ONLY_SHARED_BUILD_ID_EXCLUSIONS = [
  "shared/data/annotations",
  "shared/data/methodology-changelogs/blacklist-tracker",
  "shared/data/methodology-changelogs/chain-health",
  "shared/data/methodology-changelogs/depeg-dews",
  "shared/data/methodology-changelogs/liquidity-score",
  "shared/data/methodology-changelogs/mint-authority",
  "shared/data/methodology-changelogs/mint-burn-flow",
  "shared/data/methodology-changelogs/pricing-pipeline",
  "shared/data/methodology-changelogs/redemption-backstop",
  "shared/data/methodology-changelogs/safety-score",
  "shared/data/methodology-changelogs/stability-index",
  "shared/data/methodology-changelogs/yield-methodology",
  "shared/data/safety-score-v9/AGENTS.md",
  "shared/data/safety-score-v9/access-lookthrough-reviews-v1.json",
  "shared/data/safety-score-v9/evaluation-build-manifest-v1.ts",
  "shared/data/safety-score-v9/evidence-gap-classifications-v1.json",
  "shared/data/safety-score-v9/exit-execution-model-reviews-v1.json",
  "shared/data/safety-score-v9/golden-scenarios-v1.ts",
  "shared/data/safety-score-v9/incident-review-key-migration-v1.generated.json",
  "shared/data/safety-score-v9/incident-reviews-v1.json",
  "shared/data/safety-score-v9/incident-runtime-v1.generated.json",
  "shared/data/safety-score-v9/lane-emitter-descriptors-v1.generated.json",
  "shared/data/safety-score-v9/lane-screening-emitter-inventory-v1.json",
  "shared/data/safety-score-v9/lender-collateral-classes-v1.json",
  "shared/data/safety-score-v9/mechanism-measurements",
  "shared/data/safety-score-v9/mechanism-review-overlays-v1.json",
  "shared/data/safety-score-v9/reserve-bound-facts-v1.json",
  "shared/data/safety-score-v9/shock-coverage-measurements-v1.json",
  "shared/data/safety-score-v9/shock-coverage-replay-attestations-v1.json",
  "shared/data/safety-score-v9/shock-coverage-targets.json",
  "shared/data/safety-score-v9/supply-attribution-reviews-v1.json",
  "shared/data/safety-score-v9/transfer-review-overlays-v1.json",
  "shared/data/safety-score-v9/wrapper-allocation-reviews-v1.json",
  "shared/data/stablecoins/coins",
  "shared/data/stablecoins/domains",
  "shared/data/stablecoins/coins.generated.json",
  "shared/data/stablecoins/coins.worker-full.generated.json",
  "shared/data/stablecoins/coins.worker-runtime.generated.json",
] as const;

/**
 * Paths excluded from the content-derived build ID because they never alter
 * client JavaScript/CSS: release-refreshed public inputs and derived server
 * outputs owned by `scripts/lib/pages-release-data.mts`, plus explicit
 * server-only/Worker-only `shared/data/` inputs above. The client-closure guard
 * in `scripts/__tests__/next-config-release-typecheck.test.ts` fails if any
 * `"use client"` module reaches an excluded path.
 */
export const BUILD_ID_EXCLUDED_PATHS: readonly string[] = [
  ...PAGES_RELEASE_BUILD_ID_EXCLUSIONS,
  ...SERVER_ONLY_SHARED_BUILD_ID_EXCLUSIONS,
];
/**
 * Read at build time by `src/lib/feature-flags.ts`, `src/lib/api-url.ts`,
 * `src/app/layout.tsx` and `src/lib/safety-grade-snapshot.ts`. Every
 * `NEXT_PUBLIC_*` variable is hashed by prefix, so a new flag needs no edit here.
 */
const BUILD_ID_ENV_KEYS = ["NODE_ENV", "PHAROS_PAGES_REPLAY"] as const;
/** Never bundled, so excluded instead of rotating the ID: tests and nested installs. */
const BUILD_ID_IGNORED_DIRECTORIES = new Set(["__tests__", "node_modules"]);
const BUILD_ID_IGNORED_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const BUILD_ID_LENGTH = 21; // Next's default nanoid length.

function isBuildIdExcluded(path: string): boolean {
  return BUILD_ID_EXCLUDED_PATHS.some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
}

function hashBuildInputDirectory(hash: Hash, root: string, relative: string): void {
  const entries = readdirSync(join(root, relative), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()
      ? !BUILD_ID_IGNORED_DIRECTORIES.has(entry.name)
      : !BUILD_ID_IGNORED_FILE.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = `${relative}/${entry.name}`;
    if (isBuildIdExcluded(path)) continue;
    if (entry.isDirectory()) {
      hash.update(`directory:${path}\n`);
      hashBuildInputDirectory(hash, root, path);
    } else if (entry.isFile()) {
      hash.update(`file:${path}\n`);
      hash.update(readFileSync(join(root, path)));
      hash.update("\n");
    }
  }
}

/**
 * Fail closed: a missing input throws and fails the build; there is no random
 * fallback. Release identity stays the commit marker written by the Pages
 * release, and no marker, gate, skew or rollback path reads the build ID.
 */
export function nextBuildId(cwd: string = process.cwd(), env: Record<string, string | undefined> = process.env): string {
  const hash = createHash("sha256");
  hash.update("pharos-next-build-id:v1\n");
  const envKeys = [...BUILD_ID_ENV_KEYS, ...Object.keys(env).filter((key) => key.startsWith("NEXT_PUBLIC_"))].sort();
  for (const key of envKeys) hash.update(`env:${key}=${env[key] ?? ""}\n`);
  for (const name of BUILD_ID_INPUT_FILES) {
    hash.update(`config:${name}\n`);
    hash.update(readFileSync(resolve(cwd, name)));
  }
  for (const name of BUILD_ID_INPUT_DIRECTORIES) hashBuildInputDirectory(hash, cwd, name);
  return hash.digest("hex").slice(0, BUILD_ID_LENGTH);
}

const baseConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  generateBuildId: () => nextBuildId(),
  transpilePackages: ["@pharos/contracts"],
  images: { unoptimized: true },
  reactStrictMode: true,
  outputFileTracingExcludes: {
    "*": [
      "public/**",
      "data/**",
      "shared/data/**",
      "docs/**",
      "scripts/**",
      "worker/**",
    ],
  },
  experimental: {
    serverMinification: false,
    optimizePackageImports: [
      "recharts",
      "lucide-react",
      "@tanstack/react-query",
      "@tanstack/react-virtual",
    ],
  },
  webpack(config, { dev, isServer }) {
    if (!dev && process.env.PHAROS_DISABLE_WEBPACK_FS_CACHE === "1") {
      config.cache = false;
    }

    if (!isServer) {
      const splitChunks = config.optimization?.splitChunks;
      if (splitChunks && typeof splitChunks === "object") {
        splitChunks.cacheGroups = {
          ...(splitChunks.cacheGroups ?? {}),
          // Reuse the data and Lucide runtime that webpack otherwise emits in many route chunks.
          pharosLogoData: {
            test: /[\\/](?:logos|logo-variants\.generated)\.json$/,
            name: "logo-data",
            chunks: "all",
            priority: 40,
            enforce: true,
            reuseExistingChunk: true,
          },
          iconRuntime: {
            test: /[\\/]lucide-react[\\/]dist[\\/]esm[\\/](?!icons[\\/])/,
            name: "icon-runtime",
            chunks: "all",
            priority: 40,
            enforce: true,
            reuseExistingChunk: true,
          },
          // Keep generic store/React helpers out so non-chart consumers do not load Recharts.
          rechartsVendor: {
            test: rechartsVendorPattern,
            name: "recharts-vendor",
            chunks: "all",
            priority: 50,
            enforce: true,
            reuseExistingChunk: true,
          },
        };
      }
    }

    return config;
  },
};

function releaseTypeScriptConfig(): Partial<Pick<NextConfig, "typescript">> {
  return process.env.PHAROS_RELEASE_PR_TYPECHECKED === "1"
    ? { typescript: { ignoreBuildErrors: true } }
    : {};
}

function parseBuildCpus(): number | undefined {
  const raw = process.env.PHAROS_NEXT_BUILD_CPUS?.trim();
  if (!raw || !/^\d+$/u.test(raw)) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function shouldDisablePrerenderSourceMaps(): boolean {
  return process.env.CI === "true" || process.env.PHAROS_DISABLE_PRERENDER_SOURCE_MAPS === "1";
}

async function devRewrites() {
  // When SITE_API_SHARED_SECRET is configured in .env.local, route through
  // the local dev proxy (scripts/maintenance/dev-api-proxy.ts) which injects the secret
  // header — mimicking the production Pages Functions site-data proxy.
  // Without the secret, fall back to the direct (unauthenticated) rewrite.
  const configuredProxyPort = Number.parseInt(process.env.DEV_PROXY_PORT ?? "3001", 10);
  const proxyPort = process.env.SITE_API_SHARED_SECRET?.trim() && Number.isFinite(configuredProxyPort)
    ? configuredProxyPort
    : 0;
  return [
    {
      source: "/api/:path+",
      destination: proxyPort
        ? `http://127.0.0.1:${proxyPort}/api/:path*`
        : "https://api.pharos.watch/api/:path*",
    },
  ];
}

function devAllowedOrigins() {
  return [
    "ops.pharos.watch",
    "*.ngrok-free.app",
    "*.ngrok.app",
    ...(
      process.env.NEXT_ALLOWED_DEV_ORIGINS ?? ""
    )
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ];
}

export default function createNextConfig(phase: string): NextConfig {
  const buildCpus = parseBuildCpus();
  const config: NextConfig = {
    ...baseConfig,
    ...releaseTypeScriptConfig(),
    ...(shouldDisablePrerenderSourceMaps() ? { enablePrerenderSourceMaps: false } : {}),
    experimental: {
      ...baseConfig.experimental,
      ...(buildCpus !== undefined ? { cpus: buildCpus } : {}),
    },
    // Next leaves unset public vars uninlined; give dead-code elimination a literal off value.
    env: { NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK: process.env.NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK ?? "false" },
  };
  // The /api proxy is only useful in `next dev`.
  // Static exports rely on Cloudflare Pages `_redirects`, and leaving rewrites
  // enabled at build time triggers a noisy export warning from Next.js.
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    return {
      ...config,
      allowedDevOrigins: devAllowedOrigins(),
      rewrites: devRewrites,
    };
  }

  return config;
}
