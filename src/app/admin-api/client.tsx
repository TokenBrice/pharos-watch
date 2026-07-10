"use client";

import { OpsShell } from "@/components/ops-shell";
import { ApiKeysPanel } from "@/components/status/api-keys-panel";
import { ApiKeyRequestsPanel } from "@/components/status/api-key-requests-panel";

export default function AdminApiClient() {
  return (
    <OpsShell>
      <section aria-labelledby="api-management-title" className="min-w-0 max-w-full space-y-5">
        <div className="space-y-1">
          <h2 id="api-management-title" className="text-xl font-semibold text-foreground">
            API Management
          </h2>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            API key lifecycle controls and self-serve request review. Credential material remains isolated from the
            operational status workspaces.
          </p>
        </div>
        <ApiKeyRequestsPanel />
        <ApiKeysPanel />
      </section>
    </OpsShell>
  );
}
