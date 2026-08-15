import { describe, expect, it } from "vitest";
import { BLOG_POSTS } from "@/data/blog";
import { generateMetadata } from "./page";

describe("blog post metadata", () => {
  it("marks the already-branded title absolute so the root template cannot append Pharos twice", async () => {
    const post = BLOG_POSTS[0]!;
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: post.slug }) });

    expect(metadata.title).toEqual({ absolute: `${post.title} | Pharos Blog` });
  });
});
