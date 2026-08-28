import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { buildPageMetadata } from "@/lib/page-metadata";

interface SlugPageMetadata {
  slug: string;
  title: string;
  description: string;
  href: string;
  ogImage?: string;
}

export function buildSlugStaticParams<TParamKey extends string>(
  paramKey: TParamKey,
  pages: ReadonlyArray<{ slug: string }>,
): Array<Record<TParamKey, string>> {
  return pages.map((page) => ({ [paramKey]: page.slug }) as Record<TParamKey, string>);
}

export async function resolveSlugPage<TParamKey extends string, TPage>(
  params: Promise<Record<TParamKey, string>>,
  paramKey: TParamKey,
  pageBySlug: ReadonlyMap<string, TPage>,
): Promise<TPage | null> {
  const routeParams = await params;
  return pageBySlug.get(routeParams[paramKey]) ?? null;
}

export async function buildSlugPageMetadata<TParamKey extends string>(
  params: Promise<Record<TParamKey, string>>,
  paramKey: TParamKey,
  pageBySlug: ReadonlyMap<string, SlugPageMetadata>,
  missingTitle: string,
  ogImage?: string,
) {
  const page = await resolveSlugPage(params, paramKey, pageBySlug);
  if (!page) {
    return {
      title: missingTitle,
      robots: { index: false },
    };
  }

  return buildPageMetadata({
    title: page.title,
    description: page.description,
    canonical: page.href,
    ogImage: page.ogImage ?? ogImage,
  });
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
