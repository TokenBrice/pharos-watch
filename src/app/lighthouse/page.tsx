import type { Metadata } from "next";
import dynamic from "next/dynamic";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { buildPageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = buildPageMetadata({
  title: "Pharos Lighthouse",
  description:
    "An isometric pixel-art harbor: Pharos as the lighthouse, blockchains as harbours, stablecoins as boats. PSI is the beam. DEWS is the sea.",
  canonical: "/lighthouse/",
});

const LighthouseClient = dynamic(
  () => import("./client").then((mod) => ({ default: mod.LighthouseClient })),
  {
    loading: () => (
      <div className="min-h-[calc(100svh-1.5rem)] animate-pulse border border-border/50 bg-muted/20" aria-busy="true" />
    ),
  },
);

export default function LighthousePage() {
  return (
    <div className="relative left-1/2 w-[100vw] -translate-x-1/2 md:w-[calc(100vw-var(--sidebar-width-expanded))]">
      <BreadcrumbJsonLd items={[{ name: "Home", url: "/" }, { name: "Lighthouse", url: "/lighthouse/" }]} />
      <h1 id="lighthouse-heading" className="sr-only">Pharos Lighthouse</h1>
      <SectionErrorBoundary name="Pharos Lighthouse" supportingText="Refresh the page to retry the lighthouse view.">
        <LighthouseClient />
      </SectionErrorBoundary>
    </div>
  );
}
