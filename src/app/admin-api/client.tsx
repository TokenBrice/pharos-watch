"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ApiKeysPanel } from "@/components/status/api-keys-panel";
import { ApiKeyRequestsPanel } from "@/components/status/api-key-requests-panel";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { useOpsUiHost } from "@/hooks/use-ops-ui-host";

const ADMIN_API_SHELL_PROPS = {
  breadcrumbName: "API Management",
  path: "/admin-api/",
  title: "API Management",
  variant: "auth-gated" as const,
};

export default function AdminApiClient() {
  const opsUi = useOpsUiHost();

  let leadParagraphs = [
    "Access-protected control surface for API key lifecycle work and self-serve request review.",
  ];
  let content: ReactNode;

  if (opsUi == null) {
    content = <div className="py-20 text-center text-muted-foreground">Loading API management access...</div>;
  } else if (!opsUi) {
    leadParagraphs = ["This route exists, but API management only runs on the Access-protected ops host."];
    content = (
      <div className="pt-4">
        <div className="rounded-[1.6rem] border border-border/60 bg-background/35 p-6 shadow-[0_18px_48px_oklch(0_0_0_/0.16)]">
          <div className="space-y-3">
            <p className="pharos-kicker">Private Surface</p>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              API management is not available on the public host.
            </h2>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              API keys and requester details are managed behind the Access-protected ops host.
            </p>
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
    content = (
      <div className="space-y-5">
        <ApiKeyRequestsPanel />
        <ApiKeysPanel />
      </div>
    );
  }

  return (
    <FeaturePageShell {...ADMIN_API_SHELL_PROPS} leadParagraphs={leadParagraphs}>
      {content}
    </FeaturePageShell>
  );
}
