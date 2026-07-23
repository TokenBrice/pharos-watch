import { AlertTriangle } from "lucide-react";
import { CalloutBanner } from "@/components/callout-banner";
import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";

const PREVIEW_PATH = "/v9-preview/";

export const metadata = buildPageMetadata({
  title: "Safety Score V9 Shadow Preview",
  description: "Unlisted review surface for the Safety Score V9 shadow candidate.",
  canonical: PREVIEW_PATH,
  robots: { index: false, follow: false },
});

export default createClientFeaturePage({
  loadClient: () => import("./client").then((module) => ({ default: module.SafetyScoreV9PreviewClient })),
  loading: <Skeleton className="h-[32rem] w-full rounded-md" />,
  shell: {
    breadcrumbName: "V9 Shadow Preview",
    path: PREVIEW_PATH,
    title: "Safety Score V9 Shadow Preview",
    leadParagraphs: [
      "Read-only candidate ratings for external review. Safety Score v8 remains the live Pharos rating.",
    ],
  },
  beforeClient: (
    <CalloutBanner
      icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
      className="w-full border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300"
    >
      Shadow data can change without notice and must not be treated as a released rating or financial advice.
    </CalloutBanner>
  ),
});
