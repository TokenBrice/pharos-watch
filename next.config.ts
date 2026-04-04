import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

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
      "zod",
    ],
  },
};

async function devRewrites() {
  // When SITE_API_SHARED_SECRET is configured in .env.local, route through
  // the local dev proxy (scripts/dev-api-proxy.mjs) which injects the secret
  // header — mimicking the production Pages Functions site-data proxy.
  // Without the secret, fall back to the direct (unauthenticated) rewrite.
  const proxyPort = process.env.SITE_API_SHARED_SECRET?.trim() ? 3001 : 0;
  return [
    {
      source: "/api/:path*",
      destination: proxyPort
        ? `http://localhost:${proxyPort}/api/:path*`
        : "https://api.pharos.watch/api/:path*",
    },
  ];
}

export default function createNextConfig(phase: string): NextConfig {
  // The /api proxy is only useful in `next dev`.
  // Static exports rely on Cloudflare Pages `_redirects`, and leaving rewrites
  // enabled at build time triggers a noisy export warning from Next.js.
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    return {
      ...baseConfig,
      rewrites: devRewrites,
    };
  }

  return baseConfig;
}
