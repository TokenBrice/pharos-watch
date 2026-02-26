import dynamic from "next/dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Skeleton } from "@/components/ui/skeleton";

const DependencyMapClient = dynamic(
  () => import("./client").then((m) => ({ default: m.DependencyMapClient })),
  { loading: () => <Skeleton className="h-[520px] w-full rounded-lg" /> },
);

const description =
  "Interactive graph of collateral dependencies between the top 50 stablecoins by market cap. Node size reflects market cap; lines show collateral links.";

export const metadata: Metadata = {
  title: "Dependency Map — Stablecoin Collateral Graph",
  description,
  alternates: { canonical: "/dependency-map/" },
  openGraph: {
    title: "Dependency Map — Stablecoin Collateral Graph",
    description,
    url: "/dependency-map/",
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
        <h1 className="text-4xl font-extrabold tracking-tighter">Dependency Map</h1>
        <p className="text-sm text-muted-foreground">
          Collateral dependencies between the top 50 stablecoins by market cap. Node size reflects market cap;
          lines show how one stablecoin relies on another as collateral. Drag nodes to explore. Click to view details.
        </p>
      </div>
      <DependencyMapClient />
    </div>
  );
}
