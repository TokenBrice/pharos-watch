import dynamic from "next/dynamic";
import { FeaturePageShell, type FeaturePageShellProps } from "@/components/feature-page-shell";
import { SectionErrorBoundary } from "@/components/section-error-boundary";

interface ClientFeaturePageOptions {
  loadClient: () => Promise<{ default: React.ComponentType }>;
  loading: React.ReactNode;
  shell: Omit<FeaturePageShellProps, "children">;
  beforeClient?: React.ReactNode;
  afterClient?: React.ReactNode;
}

export function createClientFeaturePage({
  loadClient,
  loading,
  shell,
  beforeClient,
  afterClient,
}: ClientFeaturePageOptions) {
  const ClientComponent = dynamic(loadClient, {
    loading: () => loading,
  });

  function ClientFeaturePage() {
    return (
      <FeaturePageShell {...shell}>
        {beforeClient}
        <SectionErrorBoundary name={shell.title} supportingText="This section failed to load. Try refreshing the page.">
          <ClientComponent />
        </SectionErrorBoundary>
        {afterClient}
      </FeaturePageShell>
    );
  }

  ClientFeaturePage.displayName = `${shell.title.replace(/\s+/g, "")}Page`;
  return ClientFeaturePage;
}
