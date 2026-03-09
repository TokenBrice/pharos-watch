import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const baseConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: ["recharts", "lucide-react"],
  },
};

async function devRewrites() {
  return [
    {
      source: "/api/:path*",
      destination: "https://api.pharos.watch/api/:path*",
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
