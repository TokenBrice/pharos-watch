import { createHash, type Hash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

import { PAGES_RELEASE_DATA_PATHS } from "./scripts/lib/pages-release-data.mts";

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
 * The Pages release rewrites these paths on every publish. They change rendered
 * HTML/RSC and served datasets, never the client bundle, so they must not rotate
 * the ID — a data-only publish then re-uploads only the pages whose bytes
 * changed. The list is not copied: `scripts/lib/pages-release-data.mts` owns it
 * for the replay archive too, and the client-closure guard in
 * `scripts/__tests__/next-config-release-typecheck.test.ts` fails if any client
 * module imports one of them.
 */
export const BUILD_ID_EXCLUDED_PATHS: readonly string[] = PAGES_RELEASE_DATA_PATHS;
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
  experimental: {
    optimizePackageImports: [
      "recharts",
      "lucide-react",
      "@tanstack/react-query",
      "@tanstack/react-virtual",
    ],
  },
  webpack(config, { isServer }) {
    if (!isServer) {
      const splitChunks = config.optimization?.splitChunks;
      if (splitChunks && typeof splitChunks === "object") {
        splitChunks.cacheGroups = {
          ...(splitChunks.cacheGroups ?? {}),
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
  // The /api proxy is only useful in `next dev`.
  // Static exports rely on Cloudflare Pages `_redirects`, and leaving rewrites
  // enabled at build time triggers a noisy export warning from Next.js.
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    return {
      ...baseConfig,
      ...releaseTypeScriptConfig(),
      allowedDevOrigins: devAllowedOrigins(),
      rewrites: devRewrites,
    };
  }

  return { ...baseConfig, ...releaseTypeScriptConfig() };
}
