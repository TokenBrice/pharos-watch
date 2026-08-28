import dynamic from "next/dynamic";
import { FeaturePageShell, type FeaturePageShellProps } from "@/components/feature-page-shell";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { buildPageMetadata } from "@/lib/page-metadata";

interface ClientFeatureRouteDefinition {
  path: string;
  metadata: Omit<Parameters<typeof buildPageMetadata>[0], "canonical">;
  loadClient: () => Promise<{ default: React.ComponentType }>;
  loading: React.ReactNode;
  shell: Omit<FeaturePageShellProps, "children" | "path">;
  beforeClient?: React.ReactNode;
  afterClient?: React.ReactNode;
}

export function createClientFeaturePage({
  path,
  metadata: metadataDefinition,
  loadClient,
  loading,
  shell,
  beforeClient,
  afterClient,
}: ClientFeatureRouteDefinition) {
  const ClientComponent = dynamic(loadClient, {
    loading: () => loading,
  });
  const metadata = buildPageMetadata({ ...metadataDefinition, canonical: path });

  function Page() {
    return (
      <FeaturePageShell {...shell} path={path}>
        {beforeClient}
        <SectionErrorBoundary name={shell.title} supportingText="This section failed to load. Try refreshing the page.">
          <ClientComponent />
        </SectionErrorBoundary>
        {afterClient}
      </FeaturePageShell>
    );
  }

  Page.displayName = `${shell.title.replace(/\s+/g, "")}Page`;
  return { metadata, Page };
}
