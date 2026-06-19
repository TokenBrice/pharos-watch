import { describe, expect, it } from "vitest";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import robots from "../robots";

describe("robots", () => {
  it("allows crawlers to observe route-level noindex responses", () => {
    const metadata = robots();

    expect(metadata).toEqual({
      rules: [
        {
          userAgent: "*",
          allow: "/",
        },
      ],
      sitemap: `${SITE_ORIGIN}/sitemap.xml`,
    });
  });
});
