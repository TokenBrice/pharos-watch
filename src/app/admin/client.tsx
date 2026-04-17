"use client";

import Link from "next/link";
import { type ReactNode, useSyncExternalStore } from "react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { isOpsUiHost } from "@/lib/admin-access";
import { StatusDashboard } from "./status-dashboard";

const ADMIN_SHELL_PROPS = {
  breadcrumbName: "Admin",
  path: "/admin/",
  title: "Operator Admin",
  variant: "auth-gated" as const,
};

export default function StatusClient() {
  const opsUi = useSyncExternalStore(
    () => () => undefined,
    () => isOpsUiHost(),
    () => null,
  );
  const handleOpsSignOut = () => {
    window.location.assign("/cdn-cgi/access/logout");
  };

  let leadParagraphs = [
    "Access-protected operator panel for monitoring pipeline health, endpoint reliability, incident state transitions, and manual recovery flows.",
  ];
  let content: ReactNode;

  if (opsUi == null) {
    content = <div className="py-20 text-center text-muted-foreground">Loading status access...</div>;
  } else if (!opsUi) {
    leadParagraphs = ["This route exists, but the operator control plane only runs on the Access-protected ops host."];
    content = (
        <div className="pt-4">
          <div className="rounded-[1.6rem] border border-border/60 bg-background/35 p-6 shadow-[0_18px_48px_oklch(0_0_0_/0.16)]">
            <div className="space-y-3">
              <p className="pharos-kicker">Private Surface</p>
              <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                Operator tooling is no longer available on the public host.
              </h2>
              <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Manual response tools and deep operator telemetry now run behind the Access-protected ops host.
                The public `/status/` page is read-only.
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
    content = <StatusDashboard onSignOut={handleOpsSignOut} />;
  }

  return (
    <FeaturePageShell {...ADMIN_SHELL_PROPS} leadParagraphs={leadParagraphs}>
      {content}
    </FeaturePageShell>
  );
}
