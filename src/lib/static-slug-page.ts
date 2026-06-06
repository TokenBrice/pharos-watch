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

interface StaticSlugRouteConfig<TParamKey extends string, TPage extends SlugPageMetadata> {
  paramKey: TParamKey;
  pages: ReadonlyArray<{ slug: string }>;
  pageBySlug: ReadonlyMap<string, TPage>;
  missingTitle: string;
  ogImage?: string;
  render: (page: TPage) => ReactNode;
}

export function createStaticSlugRoute<TParamKey extends string, TPage extends SlugPageMetadata>({
  paramKey,
  pages,
  pageBySlug,
  missingTitle,
  ogImage,
  render,
}: StaticSlugRouteConfig<TParamKey, TPage>) {
  return {
    generateStaticParams() {
      return buildSlugStaticParams(paramKey, pages);
    },
    generateMetadata({ params }: { params: Promise<Record<TParamKey, string>> }) {
      return buildSlugPageMetadata(params, paramKey, pageBySlug, missingTitle, ogImage);
    },
    async Page({ params }: { params: Promise<Record<TParamKey, string>> }) {
      const page = await resolveSlugPage(params, paramKey, pageBySlug);
      if (!page) notFound();

      return render(page);
    },
  };
}
