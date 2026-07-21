/**
 * Blog post registry — the single source of truth for /blog.
 *
 * Each post is a Markdown file under `posts/` plus one entry here. Keep the
 * array sorted newest-first (enforced by `__tests__/blog-registry.test.ts`).
 * The Markdown body must NOT contain an H1 — the title below renders as the
 * page's single `<h1>` via FeaturePageShell.
 */
export interface BlogPost {
  /** Kebab-case URL slug. The post lives at /blog/<slug>/. */
  slug: string;
  /** Page H1 and metadata title. */
  title: string;
  /** Meta description, hub blurb, and RSS description. Keep <= 160 chars. */
  description: string;
  /** Publication date, YYYY-MM-DD. Drives sort order, RSS pubDate, and JSON-LD. */
  datePublished: string;
  /** Filename within posts/. */
  source: string;
  /**
   * Optional cover image, an absolute path under public/ (e.g.
   * "/blog/my-post-cover.png"). Renders atop the post and the hub card, and
   * doubles as the social/OG card. Author 1200×630 for a clean OG crop.
   */
  coverImage?: string;
  /** Alt text for the cover image. Required when coverImage is set. */
  coverAlt?: string;
}

export const BLOG_POSTS: readonly BlogPost[] = [
  {
    slug: "pharos-at-six-months",
    title: "Pharos at Six Months: The Lighthouse Is Lit",
    description:
      "Six months of Pharos: from a personal itch to open, on-chain depeg early-warning infrastructure. What shipped, what broke, and the road to sustainability.",
    datePublished: "2026-07-21",
    source: "pharos-at-six-months.md",
    coverImage: "/blog/pharos-at-six-months-cover.png",
    coverAlt:
      "The Pharos lighthouse, lit, casting a bright beam across the words “The Lighthouse Is Lit” beneath the label “Six Months of Pharos”.",
  },
];

export const BLOG_POST_BY_SLUG = new Map(BLOG_POSTS.map((post) => [post.slug, post]));

/** Newest post, for the homepage "new post" banner. */
export const LATEST_BLOG_POST: BlogPost = BLOG_POSTS[0];
