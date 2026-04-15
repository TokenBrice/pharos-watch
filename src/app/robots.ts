import type { MetadataRoute } from "next";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
