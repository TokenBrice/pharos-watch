/* eslint-disable security/detect-non-literal-fs-filename -- reads blog post
   sources from the checked-in registry, rooted at process.cwd(); this test is
   the guard that justifies the fs.readFileSync carve-out in the blog route. */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BLOG_POSTS, BLOG_POST_BY_SLUG, LATEST_BLOG_POST } from "../index";

const POSTS_DIR = join(process.cwd(), "src/data/blog/posts");
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

describe("blog registry", () => {
  it("has at least one post", () => {
    expect(BLOG_POSTS.length).toBeGreaterThan(0);
  });

  it("uses unique, kebab-case slugs", () => {
    const slugs = BLOG_POSTS.map((post) => post.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug, `slug "${slug}" must be kebab-case`).toMatch(KEBAB);
    }
  });

  it("points every post at an existing Markdown source with no H1", () => {
    for (const post of BLOG_POSTS) {
      const path = join(POSTS_DIR, post.source);
      expect(existsSync(path), `missing source for ${post.slug}: ${post.source}`).toBe(true);
      const body = readFileSync(path, "utf8");
      // The title lives in the registry and renders as the page's single <h1>;
      // an H1 in the body would create a duplicate and fail the SEO gate.
      expect(/^# /m.test(body), `${post.source} must not contain an H1`).toBe(false);
      expect(body.trim().length, `${post.source} must not be empty`).toBeGreaterThan(0);
    }
  });

  it("has a valid, <=160-char description and ISO publish date per post", () => {
    for (const post of BLOG_POSTS) {
      expect(post.title.trim().length).toBeGreaterThan(0);
      expect(post.description.trim().length).toBeGreaterThan(0);
      expect(post.description.length, `${post.slug} description too long`).toBeLessThanOrEqual(160);
      expect(post.datePublished, `${post.slug} date must be YYYY-MM-DD`).toMatch(ISO_DATE);
      expect(Number.isNaN(new Date(`${post.datePublished}T00:00:00Z`).getTime())).toBe(false);
    }
  });

  it("is sorted newest-first with LATEST_BLOG_POST as the head", () => {
    const times = BLOG_POSTS.map((post) => new Date(`${post.datePublished}T00:00:00Z`).getTime());
    const sorted = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sorted);
    expect(LATEST_BLOG_POST).toBe(BLOG_POSTS[0]);
  });

  it("exposes a lookup map covering every post", () => {
    expect(BLOG_POST_BY_SLUG.size).toBe(BLOG_POSTS.length);
    for (const post of BLOG_POSTS) {
      expect(BLOG_POST_BY_SLUG.get(post.slug)).toBe(post);
    }
  });
});
