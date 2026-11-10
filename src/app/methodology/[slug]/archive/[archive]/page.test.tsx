import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MethodologyArchivePage from "@/app/methodology/[slug]/archive/[archive]/page";
import MethodologyChangelogRoute from "@/app/methodology/[slug]/page";

async function renderArchive(slug: string, archive: string): Promise<string> {
  return renderToStaticMarkup(
    await MethodologyArchivePage({ params: Promise.resolve({ slug, archive }) }),
  );
}

describe("methodology archive shards", () => {
  it.each([
    ["depeg-changelog", "v3"],
    ["yield-changelog", "v7"],
    ["liquidity-score-changelog", "v5"],
  ] as const)("does not present the %s %s shard top as the latest version", async (slug, archive) => {
    const html = await renderArchive(slug, archive);
    expect(html).not.toContain("Latest version");
    expect(html).not.toContain('id="latest-updates"');
    expect(html).not.toContain(">Latest<");
  });

  it("keeps the Latest version panel on the full changelog", async () => {
    const html = renderToStaticMarkup(
      await MethodologyChangelogRoute({ params: Promise.resolve({ slug: "depeg-changelog" }) }),
    );
    expect(html).toContain("Latest version");
    expect(html).toContain('id="latest-updates"');
  });
});
