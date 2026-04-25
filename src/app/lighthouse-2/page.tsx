import type { Metadata } from "next";
import dynamic from "next/dynamic";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { buildPageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = buildPageMetadata({
  title: "Pharos Lighthouse 2",
  description:
    "A low-motion fantasy naval expedition chart for Pharos chain harbors, PSI, DEWS, and non-USD peg cohorts.",
  canonical: "/lighthouse-2/",
});

const Lighthouse2Client = dynamic(
  () => import("./client").then((mod) => ({ default: mod.Lighthouse2Client })),
  {
    loading: () => (
      <div className="min-h-[calc(100svh-1.5rem)] animate-pulse border border-border/50 bg-muted/20" aria-busy="true" />
    ),
  },
);

export default function Lighthouse2Page() {
  return (
    <div className="relative left-1/2 w-[100vw] -translate-x-1/2 md:w-[calc(100vw-var(--sidebar-width-expanded))]">
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "Lighthouse 2", url: "/lighthouse-2/" },
        ]}
      />
      <h1 id="lighthouse-2-heading" className="sr-only">
        Pharos Lighthouse 2
      </h1>
      <SectionErrorBoundary name="Pharos Lighthouse 2" supportingText="Refresh the page to retry the expedition chart.">
        <Lighthouse2Client />
      </SectionErrorBoundary>
    </div>
  );
}
