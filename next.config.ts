import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const rechartsVendorPattern =
  /[\\/]node_modules[\\/](?:recharts|victory-vendor|d3-(?:array|color|ease|format|interpolate|path|scale|shape|time|time-format)|@reduxjs[\\/]toolkit|decimal\.js-light|eventemitter3|es-toolkit|immer|react-is|react-redux|redux|redux-thunk|reselect|tiny-invariant|use-sync-external-store)[\\/]/;

const baseConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
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
          // x-perf-front:1: cache Recharts and its chart-stack deps across route-family chunks.
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
        ? `http://localhost:${proxyPort}/api/:path*`
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
      allowedDevOrigins: devAllowedOrigins(),
      rewrites: devRewrites,
    };
  }

  return baseConfig;
}
