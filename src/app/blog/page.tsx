import type { Metadata } from "next";
import Link from "next/link";
import { Rss } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { BLOG_POSTS } from "@/data/blog";

const BLOG_DESCRIPTION =
  "Product updates and the story of Pharos — what shipped, what's next, and why we build stablecoin risk tooling in the open.";

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Research & Product Updates",
  description: BLOG_DESCRIPTION,
  canonical: "/blog/",
  ogImage: "/og-blog.png",
});

function formatPublishedDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function BlogHubPage() {
  const blogJsonLd = safeJsonLd({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Pharos Blog",
    description: BLOG_DESCRIPTION,
    url: `${SITE_URL}/blog/`,
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: BLOG_POSTS.length,
      itemListElement: BLOG_POSTS.map((post, i) => ({
        "@type": "ListItem",
        position: i + 1,
        item: {
          "@type": "BlogPosting",
          headline: post.title,
          description: post.description,
          datePublished: `${post.datePublished}T00:00:00Z`,
          url: `${SITE_URL}/blog/${post.slug}/`,
          mainEntityOfPage: `${SITE_URL}/blog/${post.slug}/`,
        },
      })),
    },
  });

  return (
    <FeaturePageShell
      breadcrumbName="Blog"
      path="/blog/"
      title="Blog"
      variant="longform"
      containerClassName="mx-auto max-w-3xl"
      leadParagraphs={[BLOG_DESCRIPTION]}
    >
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: blogJsonLd }} />
      <ol className="space-y-8">
        {BLOG_POSTS.map((post) => (
          <li key={post.slug} className="space-y-2.5">
            {post.coverImage ? (
              <Link href={`/blog/${post.slug}/`} className="block" aria-label={post.title}>
                <img
                  src={post.coverImage}
                  alt={post.coverAlt ?? ""}
                  className="aspect-[1200/630] w-full rounded-xl border border-border/50 object-cover transition-opacity hover:opacity-90"
                />
              </Link>
            ) : null}
            <div className="space-y-1.5">
              <p className="pharos-meta">
                <time dateTime={post.datePublished}>{formatPublishedDate(post.datePublished)}</time>
              </p>
              <h2 className="font-serif text-2xl font-semibold leading-tight tracking-tight">
                <Link href={`/blog/${post.slug}/`} className="text-foreground hover:text-foreground/80">
                  {post.title}
                </Link>
              </h2>
              <p className="text-sm leading-7 text-muted-foreground">{post.description}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-10 border-t border-border/50 pt-4 text-sm text-muted-foreground">
        <a href="/feed/blog.xml" className="pharos-prose-link inline-flex items-center gap-1.5">
          <Rss aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2} />
          Subscribe via RSS
        </a>
      </p>
    </FeaturePageShell>
  );
}
