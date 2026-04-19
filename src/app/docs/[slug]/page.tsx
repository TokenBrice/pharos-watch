/* eslint-disable security/detect-non-literal-fs-filename -- source paths come from PUBLIC_DOCS and are guarded by public-docs tests. */

import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import type React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import ReactMarkdown from "react-markdown";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import {
  PUBLIC_DOC_BY_SLUG,
  preparePublicDocMarkdown,
  resolvePublicDocHref,
} from "@shared/lib/public-docs";
import docsMetadata from "@/generated/docs-metadata.json";

const DOCS_DIR = path.join(process.cwd(), "docs");

const mdxComponents = {
  a: ({ href, children }: React.ComponentProps<"a">) => {
    const resolved = resolvePublicDocHref(href);
    if (!resolved) return <span>{children}</span>;
    if (resolved.startsWith("/")) {
      return (
        <Link href={resolved} className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground">
          {children}
        </Link>
      );
    }
    return (
      <a href={resolved} className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground">
        {children}
      </a>
    );
  },
};

export function generateStaticParams() {
  return Array.from(PUBLIC_DOC_BY_SLUG.keys()).map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = PUBLIC_DOC_BY_SLUG.get(slug);
  if (!doc) return { title: "Doc Not Found" };

  return buildPageMetadata({
    title: `${doc.title} - Pharos Docs`,
    description: doc.summary,
    canonical: `/docs/${slug}/`,
  });
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const doc = PUBLIC_DOC_BY_SLUG.get(slug);
  if (!doc) notFound();

  const source = preparePublicDocMarkdown(
    fs.readFileSync(path.join(DOCS_DIR, doc.source), "utf-8"),
    { source: doc.source, stripTitle: true },
  );
  const meta = (docsMetadata as Record<string, { dateModified: string; dateCreated: string }>)[slug];

  return (
    <FeaturePageShell
      breadcrumbName={doc.title}
      path={`/docs/${slug}/`}
      title={doc.title}
      variant="longform"
      containerClassName="mx-auto max-w-3xl"
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
          __html: safeJsonLd({
            "@context": "https://schema.org",
            "@type": "TechArticle",
            headline: doc.title,
            description: doc.summary,
            datePublished: meta?.dateCreated,
            dateModified: meta?.dateModified,
            author: { "@id": `${SITE_URL}#organization` },
            publisher: { "@id": `${SITE_URL}#organization` },
            image: `${SITE_URL}/og-card.png`,
            mainEntityOfPage: `${SITE_URL}/docs/${slug}/`,
          }),
        }}
      />
      <article className="space-y-5 text-sm leading-7 text-muted-foreground [&_h2]:pt-4 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-foreground [&_h3]:pt-3 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-foreground [&_h4]:text-base [&_h4]:font-semibold [&_h4]:text-foreground [&_p]:leading-7 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-foreground/80 [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-foreground [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/60 [&_pre]:bg-muted/35 [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-border/60 [&_th]:p-2 [&_th]:text-left [&_td]:border [&_td]:border-border/60 [&_td]:p-2">
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
