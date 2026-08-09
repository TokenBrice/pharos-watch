/* eslint-disable security/detect-non-literal-fs-filename -- source paths come from the BLOG_POSTS registry and are guarded by blog-registry.test.ts. */

import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import type React from "react";
import { notFound } from "next/navigation";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import ReactMarkdown from "react-markdown";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { markdownLinkComponent } from "@/components/markdown-link";
import { buildArticleJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { BLOG_POST_BY_SLUG } from "@/data/blog";
import sitemapDates from "@/generated/sitemap-dates.json";
import { formatLongDate } from "@shared/lib/format";

const POSTS_DIR = path.join(process.cwd(), "src/data/blog/posts");
const OG_BLOG = "/og-blog.png";

// Blog posts render as authored editorial content: the article body uses the
// Georgia serif register (the `font-serif` carve-out, per DESIGN.md editorial
// rule and matching the detail-page AI summary). Prose links resolve through
// Next's Link; external links open in a new tab. No frost-blue in blog chrome.
const mdxComponents = {
  a: markdownLinkComponent(),
  // Inline article images: ![alt](/blog/x.png "optional caption"). Plain <img>
  // (static export = images.unoptimized, no-img-element off); a title becomes a
  // caption. react-markdown wraps a lone image in <p>, so use block <span>s
  // (valid inside <p>, unlike <figure>). Lazy-loaded (article images below fold).
  img: ({ src, alt, title }: React.ComponentProps<"img">) => {
    if (typeof src !== "string") return null;
    const image = (
      <img
        src={src}
        alt={alt ?? ""}
        loading="lazy"
        className="block w-full rounded-xl border border-border/50"
      />
    );
    if (!title) return image;
    return (
      <span className="block space-y-2">
        {image}
        <span className="block text-center font-sans text-xs text-muted-foreground">{title}</span>
      </span>
    );
  },
};

function formatPublishedDate(iso: string): string {
  return formatLongDate(new Date(`${iso}T00:00:00Z`), { utc: true });
}

export function generateStaticParams() {
  return Array.from(BLOG_POST_BY_SLUG.keys()).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = BLOG_POST_BY_SLUG.get(slug);
  if (!post) return { title: "Post Not Found" };

  return buildPageMetadata({
    title: `${post.title} | Pharos Blog`,
    description: post.description,
    canonical: `/blog/${slug}/`,
    ogImage: post.coverImage ?? OG_BLOG,
  });
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = BLOG_POST_BY_SLUG.get(slug);
  if (!post) notFound();

  const source = fs.readFileSync(path.join(POSTS_DIR, post.source), "utf-8");
  const canonical = `${SITE_URL}/blog/${slug}/`;
  const dateModified = (sitemapDates as Record<string, string>)[`/blog/${slug}/`] ?? post.datePublished;
  const socialImage = post.coverImage ?? OG_BLOG;

  return (
    <FeaturePageShell
      breadcrumbName={post.title}
      path={`/blog/${slug}/`}
      title={post.title}
      variant="longform"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Blog", url: "/blog/" },
        { name: post.title, url: `/blog/${slug}/` },
      ]}
      leadParagraphs={[post.description]}
      headerSupplement={
        <p className="pharos-meta">
          <time dateTime={post.datePublished}>{formatPublishedDate(post.datePublished)}</time>
        </p>
      }
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd(
            buildArticleJsonLd({
              type: "BlogPosting",
              headline: post.title,
              description: post.description,
              datePublished: `${post.datePublished}T00:00:00Z`,
              dateModified: dateModified.length === 10 ? `${dateModified}T00:00:00Z` : dateModified,
              image: `${SITE_URL}${socialImage}`,
              mainEntityOfPage: canonical,
            }),
          ),
        }}
      />
      {post.coverImage ? (
        // Plain <img>: static export runs with images.unoptimized and
        // @next/next/no-img-element off. 1200×630 covers fit this frame cleanly.
        <img
          src={post.coverImage}
          alt={post.coverAlt ?? ""}
          className="aspect-[1200/630] w-full rounded-xl border border-border/50 object-cover"
        />
      ) : null}
      <article className="space-y-5 font-serif text-[1.05rem] leading-8 text-foreground/90 [&_h2]:pt-5 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-foreground [&_h3]:pt-3 [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:text-foreground [&_p]:leading-8 [&_strong]:font-semibold [&_strong]:text-foreground [&_em]:italic [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-foreground/80">
        <ReactMarkdown
          components={mdxComponents}
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug]}
        >
          {source}
        </ReactMarkdown>
      </article>
    </FeaturePageShell>
  );
}
