import type { Metadata } from "next";
import dynamic from "next/dynamic";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { buildPageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = buildPageMetadata({
  title: "Pharos Lighthouse",
  description:
    "A cinematic night watch inside the Pharos lens room, projecting chain harbors, PSI, and aggregate stress signals back into exact dashboard data.",
  canonical: "/lighthouse/",
});

const LighthouseClient = dynamic(
  () => import("./client").then((mod) => ({ default: mod.LighthouseClient })),
  {
    loading: () => (
      <div
        className="min-h-[min(47rem,calc(100svh-7rem))] animate-pulse border border-border/50 bg-muted/20"
        aria-busy="true"
      />
    ),
  },
);

export default function LighthousePage() {
  return (
    <div className="mx-auto w-full max-w-[94rem]">
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "Lighthouse", url: "/lighthouse/" },
        ]}
      />
      <h1 id="lighthouse-heading" className="sr-only">
        Pharos Lighthouse
      </h1>
      <SectionErrorBoundary name="Pharos Lighthouse" supportingText="Refresh the page to retry the lighthouse view.">
        <LighthouseClient />
      </SectionErrorBoundary>
    </div>
  );
}
