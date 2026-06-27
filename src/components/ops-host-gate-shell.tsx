"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { FeaturePageShell, type FeaturePageShellProps } from "@/components/feature-page-shell";
import { useOpsUiHost } from "@/hooks/use-ops-ui-host";

type OpsHostGateShellProps = Omit<FeaturePageShellProps, "children" | "leadParagraphs"> & {
  children: ReactNode;
  leadParagraphs: readonly ReactNode[];
  loadingLabel: string;
  publicLeadParagraph: ReactNode;
  publicTitle: ReactNode;
  publicDescription: ReactNode;
};

export function OpsHostGateShell({
  children,
  leadParagraphs,
  loadingLabel,
  publicLeadParagraph,
  publicTitle,
  publicDescription,
  ...shellProps
}: OpsHostGateShellProps) {
  const opsUi = useOpsUiHost();

  let resolvedLeadParagraphs = leadParagraphs;
  let content: ReactNode;

  if (opsUi == null) {
    content = <div className="py-20 text-center text-muted-foreground">{loadingLabel}</div>;
  } else if (!opsUi) {
    resolvedLeadParagraphs = [publicLeadParagraph];
    content = (
      <div className="pt-4">
        <div className="pharos-card-shell p-6">
          <div className="space-y-3">
            <p className="pharos-kicker">Private Surface</p>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">{publicTitle}</h2>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{publicDescription}</p>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href="/"
              className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background/60 px-4 py-2 text-sm font-medium text-foreground hover:border-primary/45 hover:bg-primary/8"
            >
              Return to dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  } else {
    content = children;
  }

  return (
    <FeaturePageShell {...shellProps} leadParagraphs={resolvedLeadParagraphs}>
      {content}
    </FeaturePageShell>
  );
}
