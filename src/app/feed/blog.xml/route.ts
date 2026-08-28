import { BLOG_POSTS } from "@/data/blog";
import { createRssRoute, toRfc822, type RssItem } from "@/lib/rss";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

export const dynamic = "force-static";
export const revalidate = false;

const FEED_PATH = "/feed/blog.xml";

function blogItems(): RssItem[] {
  return BLOG_POSTS.map((post) => ({
    title: post.title,
    link: `${SITE_URL}/blog/${post.slug}/`,
    description: post.description,
    guid: `pharos:blog:${post.slug}`,
    pubDate: toRfc822(`${post.datePublished}T00:00:00Z`),
  }));
}

export const GET = createRssRoute({
  title: "Pharos Blog",
  link: `${SITE_URL}/blog/`,
  feedUrl: `${SITE_URL}${FEED_PATH}`,
  description:
    "Product updates and the story of Pharos — what shipped, what's next, and why we build stablecoin risk tooling in the open.",
  items: blogItems,
});
