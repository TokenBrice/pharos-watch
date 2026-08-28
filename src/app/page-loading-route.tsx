import type { ReactNode } from "react";
import { PageLoadingHeader, PageLoadingShell } from "@/components/page-loading-skeleton";

interface PageLoadingRouteProps {
  children: ReactNode;
  sectionWidth?: string;
  titleWidth?: string;
  eyebrowWidth?: string;
  includeEyebrow?: boolean;
}

export function PageLoadingRoute({
  children,
  sectionWidth,
  titleWidth,
  eyebrowWidth,
  includeEyebrow,
}: PageLoadingRouteProps) {
  return (
    <PageLoadingShell>
      <PageLoadingHeader
        sectionWidth={sectionWidth}
        titleWidth={titleWidth}
        eyebrowWidth={eyebrowWidth}
        includeEyebrow={includeEyebrow}
      />
      {children}
    </PageLoadingShell>
  );
}
