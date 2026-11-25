
import fs from "node:fs";
import path from "node:path";
import type React from "react";
import Link from "next/link";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import ReactMarkdown from "react-markdown";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { JsonLdScript } from "@/components/json-ld-script";
import { markdownLinkComponent } from "@/components/markdown-link";
import {
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { cn } from "@/lib/utils";
import { buildArticleJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata, getPageSocialPreview } from "@/lib/page-metadata";
import { createStaticSlugRoute } from "@/lib/static-slug-page";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { BLOG_POST_BY_SLUG } from "@/data/blog";
import sitemapDates from "@/generated/sitemap-dates.json";
import { formatPublishedDate } from "../format-published-date";

const POSTS_DIR = path.join(process.cwd(), "src/data/blog/posts");

type MarkdownComponentProps<T extends keyof React.JSX.IntrinsicElements> = React.ComponentPropsWithoutRef<T> & {
  node?: unknown;
};

// Blog posts render as authored editorial content: the article body uses the
// Georgia serif register (the `font-serif` carve-out, per DESIGN.md editorial
// rule and matching the detail-page AI summary). Prose links resolve through
// Next's Link; external links open in a new tab. No frost-blue in blog chrome.
const mdxComponents = {
  a: markdownLinkComponent(),
  table: ({ node: _node, children, className, ...props }: MarkdownComponentProps<"table">) => (
    <TableFrame
      chrome="content"
      density="compact"
      className={cn("my-5 font-sans", className)}
      tableProps={props}
    >
      {children}
    </TableFrame>
  ),
  thead: ({ node: _node, className, ...props }: MarkdownComponentProps<"thead">) => (
    <TableHeader className={className} {...props} />
  ),
  tbody: ({ node: _node, className, ...props }: MarkdownComponentProps<"tbody">) => (
    <TableBody className={className} {...props} />
  ),
  tr: ({ node: _node, className, ...props }: MarkdownComponentProps<"tr">) => (
    <TableRow className={className} {...props} />
  ),
  th: ({ node: _node, className, scope, ...props }: MarkdownComponentProps<"th">) => (
    <TableHead
      scope={scope ?? "col"}
      className={cn("h-auto whitespace-normal px-3 py-2 text-foreground", className)}
      {...props}
    />
  ),
  td: ({ node: _node, className, ...props }: MarkdownComponentProps<"td">) => (
    <TableCell className={cn("whitespace-normal px-3 py-2 align-top", className)} {...props} />
  ),
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
        decoding="async"
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

function renderBlogPost(post: (typeof BLOG_POST_BY_SLUG extends ReadonlyMap<string, infer T> ? T : never), slug: string) {
  const source = fs.readFileSync(path.join(POSTS_DIR, `${post.slug}.md`), "utf-8");
  const canonical = `${SITE_URL}/blog/${slug}/`;
  const dateModified = (sitemapDates as Record<string, string>)[`/blog/${slug}/`] ?? post.datePublished;
  const socialImage = getPageSocialPreview(canonical).url;

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
          By <Link href="/about/#editorial-ai-policy" className="pharos-prose-link">Pharos</Link>
          {" · Published "}
          <time dateTime={post.datePublished}>{formatPublishedDate(post.datePublished)}</time>
        </p>
      }
    >
      <JsonLdScript
        json={safeJsonLd(
            buildArticleJsonLd({
              type: "BlogPosting",
              headline: post.title,
              description: post.description,
              datePublished: `${post.datePublished}T00:00:00Z`,
              dateModified: dateModified.length === 10 ? `${dateModified}T00:00:00Z` : dateModified,
              image: `${SITE_URL}${socialImage}`,
              mainEntityOfPage: canonical,
            }),
          )}
      />
      {post.coverImage ? (
        // Plain <img>: static export runs with images.unoptimized and
        // @next/next/no-img-element off. 1200×630 covers fit this frame cleanly.
        <img
          src={post.coverImage}
          alt={post.coverAlt ?? ""}
          width={1200}
          height={630}
          decoding="async"
          className="aspect-[1200/630] w-full rounded-xl border border-border/50 object-cover"
        />
      ) : null}
      <article className="space-y-5 font-serif text-[1.05rem] leading-8 text-foreground/90 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-foreground/80 [&_code]:rounded-sm [&_code]:border [&_code]:border-border/50 [&_code]:bg-muted/60 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-foreground [&_em]:italic [&_h2]:scroll-mt-[calc(var(--sticky-header-bottom,4rem)+1rem)] [&_h2]:pt-5 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-foreground [&_h3]:scroll-mt-[calc(var(--sticky-header-bottom,4rem)+1rem)] [&_h3]:pt-3 [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:text-foreground [&_hr]:my-8 [&_hr]:border-border/60 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-5 [&_p]:leading-8 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-[var(--code-surface-border)] [&_pre]:bg-[var(--code-surface-bg)] [&_pre]:p-4 [&_pre]:font-mono [&_pre]:text-sm [&_pre]:leading-6 [&_pre]:text-[var(--code-surface-fg)] [&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
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

const route = createStaticSlugRoute({
  paramKey: "slug",
  pages: Array.from(BLOG_POST_BY_SLUG.values()),
  pageBySlug: BLOG_POST_BY_SLUG,
  metadata: (post, slug) => buildPageMetadata({
    title: `${post.title} | Pharos Blog`,
    titleAbsolute: true,
    description: post.description,
    canonical: `/blog/${slug}/`,
    ogType: "article",
    publishedTime: `${post.datePublished}T00:00:00Z`,
  }),
  missingMetadata: { title: "Post Not Found" },
  render: renderBlogPost,
});

export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
