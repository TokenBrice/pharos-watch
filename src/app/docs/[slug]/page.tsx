
import fs from "node:fs";
import path from "node:path";
import type React from "react";
import Link from "next/link";
import GithubSlugger from "github-slugger";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import ReactMarkdown from "react-markdown";
import { ChevronDown } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { JsonLdScript } from "@/components/json-ld-script";
import { markdownLinkComponent } from "@/components/markdown-link";
import { TableBody, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { buildArticleJsonLd, safeJsonLd } from "@/lib/json-ld";
import { cn } from "@/lib/utils";
import { buildPageMetadata, getPageSocialPreview } from "@/lib/page-metadata";
import { createStaticSlugRoute } from "@/lib/static-slug-page";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { PUBLIC_DOC_BY_SLUG, preparePublicDocMarkdown, resolvePublicDocHref } from "@shared/lib/public-docs";
import docsMetadata from "@/generated/docs-metadata.json";

const DOCS_DIR = path.join(process.cwd(), "docs");
type MarkdownComponentProps<T extends keyof React.JSX.IntrinsicElements> = React.ComponentProps<T> & { node?: unknown };
interface MarkdownAstNode {
  tagName?: string;
  value?: string;
  children?: MarkdownAstNode[];
  position?: {
    start?: {
      line?: number;
    };
  };
}

// The root "%s | Pharos" template already brands the title; never repeat "Pharos" here.
function buildDocMetadataTitle(doc: { title: string; seoTitle?: string }): string {
  if (doc.seoTitle) return doc.seoTitle;
  const base = `${doc.title} Methodology`;
  // Short doc names ("DEWS Methodology") fall under the snippet minimum once
  // the duplicate " - Pharos Docs" suffix is gone; qualify them by topic.
  return base.length < DOC_TITLE_MIN_CORE_LENGTH ? `${base} for Stablecoins` : base;
}

/** 35-character snippet minimum minus the 9-character " | Pharos" suffix. */
const DOC_TITLE_MIN_CORE_LENGTH = 26;

function getMarkdownNodeText(node: MarkdownAstNode | undefined): string {
  if (!node) return "";
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map((child) => getMarkdownNodeText(child)).join(" ");
}

function findFirstMarkdownNodeByTag(node: MarkdownAstNode | undefined, tagName: string): MarkdownAstNode | undefined {
  if (!node) return undefined;
  if (node.tagName === tagName) return node;
  for (const child of node.children ?? []) {
    const found = findFirstMarkdownNodeByTag(child, tagName);
    if (found) return found;
  }
  return undefined;
}

function getMarkdownTableLabel(node: unknown): string {
  const tableNode = node as MarkdownAstNode | undefined;
  const firstRow = findFirstMarkdownNodeByTag(findFirstMarkdownNodeByTag(tableNode, "thead") ?? tableNode, "tr");
  const headers = (firstRow?.children ?? [])
    .filter((child) => child.tagName === "th")
    .map((child) => getMarkdownNodeText(child).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 4);
  const headerText = headers.join(", ");
  const line = tableNode?.position?.start?.line;
  const lineText = typeof line === "number" ? ` (line ${line})` : "";
  return headerText ? `Documentation table: ${headerText}${lineText}` : `Documentation table${lineText}`;
}

const mdxComponents = {
  a: markdownLinkComponent({ resolveHref: resolvePublicDocHref }),
  table: ({ node, children, className, ...props }: MarkdownComponentProps<"table">) => (
    <TableFrame
      chrome="content"
      density="compact"
      className={cn("my-4", className)}
      tableProps={{ "aria-label": getMarkdownTableLabel(node), ...props }}
      viewportProps={{ mobileScrollHint: false }}
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
    <td {...props} data-slot="table-cell" className={cn("whitespace-normal px-3 py-2 align-top", className)} />
  ),
};

interface DocTocHeading {
  id: string;
  text: string;
}

function stripInlineMarkdown(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~]+/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts level-2 (`##`) headings using the exact GithubSlugger sequence
 * `rehype-slug` walks across all headings so every TOC anchor matches its DOM id.
 */
function extractMarkdownH2Headings(markdown: string): DocTocHeading[] {
  const slugger = new GithubSlugger();
  const headings: DocTocHeading[] = [];
  let inFence = false;
  let fenceMarker = "";

  for (const rawLine of markdown.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) continue;

    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed);
    if (!headingMatch) continue;
    const level = headingMatch[1]!.length;
    const text = stripInlineMarkdown(headingMatch[2]!);
    if (!text) continue;
    const id = slugger.slug(text);
    if (level === 2) {
      headings.push({ id, text });
    }
  }
  return headings;
}

function renderDoc(doc: (typeof PUBLIC_DOC_BY_SLUG extends ReadonlyMap<string, infer T> ? T : never), slug: string) {
  const source = preparePublicDocMarkdown(fs.readFileSync(path.join(DOCS_DIR, doc.source), "utf-8"), {
    stripTitle: true,
    stripAgentNavigation: true,
  });
  const meta = (docsMetadata as Record<string, { dateModified: string; dateCreated: string }>)[slug];
  const updatedDate = meta?.dateModified?.slice(0, 10) ?? null;
  const headings = extractMarkdownH2Headings(source);
  const hasToc = headings.length >= 2;

  const articleBody = (
    <article className="min-w-0 max-w-3xl space-y-5 text-sm leading-7 text-muted-foreground [&_h2]:scroll-mt-24 [&_h2]:pt-4 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-foreground [&_h3]:scroll-mt-24 [&_h3]:pt-3 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-foreground [&_h4]:text-base [&_h4]:font-semibold [&_h4]:text-foreground [&_p]:leading-7 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-foreground/80 [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-foreground [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/60 [&_pre]:bg-muted/35 [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0">
      <ReactMarkdown
        components={mdxComponents}
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug, [rehypeAutolinkHeadings, { behavior: "wrap" }]]}
      >
        {source}
      </ReactMarkdown>
    </article>
  );

  return (
    <FeaturePageShell
      breadcrumbName={doc.title}
      path={`/docs/${slug}/`}
      title={doc.title}
      variant="longform"
      containerClassName={hasToc ? "max-w-5xl" : undefined}
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Docs", url: "/docs/" },
        { name: doc.title, url: `/docs/${slug}/` },
      ]}
      leadParagraphs={[doc.summary]}
      headerSupplement={
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
          {updatedDate ? (
            <span>
              Updated{" "}
              <time dateTime={meta.dateModified} className="pharos-numeric text-foreground/85">
                {updatedDate}
              </time>
            </span>
          ) : null}
          {updatedDate ? <span aria-hidden="true">·</span> : null}
          <a
            href={`/docs/${slug}/index.md`}
            className="pharos-focus-ring rounded-sm underline underline-offset-4 transition-colors hover:text-foreground"
          >
            Plain Markdown
          </a>
          <span aria-hidden="true">·</span>
          <Link
            href="/methodology/"
            className="pharos-focus-ring rounded-sm underline underline-offset-4 transition-colors hover:text-foreground"
          >
            Methodology overview &rarr;
          </Link>
        </div>
      }
    >
      <JsonLdScript
        json={safeJsonLd(
            buildArticleJsonLd({
              additionalType: "https://schema.org/TechArticle",
              id: `${SITE_URL}/docs/${slug}/`,
              headline: doc.title,
              description: doc.summary,
              datePublished: meta?.dateCreated,
              dateModified: meta?.dateModified,
              image: `${SITE_URL}${getPageSocialPreview(`/docs/${slug}/`).url}`,
              mainEntityOfPage: `${SITE_URL}/docs/${slug}/`,
              url: `${SITE_URL}/docs/${slug}/`,
            }),
          )}
      />
      {hasToc ? (
        <div className="space-y-6 lg:grid lg:grid-cols-[minmax(0,1fr)_15rem] lg:items-start lg:gap-10 lg:space-y-0">
          <details className="group rounded-lg border border-border/60 bg-muted/20 px-4 py-3 lg:hidden">
            <summary className="pharos-focus-ring flex cursor-pointer list-none items-center justify-between gap-2 rounded-sm text-xs font-semibold text-foreground [&::-webkit-details-marker]:hidden">
              <span>On this page ({headings.length})</span>
              <ChevronDown
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
              />
            </summary>
            <nav aria-label="On this page (mobile)" className="mt-3 border-t border-border/50 pt-3">
              <ol className="space-y-1.5 text-xs">
                {headings.map((heading) => (
                  <li key={heading.id}>
                    <a
                      href={`#${heading.id}`}
                      className="pharos-focus-ring block rounded-sm py-0.5 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {heading.text}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          </details>

          {articleBody}

          <aside className="hidden lg:sticky lg:top-[var(--sticky-header-bottom,4rem)] lg:block lg:max-h-[calc(100vh-5rem)] lg:overflow-y-auto lg:border-l lg:border-border/60 lg:pl-4">
            <nav aria-label="On this page" className="space-y-2.5">
              <p className="pharos-label">On this page</p>
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
        articleBody
      )}
    </FeaturePageShell>
  );
}

const route = createStaticSlugRoute({
  paramKey: "slug",
  pages: Array.from(PUBLIC_DOC_BY_SLUG.values()),
  pageBySlug: PUBLIC_DOC_BY_SLUG,
  metadata: (doc, slug) => buildPageMetadata({
    title: buildDocMetadataTitle(doc),
    description: doc.summary,
    canonical: `/docs/${slug}/`,
  }),
  missingMetadata: { title: "Doc Not Found" },
  render: renderDoc,
});

export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
