import type { MetadataRoute } from "next";
import { getActiveChainIds } from "@shared/lib/chains";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { STATIC_COMPARISON_PAGES } from "@/lib/compare-pages";
import { ACTIVE_PEGS, PEG_SLUGS } from "@/lib/peg-landing";
import { ALL_STABLECOIN_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";
import { buildStablecoinUrl } from "@/lib/urls";
import { SITE_URL } from "@/lib/site-config";
import digests from "../../data/digests.json";

export const dynamic = "force-static";

/** Actual last-edited dates for static pages (avoid misleading Google with build-time dates). */
const LAST_EDITED: Record<string, string> = {
  "/about/": "2026-03-10",
  "/about/api/": "2026-04-04",
  "/coverage/": "2026-03-12",
  "/start/": "2026-03-11",
  "/cemetery/": "2026-02-26",
  "/privacy/": "2026-02-26",
  "/compare/": "2026-02-26",
  "/methodology/": "2026-03-28",
  "/methodology/pricing-pipeline-changelog/": "2026-03-14",
  "/methodology/scoring-changelog/": "2026-02-28",
  "/methodology/depeg-changelog/": "2026-03-03",
  "/methodology/blacklist-tracker-changelog/": "2026-03-03",
  "/methodology/liquidity-score-changelog/": "2026-03-03",
  "/methodology/stability-index-changelog/": "2026-03-03",
  "/methodology/mint-burn-flow-changelog/": "2026-03-10",
  "/methodology/yield-changelog/": "2026-03-28",
  "/methodology/chain-health-changelog/": "2026-03-16",
  "/portfolio/": "2026-03-09",
  "/upcoming/": "2026-03-22",
  "/depeg/": "2026-03-02",
  "/yield/": "2026-03-26",
  "/flows/": "2026-03-10",
  "/telegram/": "2026-03-09",
  "/stablecoins/backing/algorithmic/": "2026-03-07",
  "/stablecoins/backing/crypto/": "2026-03-07",
  "/stablecoins/backing/rwa/": "2026-03-07",
  "/stablecoins/governance/cefi/": "2026-03-07",
  "/stablecoins/governance/cefi-dependent/": "2026-03-07",
  "/stablecoins/governance/defi/": "2026-03-07",
  "/chains/": "2026-03-16",
};

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const staticPages: MetadataRoute.Sitemap = [
    {
      url: `${SITE_URL}/`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 1.0,
    },
    {
      url: `${SITE_URL}/coverage/`,
      lastModified: new Date(LAST_EDITED["/coverage/"]!),
      changeFrequency: "weekly",
      priority: 0.6,
    },
    {
      url: `${SITE_URL}/start/`,
      lastModified: new Date(LAST_EDITED["/start/"]!),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${SITE_URL}/blacklist/`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/depeg/`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/cemetery/`,
      lastModified: new Date(LAST_EDITED["/cemetery/"]!),
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/liquidity/`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/portfolio/`,
      lastModified: new Date(LAST_EDITED["/portfolio/"]!),
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/upcoming/`,
      lastModified: new Date(LAST_EDITED["/upcoming/"]!),
      changeFrequency: "daily",
      priority: 0.6,
    },
    {
      url: `${SITE_URL}/digest/`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.6,
    },
    {
      url: `${SITE_URL}/safety-scores/`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/stability-index/`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/dependency-map/`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/yield/`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/treasuries/`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.6,
    },
    {
      url: `${SITE_URL}/flows/`,
      lastModified: new Date(LAST_EDITED["/flows/"]!),
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/telegram/`,
      lastModified: new Date(LAST_EDITED["/telegram/"]!),
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/methodology/`,
      lastModified: new Date(LAST_EDITED["/methodology/"]!),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${SITE_URL}/methodology/scoring-changelog/`,
      lastModified: new Date(LAST_EDITED["/methodology/scoring-changelog/"]!),
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: `${SITE_URL}/methodology/depeg-changelog/`,
      lastModified: new Date(LAST_EDITED["/methodology/depeg-changelog/"]!),
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: `${SITE_URL}/methodology/blacklist-tracker-changelog/`,
      lastModified: new Date(LAST_EDITED["/methodology/blacklist-tracker-changelog/"]!),
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: `${SITE_URL}/methodology/liquidity-score-changelog/`,
      lastModified: new Date(LAST_EDITED["/methodology/liquidity-score-changelog/"]!),
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: `${SITE_URL}/methodology/stability-index-changelog/`,
      lastModified: new Date(LAST_EDITED["/methodology/stability-index-changelog/"]!),
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: `${SITE_URL}/methodology/mint-burn-flow-changelog/`,
      lastModified: new Date(LAST_EDITED["/methodology/mint-burn-flow-changelog/"]!),
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: `${SITE_URL}/methodology/yield-changelog/`,
      lastModified: new Date(LAST_EDITED["/methodology/yield-changelog/"]!),
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: `${SITE_URL}/methodology/pricing-pipeline-changelog/`,
      lastModified: new Date(LAST_EDITED["/methodology/pricing-pipeline-changelog/"]!),
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: `${SITE_URL}/methodology/chain-health-changelog/`,
      lastModified: new Date(LAST_EDITED["/methodology/chain-health-changelog/"]!),
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: `${SITE_URL}/changelog/`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.5,
    },
    {
      url: `${SITE_URL}/about/`,
      lastModified: new Date(LAST_EDITED["/about/"]!),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${SITE_URL}/about/api/`,
      lastModified: new Date(LAST_EDITED["/about/api/"]!),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${SITE_URL}/privacy/`,
      lastModified: new Date(LAST_EDITED["/privacy/"]!),
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];

  const stablecoinPages: MetadataRoute.Sitemap = TRACKED_STABLECOINS.map(
    (coin) => ({
      url: `${SITE_URL}${buildStablecoinUrl(coin.id)}`,
      lastModified: now,
      changeFrequency: "daily" as const,
      priority: 0.6,
    })
  );

  const chainPages: MetadataRoute.Sitemap = [
    {
      url: `${SITE_URL}/chains/`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    ...getActiveChainIds().map((chainId) => ({
      url: `${SITE_URL}/chains/${chainId}/`,
      lastModified: now,
      changeFrequency: "daily" as const,
      priority: 0.5,
    })),
  ];

  const pegPages: MetadataRoute.Sitemap = ACTIVE_PEGS.map((peg) => ({
    url: `${SITE_URL}/stablecoins/${PEG_SLUGS[peg]}/`,
    lastModified: now,
    changeFrequency: "daily" as const,
    priority: 0.7,
  }));

  const digestPages: MetadataRoute.Sitemap = digests.map((d) => ({
    url: `${SITE_URL}/digest/${d.date}/`,
    lastModified: new Date(d.generatedAt * 1000),
    changeFrequency: "never" as const,
    priority: 0.5,
  }));

  const taxonomyPages: MetadataRoute.Sitemap = ALL_STABLECOIN_TAXONOMY_PAGES.map((page) => ({
    url: `${SITE_URL}${page.href}`,
    lastModified: new Date(LAST_EDITED[page.href] ?? "2026-03-07"),
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }));

  const comparisonPages: MetadataRoute.Sitemap = STATIC_COMPARISON_PAGES.map((page) => ({
    url: `${SITE_URL}${page.href}`,
    lastModified: new Date("2026-03-07"),
    changeFrequency: "monthly" as const,
    priority: 0.6,
  }));

  return [...staticPages, ...stablecoinPages, ...chainPages, ...pegPages, ...taxonomyPages, ...comparisonPages, ...digestPages];
}
