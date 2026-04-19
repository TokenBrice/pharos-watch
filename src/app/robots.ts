import type { MetadataRoute } from "next";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

export const dynamic = "force-static";

const AI_SEARCH_BOTS = [
  "OAI-SearchBot",
  "Claude-SearchBot",
  "PerplexityBot",
  "ChatGPT-User",
  "Claude-User",
  "Perplexity-User",
  "GPTBot",
  "ClaudeBot",
  "CCBot",
  "Google-Extended",
  "Applebot-Extended",
] as const;

const OPERATOR_DISALLOW = ["/admin", "/admin/", "/api/admin", "/api/admin/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      ...AI_SEARCH_BOTS.map((bot) => ({
        userAgent: bot,
        allow: "/",
        disallow: OPERATOR_DISALLOW,
      })),
      {
        userAgent: "*",
        allow: "/",
        disallow: OPERATOR_DISALLOW,
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
