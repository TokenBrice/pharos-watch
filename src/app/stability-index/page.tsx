import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { StabilityIndexClient } from "./client";

const description = "Historical Pharos Stability Index scores, component breakdowns, and condition band analysis for the stablecoin market.";

export const metadata: Metadata = {
  title: "Stability Index — Pharos Stablecoin Market Health",
  description,
  alternates: { canonical: "/stability-index/" },
  openGraph: {
    title: "Stability Index — Pharos Stablecoin Market Health",
    description,
    url: "/stability-index/",
  },
};

export default function StabilityIndexPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Stability Index" path="/stability-index/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Stability Index</span>
        </nav>
        <h1 className="text-3xl font-bold tracking-tight">Pharos Stability Index</h1>
        <p className="text-sm text-muted-foreground">
          Historical stablecoin market health scores, component breakdowns, and condition band analysis.
        </p>
      </div>
      <Suspense>
        <StabilityIndexClient />
      </Suspense>
    </div>
  );
}
