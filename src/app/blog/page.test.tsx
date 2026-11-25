// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("next/font/local", () => ({
  default: () => ({ className: "font-newsreader-test", variable: "--font-newsreader-test" }),
}));

import BlogHubPage from "./page";
import BlogPostPage from "./[slug]/page";
import { BLOG_POSTS } from "@/data/blog";

afterEach(cleanup);

describe("Blog hub cover loading", () => {
  it("reserves cover dimensions without promoting covers into route-prefetch preloads", () => {
    const { container } = render(<BlogHubPage />);
    const images = Array.from(container.querySelectorAll<HTMLImageElement>('img[src^="/blog/"]'));
    expect(images).toHaveLength(BLOG_POSTS.filter((post) => post.coverImage).length);
    for (const image of images) {
      expect(image.getAttribute("width")).toBe("1200");
      expect(image.getAttribute("height")).toBe("630");
      expect(image.getAttribute("loading")).toBe("lazy");
      expect(image.getAttribute("decoding")).toBe("async");
    }
    expect(container.querySelector('link[rel="preload"][as="image"]')).toBeNull();
  });

  it("renders featured latest post, 2-column archive grid, RSS feed, changelog link, and reading times", () => {
    const { container } = render(<BlogHubPage />);
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href]"));
    const hrefs = links.map((link) => link.getAttribute("href"));

    expect(hrefs).toContain("/feed/blog.xml");
    expect(hrefs).toContain("/changelog/");
    for (const post of BLOG_POSTS) {
      expect(hrefs.filter((href) => href === `/blog/${post.slug}/`)).toHaveLength(1);
    }

    expect(container.textContent).toContain(`${BLOG_POSTS.length} dispatches`);
    expect(container.textContent).toContain("Latest");
    expect(container.textContent).toContain("min read");

    const archiveList = container.querySelector("ol");
    expect(archiveList?.querySelectorAll("li")).toHaveLength(Math.max(0, BLOG_POSTS.length - 1));
  });
});

describe("Blog post editorial layout", () => {
  it("renders Newsreader headings with Georgia body, TOC on long posts, share button, and prev/next navigation", async () => {
    const longPost = BLOG_POSTS.find((post) => post.slug === "safety-score-v10") ?? BLOG_POSTS[1]!;
    const element = await BlogPostPage({ params: Promise.resolve({ slug: longPost.slug }) });
    const { container } = render(element);

    const h1 = container.querySelector("h1");
    expect(h1?.className).toContain("font-newsreader-test");
    expect(h1?.textContent).toBe(longPost.title);

    const article = container.querySelector("article");
    expect(article?.className).toContain("font-serif");
    expect(article?.className).toContain("max-w-[68ch]");
    expect(article?.className).not.toContain("--font-newsreader-test");

    const firstH2 = article?.querySelector("h2");
    expect(firstH2?.className).toContain("font-newsreader-test");
    expect(firstH2?.getAttribute("id")).toBeTruthy();

    const tocNav = container.querySelector('nav[aria-label="In this post"]');
    expect(tocNav).not.toBeNull();
    expect(tocNav?.querySelectorAll('a[href^="#"]').length).toBeGreaterThanOrEqual(4);

    const mobileToc = container.querySelector("details");
    expect(mobileToc?.querySelector("summary")?.textContent).toContain("In this post");

    expect(container.querySelector('a[href="/blog/"]')?.textContent).toContain("All posts");
    expect(container.querySelector('a[href="/about/#editorial-ai-policy"]')).not.toBeNull();
    expect(container.querySelector('a[href="/feed/blog.xml"]')).not.toBeNull();
    expect(container.querySelector('a[href="/pharoswatchbot/#channel"]')).not.toBeNull();
    expect(container.querySelector('a[href="/safety-scores/"]')).not.toBeNull();
    expect(container.querySelector('nav[aria-label="Post navigation"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Share"]')).not.toBeNull();
  });

  it("omits TOC when a post has fewer than 4 H2 headings", async () => {
    const shortH2Post = BLOG_POSTS.find((post) => post.slug === "pharos-api-risk-gate-compliance-mcp")!;
    const element = await BlogPostPage({ params: Promise.resolve({ slug: shortH2Post.slug }) });
    const { container } = render(element);

    expect(container.querySelector('nav[aria-label="In this post"]')).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector('nav[aria-label="Post navigation"] a[href^="/blog/"]')).not.toBeNull();
  });
});
