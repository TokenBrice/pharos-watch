import fs from "node:fs";
import path from "node:path";
import type React from "react";
import Link from "next/link";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import ReactMarkdown from "react-markdown";
import { ArrowLeft, ArrowRight, ArrowUpRight, ExternalLink } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { CopyMarkdownButton } from "@/components/docs/copy-markdown-button";
import { DocsToc, type DocTocHeading } from "@/components/docs/docs-toc";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { JsonLdScript } from "@/components/json-ld-script";
import { markdownLinkComponent } from "@/components/markdown-link";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { buildArticleJsonLd, safeJsonLd } from "@/lib/json-ld";
import { cn } from "@/lib/utils";
import { buildPageMetadata, getPageSocialPreview } from "@/lib/page-metadata";
import { createStaticSlugRoute } from "@/lib/static-slug-page";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { PUBLIC_DOCS, PUBLIC_DOC_BY_SLUG, preparePublicDocMarkdown, resolvePublicDocHref } from "@shared/lib/public-docs";
import docsMetadata from "@/generated/docs-metadata.json";

const DOCS_DIR = path.join(process.cwd(), "docs");
const GITHUB_DOCS_BLOB_BASE = "https://github.com/TokenBrice/pharos-watch/blob/main/docs";
const WORDS_PER_MINUTE = 220;

type MarkdownComponentProps<T extends keyof React.JSX.IntrinsicElements> = React.ComponentProps<T> & { node?: unknown };

interface HastNode {
  type?: string;
  tagName?: string;
  properties?: {
    id?: unknown;
    className?: unknown;
  };
  value?: string;
  children?: HastNode[];
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

function getMarkdownNodeText(node: HastNode | undefined): string {
  if (!node) return "";
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map((child) => getMarkdownNodeText(child)).join(" ");
}

function extractHastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text" || typeof node.value === "string") return node.value ?? "";
  return (node.children ?? []).map(extractHastText).join("");
}

function findFirstMarkdownNodeByTag(node: HastNode | undefined, tagName: string): HastNode | undefined {
  if (!node) return undefined;
  if (node.tagName === tagName) return node;
  for (const child of node.children ?? []) {
    const found = findFirstMarkdownNodeByTag(child, tagName);
    if (found) return found;
  }
  return undefined;
}

function getMarkdownTableLabel(node: unknown): string {
  const tableNode = node as HastNode | undefined;
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

function getMarkdownTableColumnCount(node: unknown): number {
  const tableNode = node as HastNode | undefined;
  const firstRow = findFirstMarkdownNodeByTag(findFirstMarkdownNodeByTag(tableNode, "thead") ?? tableNode, "tr");
  if (!firstRow) return 0;
  return (firstRow.children ?? []).filter((child) => child.tagName === "th" || child.tagName === "td").length;
}

function extractCodeBlockLanguage(preNode: unknown): string | null {
  const codeNode = findFirstMarkdownNodeByTag(preNode as HastNode | undefined, "code");
  const rawClassName = codeNode?.properties?.className;
  const classes = Array.isArray(rawClassName)
    ? rawClassName.filter((item): item is string => typeof item === "string")
    : typeof rawClassName === "string"
      ? rawClassName.split(/\s+/)
      : [];
  const langClass = classes.find((cls) => cls.startsWith("language-"));
  if (!langClass) return null;
  const label = langClass.slice("language-".length).trim();
  return label.length > 0 ? label : null;
}

function estimateReadingMinutes(markdown: string): number {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*_>|~-]/g, " ");
  const words = plain.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

const baseMarkdownLink = markdownLinkComponent({ resolveHref: resolvePublicDocHref });

const mdxComponents = {
  a: ({ node: _node, href, className, children, ...props }: MarkdownComponentProps<"a">) => {
    if (className?.includes("docs-heading-anchor") && href?.startsWith("#")) {
      return (
        <a
          href={href}
          className={cn(
            "pharos-focus-ring inline rounded-sm no-underline transition-colors hover:text-foreground after:ml-1.5 after:font-normal after:text-muted-foreground/70 after:opacity-0 after:transition-opacity after:content-['#'] hover:after:opacity-100 focus-visible:after:opacity-100",
            className,
          )}
          {...props}
        >
          {children}
        </a>
      );
    }
    return baseMarkdownLink({ href, className, children, ...props });
  },
  h2: ({ node: _node, className, ...props }: MarkdownComponentProps<"h2">) => {
    if (className?.includes("sr-only")) {
      return <h2 className={className} {...props} />;
    }
    return (
      <h2
        className={cn(
          "pharos-display mt-10 scroll-mt-32 border-t border-border/50 pt-6 text-2xl font-bold tracking-tight text-foreground first:mt-0 first:border-t-0 first:pt-0 lg:scroll-mt-24",
          className,
        )}
        {...props}
      />
    );
  },
  h3: ({ node: _node, className, ...props }: MarkdownComponentProps<"h3">) => (
    <h3
      className={cn("mt-7 scroll-mt-32 text-lg font-semibold tracking-tight text-foreground lg:scroll-mt-24", className)}
      {...props}
    />
  ),
  h4: ({ node: _node, className, ...props }: MarkdownComponentProps<"h4">) => (
    <h4 className={cn("mt-5 scroll-mt-32 text-base font-semibold text-foreground lg:scroll-mt-24", className)} {...props} />
  ),
  pre: ({ node, children, className, ...props }: MarkdownComponentProps<"pre">) => {
    const codeText = extractHastText(node as HastNode | undefined).replace(/\n$/, "");
    const language = extractCodeBlockLanguage(node);
    return (
      <div className="my-5 overflow-hidden rounded-xl border border-[var(--code-surface-border)] bg-[var(--code-surface-bg)] text-[var(--code-surface-fg)]">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--code-surface-border)] px-3.5 py-2">
          {language ? (
            <span className="font-mono text-2xs font-semibold text-[var(--code-surface-muted)]">{language}</span>
          ) : (
            <span />
          )}
          <CopyButton
            text={codeText}
            className="text-[var(--code-surface-muted)] hover:bg-white/10 hover:text-[var(--code-surface-fg)]"
          />
        </div>
        <pre
          className={cn(
            "overflow-x-auto px-4 py-3.5 font-mono text-xs leading-relaxed [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit [&_code]:[font-size:inherit] [&_code]:[overflow-wrap:normal]",
            className,
          )}
          {...props}
        >
          {children}
        </pre>
      </div>
    );
  },
  code: ({ node: _node, className, ...props }: MarkdownComponentProps<"code">) => (
    <code
      className={cn(
        "rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.875em] text-foreground [overflow-wrap:anywhere]",
        className,
      )}
      {...props}
    />
  ),
  table: ({ node, children, className, ...props }: MarkdownComponentProps<"table">) => {
    const colCount = getMarkdownTableColumnCount(node);
    return (
      <TableFrame
        chrome="content"
        density="compact"
        className={cn("my-5", className)}
        tableProps={{ "aria-label": getMarkdownTableLabel(node), ...props }}
        viewportProps={{ mobileScrollHint: colCount <= 3 ? false : undefined }}
      >
        {children}
      </TableFrame>
    );
  },
  thead: ({ node: _node, className, ...props }: MarkdownComponentProps<"thead">) => (
    <TableHeader className={cn("bg-muted/35", className)} {...props} />
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
    <TableCell
      className={cn("overflow-visible whitespace-normal px-3 py-2 align-top text-foreground/85", className)}
      {...props}
    />
  ),
};

/**
 * Collects level-2 (`<h2>`) headings in `rehypePlugins` immediately after
 * `rehypeSlug`, reading each rendered DOM `id` directly so TOC anchors match
 * rendered headings by construction without a second markdown or slugger pass.
 */
function rehypeCollectH2Headings(headings: DocTocHeading[]) {
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

function renderDoc(doc: (typeof PUBLIC_DOC_BY_SLUG extends ReadonlyMap<string, infer T> ? T : never), slug: string) {
  const source = preparePublicDocMarkdown(fs.readFileSync(path.join(DOCS_DIR, doc.source), "utf-8"), {
    stripTitle: true,
    stripAgentNavigation: true,
  });
  const meta = (docsMetadata as Record<string, { dateModified: string; dateCreated: string }>)[slug];
  const updatedDate = meta?.dateModified?.slice(0, 10) ?? null;
  const readingMinutes = estimateReadingMinutes(source);
  const headings: DocTocHeading[] = [];
  const renderedMarkdown = ReactMarkdown({
    children: source,
    components: mdxComponents,
    remarkPlugins: [remarkGfm],
    rehypePlugins: [
      rehypeSlug,
      rehypeCollectH2Headings(headings),
      [rehypeAutolinkHeadings, { behavior: "wrap", properties: { className: ["docs-heading-anchor"] } }],
    ],
  });
  const hasToc = headings.length >= 2;
  const docIndex = PUBLIC_DOCS.findIndex((candidate) => candidate.slug === slug);
  const prevDoc = docIndex > 0 ? PUBLIC_DOCS[docIndex - 1] : null;
  const nextDoc = docIndex >= 0 && docIndex < PUBLIC_DOCS.length - 1 ? PUBLIC_DOCS[docIndex + 1] : null;
  const markdownHref = `/docs/${slug}/index.md`;
  const githubHref = `${GITHUB_DOCS_BLOB_BASE}/${doc.source}`;

  const mainColumn = (
    <div className="min-w-0 max-w-3xl">
      <article className="min-w-0 max-w-3xl space-y-5 text-sm leading-7 text-foreground/85 [&_p]:max-w-[68ch] [&_p]:leading-7 [&_ul]:max-w-[68ch] [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5 [&_ol]:max-w-[68ch] [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-5 [&_li_ul]:mt-2 [&_li_ol]:mt-2 [&_strong]:font-semibold [&_strong]:text-foreground [&_hr]:my-8 [&_hr]:border-border/60 [&_blockquote]:max-w-[68ch] [&_blockquote]:rounded-r-lg [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:bg-muted/20 [&_blockquote]:py-2.5 [&_blockquote]:pl-4 [&_blockquote]:pr-4 [&_blockquote]:text-foreground/85">
        {renderedMarkdown}
      </article>

      <nav aria-label="Adjacent documentation" className="mt-12 space-y-5 border-t border-border/60 pt-6">
        <div className="grid gap-4 sm:grid-cols-2">
          {prevDoc ? (
            <Link
              href={`/docs/${prevDoc.slug}/`}
              className="pharos-focus-ring group flex flex-col gap-1 rounded-lg border border-border/60 bg-background/45 px-4 py-3 transition-colors hover:border-foreground/20 hover:bg-muted/35"
            >
              <span className="pharos-label inline-flex items-center gap-1">
                <ArrowLeft aria-hidden="true" className="h-3 w-3 shrink-0" />
                Previous
              </span>
              <span className="text-sm font-semibold text-foreground transition-colors group-hover:text-brand-accent-text">
                {prevDoc.title}
              </span>
              <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{prevDoc.summary}</span>
            </Link>
          ) : (
            <div className="hidden sm:block" aria-hidden="true" />
          )}
          {nextDoc ? (
            <Link
              href={`/docs/${nextDoc.slug}/`}
              className="pharos-focus-ring group flex flex-col gap-1 rounded-lg border border-border/60 bg-background/45 px-4 py-3 transition-colors hover:border-foreground/20 hover:bg-muted/35 sm:text-right"
            >
              <span className="pharos-label inline-flex items-center gap-1 sm:justify-end">
                Next
                <ArrowRight aria-hidden="true" className="h-3 w-3 shrink-0" />
              </span>
              <span className="text-sm font-semibold text-foreground transition-colors group-hover:text-brand-accent-text">
                {nextDoc.title}
              </span>
              <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{nextDoc.summary}</span>
            </Link>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/50 pt-4 text-xs text-muted-foreground">
          <Link href="/docs/" className="pharos-prose-link text-foreground">
            All documentation
          </Link>
          <span aria-hidden="true">&middot;</span>
          <Link href="/methodology/" className="pharos-prose-link">
            Methodology manual
          </Link>
          {doc.relatedRoute ? (
            <>
              <span aria-hidden="true">&middot;</span>
              <Link href={doc.relatedRoute.href} className="pharos-prose-link">
                Open {doc.relatedRoute.label} &rarr;
              </Link>
            </>
          ) : null}
        </div>
      </nav>
    </div>
  );

  return (
    <FeaturePageShell
      breadcrumbName={doc.title}
      path={`/docs/${slug}/`}
      backLink={{ href: "/docs/", label: "All docs" }}
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
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-t border-border/50 pt-3 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {updatedDate ? (
              <span>
                Updated{" "}
                <time dateTime={meta.dateModified} className="pharos-numeric text-foreground">
                  {updatedDate}
                </time>
              </span>
            ) : null}
            {updatedDate ? <span aria-hidden="true">&middot;</span> : null}
            <span className="pharos-numeric">~{readingMinutes} min read</span>
            <span aria-hidden="true">&middot;</span>
            <Link
              href="/methodology/"
              className="pharos-focus-ring rounded-sm underline underline-offset-4 transition-colors hover:text-foreground"
            >
              Methodology manual &rarr;
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {doc.relatedRoute ? (
              <Link
                href={doc.relatedRoute.href}
                className="pharos-focus-ring inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-foreground/20 hover:bg-muted/40"
              >
                <span>Open {doc.relatedRoute.label}</span>
                <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </Link>
            ) : null}
            <CopyMarkdownButton markdownHref={markdownHref} />
            <a
              href={markdownHref}
              className="pharos-focus-ring inline-flex items-center rounded-md border border-border/60 bg-background/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-muted/40 hover:text-foreground"
            >
              Plain Markdown
            </a>
            <a
              href={githubHref}
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-focus-ring inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-muted/40 hover:text-foreground"
            >
              <span>GitHub</span>
              <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" />
            </a>
          </div>
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
      {hasToc ? <DocsToc headings={headings}>{mainColumn}</DocsToc> : mainColumn}
    </FeaturePageShell>
  );
}

const route = createStaticSlugRoute({
  paramKey: "slug",
  pages: Array.from(PUBLIC_DOC_BY_SLUG.values()),
  pageBySlug: PUBLIC_DOC_BY_SLUG,
  metadata: (doc, slug) =>
    buildPageMetadata({
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
