// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import BlogHubPage from "./page";
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
});
