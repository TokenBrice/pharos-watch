import type { MetadataRoute } from "next";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Operational surfaces that are noindex,nofollow anyway — disallowing
        // them saves crawl budget. Routes that rely on crawlers observing a
        // noindex response (portfolio, yield subpages, datasets) stay crawlable.
        disallow: ["/admin/", "/admin-api/", "/pharoswatchbot/app/"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
