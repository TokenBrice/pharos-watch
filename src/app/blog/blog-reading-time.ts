import "server-only";
import fs from "node:fs";
import path from "node:path";

const POSTS_DIR = path.join(process.cwd(), "src/data/blog/posts");
const WORDS_PER_MINUTE = 220;

export function readBlogPostSource(slug: string): string {
  return fs.readFileSync(path.join(POSTS_DIR, `${slug}.md`), "utf-8");
}

export function estimateReadingMinutes(source: string): number {
  const words = source.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

export function getBlogPostReadingMinutes(slug: string): number {
  return estimateReadingMinutes(readBlogPostSource(slug));
}
