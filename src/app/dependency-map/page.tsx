import dynamic from "next/dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Skeleton } from "@/components/ui/skeleton";
import { FeatureStatusBadge } from "@/components/feature-status-badge";

const DependencyMapClient = dynamic(
  () => import("./client").then((m) => ({ default: m.DependencyMapClient })),
  { loading: () => <Skeleton className="h-[600px] w-full rounded-lg" /> },
);

const description =
  "Interactive graph of collateral dependencies between up to 50 dependency-linked stablecoins by market cap. Node size reflects market cap; lines show collateral links.";

export const metadata: Metadata = {
  title: "Dependency Map: Stablecoin Collateral Graph",
  description,
  alternates: { canonical: "/dependency-map/" },
  openGraph: {
    title: "Dependency Map: Stablecoin Collateral Graph",
    description,
    url: "/dependency-map/",
    images: [{ url: "https://pharos.watch/og-dependency-map.png", width: 1200, height: 628 }],
  },
  twitter: {
    images: [{ url: "https://pharos.watch/og-dependency-map.png", width: 1200, height: 628 }],
  },
};

export default function DependencyMapPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Dependency Map" path="/dependency-map/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Dependency Map</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">Dependency Map <FeatureStatusBadge status="experimental" /></h1>
        <p className="text-sm text-muted-foreground">
          Collateral dependencies between up to 50 dependency-linked stablecoins by market cap. Node size reflects market cap;
          lines show how one stablecoin relies on another as collateral. Drag nodes to explore.
        </p>
      </div>
      <DependencyMapClient />
    </div>
  );
}
