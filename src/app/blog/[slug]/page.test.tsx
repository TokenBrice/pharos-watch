import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BLOG_POSTS } from "@/data/blog";
import BlogPostPage, { generateMetadata } from "./page";

describe("blog post metadata", () => {
  it("marks the already-branded title absolute so the root template cannot append Pharos twice", async () => {
    const post = BLOG_POSTS[0]!;
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: post.slug }) });

    expect(metadata.title).toEqual({ absolute: `${post.title} | Pharos Blog` });
  });

  it("shows organization authorship and the registry publication date", async () => {
    const post = BLOG_POSTS[0]!;
    const html = renderToStaticMarkup(await BlogPostPage({ params: Promise.resolve({ slug: post.slug }) }));
    expect(html).toMatch(/href="\/about\/?#editorial-ai-policy"/);
    expect(html).toMatch(/By <a[^>]+>Pharos<\/a> · Published/);
    expect(html).toContain(`<time dateTime="${post.datePublished}">`);
    expect(html).not.toContain("Reviewed by");
  });
});
