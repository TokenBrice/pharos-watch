import dynamic from "next/dynamic";
import { FeaturePageShell, type FeaturePageShellProps } from "@/components/feature-page-shell";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { buildPageMetadata } from "@/lib/page-metadata";

interface ClientFeatureRouteDefinition<ClientProps extends object = Record<string, never>> {
  path: string;
  metadata: Omit<Parameters<typeof buildPageMetadata>[0], "canonical">;
  // `never` props accept every client component shape; the render below is
  // typed with the route's declared client props.
  loadClient: () => Promise<{ default: React.ComponentType<never> }>;
  /** Serializable props passed from the server page into the client island. */
  clientProps?: ClientProps;
  loading: React.ReactNode;
  shell: Omit<FeaturePageShellProps, "children" | "path">;
  beforeClient?: React.ReactNode;
  afterClient?: React.ReactNode;
}

export function createClientFeaturePage<ClientProps extends object = Record<string, never>>({
  path,
  metadata: metadataDefinition,
  loadClient,
  clientProps,
  loading,
  shell,
  beforeClient,
  afterClient,
}: ClientFeatureRouteDefinition<ClientProps>) {
  const ClientComponent = dynamic(loadClient, {
    loading: () => loading,
  }) as React.ComponentType<ClientProps>;
  const metadata = buildPageMetadata({ ...metadataDefinition, canonical: path });

  function Page() {
    return (
      <FeaturePageShell {...shell} path={path}>
        {beforeClient}
        <SectionErrorBoundary name={shell.title} supportingText="This section failed to load. Try refreshing the page.">
          <ClientComponent {...(clientProps as ClientProps)} />
        </SectionErrorBoundary>
        {afterClient}
      </FeaturePageShell>
    );
  }

  Page.displayName = `${shell.title.replace(/\s+/g, "")}Page`;
  return { metadata, Page };
}
