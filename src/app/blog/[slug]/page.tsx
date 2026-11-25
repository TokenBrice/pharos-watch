import type React from "react";
import Link from "next/link";
import { ArrowLeft, Rss } from "lucide-react";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import ReactMarkdown from "react-markdown";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { DisclosurePanel } from "@/components/disclosure-panel";
import { JsonLdScript } from "@/components/json-ld-script";
import { markdownLinkComponent } from "@/components/markdown-link";
import { ShareButton } from "@/components/share-button";
import {
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { digestDisplay } from "@/lib/fonts/digest";
import { cn } from "@/lib/utils";
import { buildArticleJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata, getPageSocialPreview } from "@/lib/page-metadata";
import { createStaticSlugRoute } from "@/lib/static-slug-page";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { BLOG_POST_BY_SLUG, BLOG_POSTS } from "@/data/blog";
import sitemapDates from "@/generated/sitemap-dates.json";
import { estimateReadingMinutes, readBlogPostSource } from "../blog-reading-time";
import { formatPublishedDate } from "../format-published-date";

const TOC_MIN_HEADINGS = 4;

type MarkdownComponentProps<T extends keyof React.JSX.IntrinsicElements> = React.ComponentPropsWithoutRef<T> & {
  node?: unknown;
};

interface BlogTocHeading {
  id: string;
  text: string;
}

interface HastNode {
  type: string;
  tagName?: string;
  properties?: { id?: unknown };
  value?: string;
  children?: HastNode[];
  position?: unknown;
}

function extractHastText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(extractHastText).join("");
}

/**
 * Collects level-2 (`<h2>`) headings in `rehypePlugins` immediately after
 * `rehypeSlug`, reading each rendered DOM `id` directly so TOC anchors match
 * rendered headings without a second markdown or slugger pass.
 */
function rehypeCollectH2Headings(headings: BlogTocHeading[]) {
  return () => (tree: HastNode): void => {
    headings.length = 0;
    const visit = (node: HastNode): void => {
      if (node.type === "element" && node.tagName === "h2") {
        const id = typeof node.properties?.id === "string" ? node.properties.id : "";
        const text = extractHastText(node).replace(/\s+/g, " ").trim();
        // Renderer-generated headings (GFM's sr-only footnote label) have no source position.
        if (id && text && node.position) {
          headings.push({ id, text });
        }
        return;
      }
      for (const child of node.children ?? []) {
        visit(child);
      }
    };

    visit(tree);
  };
}

// Blog posts pair Newsreader display headings (`digestDisplay.className` on
// H1/H2/H3 only) with the Georgia serif body register (`font-serif` without
// `digestDisplay.variable`, per docs/process/blog-publishing.md). Prose links
// resolve through Next's Link; external links open in a new tab. No frost-blue
// in blog chrome.
const mdxComponents = {
  a: markdownLinkComponent(),
  h2: ({ node: _node, className, ...props }: MarkdownComponentProps<"h2">) => (
    <h2 className={cn(digestDisplay.className, className)} {...props} />
  ),
  h3: ({ node: _node, className, ...props }: MarkdownComponentProps<"h3">) => (
    <h3 className={cn(digestDisplay.className, className)} {...props} />
  ),
  table: ({ node: _node, children, className, ...props }: MarkdownComponentProps<"table">) => (
    <TableFrame
      chrome="content"
      density="compact"
      className={cn("my-6 font-sans", className)}
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
        className="block w-full rounded-xl border border-border/75 dark:border-border/60"
      />
    );
    if (!title) {
      return <span className="my-7 block">{image}</span>;
    }
    return (
      <span className="my-7 block space-y-2.5">
        {image}
        <span className="block text-center font-sans text-xs leading-relaxed text-muted-foreground">{title}</span>
      </span>
    );
  },
};

function renderBlogPost(post: (typeof BLOG_POST_BY_SLUG extends ReadonlyMap<string, infer T> ? T : never), slug: string) {
  const source = readBlogPostSource(post.slug);
  const readingMinutes = estimateReadingMinutes(source);
  const canonical = `${SITE_URL}/blog/${slug}/`;
  const dateModified = (sitemapDates as Record<string, string>)[`/blog/${slug}/`] ?? post.datePublished;
  const socialImage = getPageSocialPreview(canonical).url;

  const headings: BlogTocHeading[] = [];
  const renderedMarkdown = ReactMarkdown({
    children: source,
    components: mdxComponents,
    remarkPlugins: [remarkGfm],
    rehypePlugins: [rehypeSlug, rehypeCollectH2Headings(headings)],
  });
  const hasToc = headings.length >= TOC_MIN_HEADINGS;

  const postIndex = BLOG_POSTS.findIndex((entry) => entry.slug === post.slug);
  const newerPost = postIndex > 0 ? BLOG_POSTS[postIndex - 1] : null;
  const olderPost = postIndex >= 0 && postIndex < BLOG_POSTS.length - 1 ? BLOG_POSTS[postIndex + 1] : null;

  const coverNode = post.coverImage ? (
    // Plain <img>: static export runs with images.unoptimized and
    // @next/next/no-img-element off. 1200×630 covers fit this frame cleanly.
    <img
      src={post.coverImage}
      alt={post.coverAlt ?? ""}
      width={1200}
      height={630}
      decoding="async"
      className="aspect-[1200/630] w-full rounded-xl border border-border/75 object-cover dark:border-border/60"
    />
  ) : null;

  const articleNode = (
    <article className="max-w-[68ch] space-y-5 font-serif text-base leading-8 text-foreground/90 sm:text-lg [&_blockquote]:my-6 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border-strong)] [&_blockquote]:pl-5 [&_blockquote]:italic [&_blockquote]:text-foreground/85 [&_code]:rounded-sm [&_code]:border [&_code]:border-border/50 [&_code]:bg-muted/60 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-foreground [&_code]:[overflow-wrap:anywhere] [&_em]:italic [&_h2]:mt-10 [&_h2]:scroll-mt-[calc(var(--sticky-header-bottom,4rem)+1rem)] [&_h2]:border-t [&_h2]:border-border/40 [&_h2]:pt-7 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-foreground [&_h2]:[text-wrap:balance] [&_h2]:first:mt-0 [&_h2]:first:border-t-0 [&_h2]:first:pt-0 [&_h3]:mt-7 [&_h3]:scroll-mt-[calc(var(--sticky-header-bottom,4rem)+1rem)] [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:tracking-tight [&_h3]:text-foreground [&_h3]:[text-wrap:balance] [&_hr]:my-8 [&_hr]:border-border/60 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-5 [&_p]:leading-8 [&_p]:[text-wrap:pretty] [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-[var(--code-surface-border)] [&_pre]:bg-[var(--code-surface-bg)] [&_pre]:p-4 [&_pre]:font-mono [&_pre]:text-sm [&_pre]:leading-6 [&_pre]:text-[var(--code-surface-fg)] [&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit [&_pre_code]:[overflow-wrap:normal] [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
      {renderedMarkdown}
    </article>
  );

  return (
    <div className={cn("mx-auto w-full space-y-6", hasToc ? "max-w-5xl" : "max-w-3xl")}>
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "Blog", url: "/blog/" },
          { name: post.title, url: `/blog/${slug}/` },
        ]}
      />
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

      <header className="space-y-4">
        <Link
          href="/blog/"
          className="pharos-focus-ring inline-flex min-h-9 w-fit items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span>All posts</span>
        </Link>

        <div className="space-y-3">
          <h1
            className={`${digestDisplay.className} max-w-3xl text-3xl font-semibold leading-tight tracking-tight text-foreground [text-wrap:balance] sm:text-4xl lg:text-5xl`}
          >
            {post.title}
          </h1>
          <p className="pharos-page-deck max-w-[68ch]">{post.description}</p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-y border-border/50 py-3">
          <p className="pharos-meta">
            By{" "}
            <Link href="/about/#editorial-ai-policy" className="pharos-prose-link">
              Pharos
            </Link>
            {" · Published "}
            <time dateTime={post.datePublished}>{formatPublishedDate(post.datePublished)}</time>
            {" · "}
            <span className="pharos-numeric">{readingMinutes}</span> min read
          </p>
          <ShareButton label="Share" />
        </div>
      </header>

      {hasToc ? (
        <div className="space-y-6 lg:grid lg:grid-cols-[minmax(0,1fr)_14rem] lg:items-start lg:gap-10 lg:space-y-0">
          <div className="min-w-0 space-y-6">
            {coverNode}
            <DisclosurePanel variant="inset" summary="In this post" className="lg:hidden">
              <nav aria-label="In this post (mobile)">
                <ol className="space-y-1.5 text-sm">
                  {headings.map((heading) => (
                    <li key={heading.id}>
                      <a
                        href={`#${heading.id}`}
                        className="pharos-focus-ring block rounded-sm py-1 leading-snug text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {heading.text}
                      </a>
                    </li>
                  ))}
                </ol>
              </nav>
            </DisclosurePanel>
            {articleNode}
          </div>

          <aside className="hidden lg:sticky lg:top-[calc(var(--sticky-header-bottom,3.75rem)+1.5rem)] lg:block lg:max-h-[calc(100dvh-var(--sticky-header-bottom,3.75rem)-3rem)] lg:overflow-y-auto lg:border-l lg:border-border/50 lg:pl-4">
            <nav aria-label="In this post" className="space-y-2.5">
              <p className="pharos-label">In this post</p>
              <ol className="space-y-1.5 text-xs">
                {headings.map((heading) => (
                  <li key={heading.id}>
                    <a
                      href={`#${heading.id}`}
                      className="pharos-focus-ring block rounded-sm py-0.5 leading-snug text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {heading.text}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          </aside>
        </div>
      ) : (
        <div className="space-y-6">
          {coverNode}
          {articleNode}
        </div>
      )}

      {newerPost || olderPost ? (
        <nav aria-label="Post navigation" className="grid gap-4 border-t border-border/50 pt-6 sm:grid-cols-2">
          {newerPost ? (
            <Link
              href={`/blog/${newerPost.slug}/`}
              className="pharos-card-shell pharos-interactive-card pharos-focus-ring group flex flex-col gap-1.5 p-4"
            >
              <span className="pharos-label">&larr; Newer post</span>
              <span
                className={`${digestDisplay.className} text-lg font-semibold leading-snug tracking-tight text-foreground [text-wrap:balance] transition-colors group-hover:text-foreground/80`}
              >
                {newerPost.title}
              </span>
              <span className="pharos-meta">
                <time dateTime={newerPost.datePublished}>
                  {formatPublishedDate(newerPost.datePublished)}
                </time>
              </span>
            </Link>
          ) : (
            <div className="hidden sm:block" aria-hidden="true" />
          )}
          {olderPost ? (
            <Link
              href={`/blog/${olderPost.slug}/`}
              className="pharos-card-shell pharos-interactive-card pharos-focus-ring group flex flex-col gap-1.5 p-4 sm:items-end sm:text-right"
            >
              <span className="pharos-label">Older post &rarr;</span>
              <span
                className={`${digestDisplay.className} text-lg font-semibold leading-snug tracking-tight text-foreground [text-wrap:balance] transition-colors group-hover:text-foreground/80`}
              >
                {olderPost.title}
              </span>
              <span className="pharos-meta">
                <time dateTime={olderPost.datePublished}>
                  {formatPublishedDate(olderPost.datePublished)}
                </time>
              </span>
            </Link>
          ) : null}
        </nav>
      ) : null}

      <aside
        aria-label="Follow Pharos"
        className="pharos-subtle-band flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 text-sm"
      >
        <p className="pharos-label">Follow Pharos</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
          <a href="/feed/blog.xml" className="pharos-prose-link inline-flex items-center gap-1.5">
            <Rss aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
            <span>Subscribe via RSS</span>
          </a>
          <span aria-hidden="true">&middot;</span>
          <Link href="/pharoswatchbot/#channel" className="pharos-prose-link">
            Daily Digest on Telegram
          </Link>
          <span aria-hidden="true">&middot;</span>
          <Link href="/safety-scores/" className="pharos-prose-link">
            Explore Safety Scores
          </Link>
        </div>
      </aside>
    </div>
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
