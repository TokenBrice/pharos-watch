import Link from "next/link";
import { FaqSection } from "@/components/faq-section";
import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import content from "./content.json";
import { buildLiveRouteOgImageUrl } from "@/lib/page-metadata";


const DEPENDENCY_MAP_STATIC_SECTION = (
  <section className="pharos-card-shell px-4 py-4">
    <p className="pharos-label">{content.lens.kicker}</p>
    <div className="mt-3 grid gap-3 text-sm leading-relaxed text-muted-foreground lg:grid-cols-3">
      <p>
        {content.lens.graph}
      </p>
      <p>
        {content.lens.start}{" "}
        <Link
          href={content.lens.scores.href}
          className="pharos-prose-link"
        >
          {content.lens.scores.label}
        </Link>{" "}
        {content.lens.between}{" "}
        <Link
          href={content.lens.coverage.href}
          className="pharos-prose-link"
        >
          {content.lens.coverage.label}
        </Link>{" "}
        {content.lens.end}
      </p>
      <p>
        {content.lens.scope}
      </p>
    </div>
  </section>
);

const route = createClientFeaturePage({
  path: "/dependency-map/",
  metadata: {
    title: content.metadataTitle,
    description: content.description,
    ogImage: buildLiveRouteOgImageUrl("dependency-map"),
  },
  loadClient: () => import("./client").then((m) => ({ default: m.DependencyMapClient })),
  loading: <Skeleton className="h-[600px] w-full rounded-lg" />,
  shell: {
    breadcrumbName: content.title,
    title: content.title,
    leadParagraphs: [content.lead],
    headerSupplement: (
      <p className="pharos-lead hidden lg:block">
        {content.headerSupplement}
      </p>
    ),
  },
  afterClient: (
    <>
      {DEPENDENCY_MAP_STATIC_SECTION}
      <FaqSection items={content.faq} includeJsonLd />
    </>
  ),
});

export const metadata = route.metadata;
export default route.Page;
