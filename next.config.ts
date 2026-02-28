import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: ["recharts", "lucide-react"],
  },
  // Rewrites are ignored in static exports — only active during `next dev`.
  // Proxies /api/* to the prod worker so local dev has real data without CORS issues.
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "https://api.pharos.watch/api/:path*",
      },
    ];
  },
};

export default nextConfig;
