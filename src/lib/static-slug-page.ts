import { buildPageMetadata } from "@/lib/page-metadata";

interface SlugPageMetadata {
  slug: string;
  title: string;
  description: string;
  href: string;
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
  });
}
