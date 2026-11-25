import type { Metadata } from "next";
import Link from "next/link";
import { Rss } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { JsonLdScript } from "@/components/json-ld-script";
import { digestDisplay } from "@/lib/fonts/digest";
import { buildCollectionItemListJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { BLOG_POSTS } from "@/data/blog";
import { getBlogPostReadingMinutes } from "./blog-reading-time";
import { formatPublishedDate } from "./format-published-date";

const BLOG_DESCRIPTION =
  "Product updates and the story of Pharos: what shipped, what's next, and why we build stablecoin risk tooling in the open.";

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Research & Product Updates",
  description: BLOG_DESCRIPTION,
  canonical: "/blog/",
});

export default function BlogHubPage() {
  const blogJsonLd = safeJsonLd(
    buildCollectionItemListJsonLd({
      url: `${SITE_URL}/blog/`,
      name: "Pharos Blog",
      description: BLOG_DESCRIPTION,
      entries: BLOG_POSTS.map((post) => ({
        item: {
          "@type": "BlogPosting",
          headline: post.title,
          description: post.description,
          datePublished: `${post.datePublished}T00:00:00Z`,
          url: `${SITE_URL}/blog/${post.slug}/`,
          mainEntityOfPage: `${SITE_URL}/blog/${post.slug}/`,
        },
      })),
    }),
  );

  const postsWithMeta = BLOG_POSTS.map((post) => ({
    post,
    readingMinutes: getBlogPostReadingMinutes(post.slug),
  }));
  const [featured, ...archive] = postsWithMeta;

  return (
    <FeaturePageShell
      breadcrumbName="Blog"
      path="/blog/"
      title="Blog"
      variant="longform"
      containerClassName="max-w-5xl"
      leadParagraphs={[
        <span key="blog-deck" className="block max-w-3xl">
          {BLOG_DESCRIPTION}
        </span>,
      ]}
      headerSupplement={
        <div className="pharos-meta flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span>
            <span className="pharos-numeric text-foreground/85">{BLOG_POSTS.length}</span>{" "}
            {BLOG_POSTS.length === 1 ? "dispatch" : "dispatches"}
          </span>
          <span aria-hidden="true">&middot;</span>
          <a href="/feed/blog.xml" className="pharos-prose-link inline-flex items-center gap-1.5">
            <Rss aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
            <span>RSS feed</span>
          </a>
          <span aria-hidden="true">&middot;</span>
          <Link href="/changelog/" className="pharos-prose-link">
            Weekly release notes &rarr;
          </Link>
        </div>
      }
    >
      <JsonLdScript json={blogJsonLd} />

      {featured ? (
        <section aria-label="Latest post">
          <Link
            href={`/blog/${featured.post.slug}/`}
            className={
              featured.post.coverImage
                ? "pharos-card-shell pharos-interactive-card pharos-focus-ring group grid overflow-hidden md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"
                : "pharos-card-shell pharos-interactive-card pharos-focus-ring group block overflow-hidden"
            }
          >
            {featured.post.coverImage ? (
              <div className="border-b border-border/50 md:border-r md:border-b-0">
                <img
                  src={featured.post.coverImage}
                  alt={featured.post.coverAlt ?? ""}
                  width={1200}
                  height={630}
                  loading="lazy"
                  decoding="async"
                  className="aspect-[1200/630] h-full w-full object-cover transition-opacity group-hover:opacity-95"
                />
              </div>
            ) : null}
            <div className="flex flex-col justify-between gap-5 p-5 sm:p-6">
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="pharos-label text-foreground">Latest</span>
                  <span aria-hidden="true" className="pharos-meta">
                    &middot;
                  </span>
                  <p className="pharos-meta">
                    <time dateTime={featured.post.datePublished}>
                      {formatPublishedDate(featured.post.datePublished)}
                    </time>
                    {" · "}
                    <span className="pharos-numeric">{featured.readingMinutes}</span> min read
                  </p>
                </div>
                <h2
                  className={`${digestDisplay.className} text-2xl font-semibold leading-tight tracking-tight text-foreground [text-wrap:balance] transition-colors group-hover:text-foreground/80 sm:text-3xl`}
                >
                  {featured.post.title}
                </h2>
                <p className="text-sm leading-relaxed text-muted-foreground [text-wrap:pretty]">
                  {featured.post.description}
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
                Read post <span aria-hidden="true">&rarr;</span>
              </span>
            </div>
          </Link>
        </section>
      ) : null}

      {archive.length > 0 ? (
        <section aria-labelledby="blog-archive-heading" className="space-y-4">
          <h2 id="blog-archive-heading" className="pharos-label">
            Earlier posts
          </h2>
          <ol className="grid gap-5 sm:grid-cols-2">
            {archive.map(({ post, readingMinutes }) => (
              <li key={post.slug}>
                <Link
                  href={`/blog/${post.slug}/`}
                  className="pharos-card-shell pharos-interactive-card pharos-focus-ring group flex h-full flex-col overflow-hidden"
                >
                  {post.coverImage ? (
                    <img
                      src={post.coverImage}
                      alt={post.coverAlt ?? ""}
                      width={1200}
                      height={630}
                      loading="lazy"
                      decoding="async"
                      className="aspect-[1200/630] w-full border-b border-border/50 object-cover transition-opacity group-hover:opacity-95"
                    />
                  ) : null}
                  <div className="flex flex-1 flex-col gap-2 p-5">
                    <p className="pharos-meta">
                      <time dateTime={post.datePublished}>
                        {formatPublishedDate(post.datePublished)}
                      </time>
                      {" · "}
                      <span className="pharos-numeric">{readingMinutes}</span> min read
                    </p>
                    <h3
                      className={`${digestDisplay.className} text-xl font-semibold leading-snug tracking-tight text-foreground [text-wrap:balance] transition-colors group-hover:text-foreground/80`}
                    >
                      {post.title}
                    </h3>
                    <p className="line-clamp-3 text-sm leading-relaxed text-muted-foreground [text-wrap:pretty]">
                      {post.description}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </FeaturePageShell>
  );
}
