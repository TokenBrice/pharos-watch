import type { Metadata } from "next";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = buildPageMetadata({
  title: "Pharos Lighthouse",
  description:
    "A cinematic night watch inside the Pharos lens room, projecting chain harbors, PSI, and aggregate stress signals back into exact dashboard data.",
  canonical: "/lighthouse/",
});

export default createClientFeaturePage({
  loadClient: () => import("./client").then((mod) => ({ default: mod.LighthouseClient })),
  loading: (
    <div className="space-y-6">
      <div className="h-[30rem] w-full animate-pulse rounded-[1.25rem] border border-border/60 bg-muted/20" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="h-28 animate-pulse rounded-xl border border-border/60 bg-muted/20" />
        ))}
      </div>
    </div>
  ),
  shell: {
    breadcrumbName: "Lighthouse",
    path: "/lighthouse/",
    title: "Pharos Lighthouse",
    statusBadge: { status: "experimental" },
    leadParagraphs: [
      "The beam is an inspection signal, not a new score. The lens projects the largest chain harbors onto the horizon while the readout and signal reel keep the scene auditable on every viewport.",
    ],
  },
});
