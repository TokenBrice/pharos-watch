import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { buildPageMetadata } from "@/lib/page-metadata";

interface SlugPageMetadata {
  title: string;
  description: string;
  href: string;
  ogImage?: string;
}

interface StaticSlugRouteConfig<TParamKey extends string, TPage> {
  paramKey: TParamKey;
  pages: ReadonlyArray<TPage>;
  pageBySlug: ReadonlyMap<string, TPage>;
  getSlug?: (page: TPage) => string;
  metadata?: (page: TPage, slug: string) => Metadata;
  missingMetadata?: Metadata;
  missingTitle?: string;
  ogImage?: string;
  render: (page: TPage, slug: string) => ReactNode;
}

export function createStaticSlugRoute<TParamKey extends string, TPage>({
  paramKey,
  pages,
  pageBySlug,
  getSlug = (page) => (page as { slug: string }).slug,
  metadata,
  missingMetadata,
  missingTitle,
  ogImage,
  render,
}: StaticSlugRouteConfig<TParamKey, TPage>) {
  return {
    generateStaticParams() {
      return pages.map((page) => ({ [paramKey]: getSlug(page) }) as Record<TParamKey, string>);
    },
    async generateMetadata({ params }: { params: Promise<Record<TParamKey, string>> }) {
      const routeParams = await params;
      const slug = routeParams[paramKey];
      const page = pageBySlug.get(slug);
      if (!page) return missingMetadata ?? { title: missingTitle };
      if (metadata) return metadata(page, slug);

      const slugPage = page as unknown as SlugPageMetadata;
      return buildPageMetadata({
        title: slugPage.title,
        description: slugPage.description,
        canonical: slugPage.href,
        ogImage: slugPage.ogImage ?? ogImage,
      });
    },
    async Page({ params }: { params: Promise<Record<TParamKey, string>> }) {
      const routeParams = await params;
      const slug = routeParams[paramKey];
      const page = pageBySlug.get(slug);
      if (!page) notFound();

      return render(page, slug);
    },
  };
}
