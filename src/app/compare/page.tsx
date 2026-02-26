import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { CompareClient } from "./client";

const compareDescription = `Side-by-side comparison of stablecoin stats, supply history, and peg stability for ${TRACKED_STABLECOINS.length} tracked stablecoins.`;

export const metadata: Metadata = {
  title: "Compare Stablecoins — Side-by-Side Analysis",
  description: compareDescription,
  alternates: {
    canonical: "/compare/",
  },
  openGraph: {
    title: "Compare Stablecoins — Side-by-Side Analysis",
    description: compareDescription,
    url: "/compare/",
  },
};

export default function ComparePage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Compare" path="/compare/" />
      <div className="space-y-2">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          <Link
            href="/"
            className="hover:text-foreground transition-colors"
          >
            Dashboard
          </Link>
          <span>/</span>
          <span className="text-foreground">Compare</span>
        </nav>
        <h1 className="text-4xl font-bold tracking-tight">
          Compare Stablecoins
        </h1>
        <p className="text-sm text-muted-foreground">
          Select up to 5 stablecoins to compare side-by-side.
        </p>
      </div>
      <Suspense
        fallback={
          <div className="flex min-h-[40vh] items-center justify-center">
            <div className="h-10 w-10 rounded-full bg-frost-blue/30 animate-pharos-pulse" />
          </div>
        }
      >
        <CompareClient />
      </Suspense>
    </div>
  );
}
