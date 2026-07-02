import { describe, expect, it } from "vitest";
import { createMethodologyChangelogRoute } from "./changelog-route-factory";

describe("createMethodologyChangelogRoute", () => {
  it("uses shared page metadata with markdown alternates and Twitter cards", () => {
    const route = createMethodologyChangelogRoute({
      path: "/methodology/scoring-changelog/",
      metadataTitle: "Safety Scores Changelog - Version History",
      metadataDescription: "Full history of Safety Score methodology releases.",
      breadcrumbName: "Safety Scores",
      title: "Safety Scores Changelog",
      lead: "Full version history.",
      citation: {
        id: "safety-score",
        versionLabel: "v8.12",
      },
    });

    expect(route.metadata.alternates).toMatchObject({
      canonical: "/methodology/scoring-changelog/",
      types: {
        "text/markdown": [
          {
            title: "Safety Scores Changelog - Version History (Markdown)",
            url: "/methodology/scoring-changelog/index.md",
          },
        ],
      },
    });
    expect(route.metadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: "Safety Scores Changelog - Version History",
      description: "Full history of Safety Score methodology releases.",
      images: [{ url: "/og-editorial-methodology.png", width: 1200, height: 628 }],
    });
  });
});
