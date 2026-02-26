import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Skeleton } from "@/components/ui/skeleton";
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
        <h1 className="text-4xl font-extrabold tracking-tighter">Pharos Stability Index</h1>
        <p className="text-sm text-muted-foreground">
          Historical stablecoin market health scores, component breakdowns, and condition band analysis.
        </p>
        <p className="text-sm text-muted-foreground max-w-2xl">
          The Pharos Stability Index (PSI) is a composite 0–100 score that combines peg deviation severity,
          depeg breadth, and supply-weighted volatility into a single market health reading. Scores fall into
          five condition bands — from Calm (80+) to Crisis (below 20) — so you can gauge stablecoin market
          stress at a glance.
        </p>
      </div>
      <Suspense fallback={<div className="space-y-6"><Skeleton className="h-48 w-full rounded-xl" /><Skeleton className="h-[350px] w-full rounded-xl" /><Skeleton className="h-[350px] w-full rounded-xl" /></div>}>
        <StabilityIndexClient />
      </Suspense>
    </div>
  );
}
