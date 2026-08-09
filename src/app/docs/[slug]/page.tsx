/* eslint-disable security/detect-non-literal-fs-filename -- source paths come from PUBLIC_DOCS and are guarded by public-docs tests. */

import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import type React from "react";
import { notFound } from "next/navigation";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import ReactMarkdown from "react-markdown";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { markdownLinkComponent } from "@/components/markdown-link";
import { TableBody, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { buildArticleJsonLd, safeJsonLd } from "@/lib/json-ld";
import { cn } from "@/lib/utils";
import { buildPageMetadata } from "@/lib/page-metadata";
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

function buildDocMetadataTitle(doc: { slug: string; title: string; group: string }): string {
  if (doc.slug === "api-reference") return "Stablecoin API Reference - Pharos Docs";
  if (doc.group === "methodology") return `${doc.title} Methodology - Pharos Docs`;
  if (doc.group === "design") return `${doc.title} System - Pharos Docs`;
  return `${doc.title} Guide - Pharos Docs`;
}

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

export function generateStaticParams() {
  return Array.from(PUBLIC_DOC_BY_SLUG.keys()).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const doc = PUBLIC_DOC_BY_SLUG.get(slug);
  if (!doc) return { title: "Doc Not Found" };

  return buildPageMetadata({
    title: buildDocMetadataTitle(doc),
    description: doc.summary,
    canonical: `/docs/${slug}/`,
  });
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = PUBLIC_DOC_BY_SLUG.get(slug);
  if (!doc) notFound();

  const source = preparePublicDocMarkdown(fs.readFileSync(path.join(DOCS_DIR, doc.source), "utf-8"), {
    source: doc.source,
    stripTitle: true,
  });
  const meta = (docsMetadata as Record<string, { dateModified: string; dateCreated: string }>)[slug];

  return (
    <FeaturePageShell
      breadcrumbName={doc.title}
      path={`/docs/${slug}/`}
      title={doc.title}
      variant="longform"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Docs", url: "/docs/" },
        { name: doc.title, url: `/docs/${slug}/` },
      ]}
      leadParagraphs={[doc.summary]}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd(
            buildArticleJsonLd({
              type: "TechArticle",
              headline: doc.title,
              description: doc.summary,
              datePublished: meta?.dateCreated,
              dateModified: meta?.dateModified,
              image: `${SITE_URL}/og-card.png`,
              mainEntityOfPage: `${SITE_URL}/docs/${slug}/`,
            }),
          ),
        }}
      />
      <article className="space-y-5 text-sm leading-7 text-muted-foreground [&_h2]:pt-4 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-foreground [&_h3]:pt-3 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-foreground [&_h4]:text-base [&_h4]:font-semibold [&_h4]:text-foreground [&_p]:leading-7 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-foreground/80 [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-foreground [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/60 [&_pre]:bg-muted/35 [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0">
        <ReactMarkdown
          components={mdxComponents}
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug, [rehypeAutolinkHeadings, { behavior: "wrap" }]]}
        >
          {source}
        </ReactMarkdown>
      </article>
    </FeaturePageShell>
  );
}
