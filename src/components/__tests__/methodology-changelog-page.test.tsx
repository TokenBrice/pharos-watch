import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import { buildPharosUrnJsonLdIdentifier } from "@/lib/pharos-urn-json-ld";

describe("MethodologyChangelogPage", () => {
  it("emits the Pharos URN identifier in Article JSON-LD", () => {
    const html = renderToStaticMarkup(
      <MethodologyChangelogPage
        breadcrumbName="DEWS"
        path="/methodology/depeg-changelog/"
        title="DEWS Methodology"
        lead="Version history"
        entries={[
          {
            version: "6.0",
            title: "Current",
            date: "2026-05-16",
            effectiveAt: 1_747_353_600,
            summary: "Current release",
            impact: [],
            commits: [],
            reconstructed: false,
          },
        ]}
        jsonLdIdentifier={buildPharosUrnJsonLdIdentifier("methodology", "dews", "v6.0")}
      />,
    );

    expect(html).toContain("urn:pharos:methodology:dews@v6.0");
    expect(html).toContain("Pharos URN");
  });
});
