import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { ReportCardsClient } from "./client";

const reportCardsDescription =
  "Transparent, data-driven grades for every tracked stablecoin. Six dimensions — peg stability, liquidity, safety, resilience, decentralization, and dependency risk — combined into a single letter grade.";

export const metadata: Metadata = {
  title: "Report Cards — Stablecoin Safety Grades",
  description: reportCardsDescription,
  alternates: {
    canonical: "/report-cards/",
  },
  openGraph: {
    title: "Report Cards — Stablecoin Safety Grades",
    description: reportCardsDescription,
    url: "/report-cards/",
  },
};

export default function ReportCardsPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Report Cards" path="/report-cards/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Report Cards</span>
        </nav>
        <h1 className="text-3xl font-bold tracking-tight">Report Cards</h1>
        <p className="text-sm text-muted-foreground">
          Transparent, data-driven safety grades for every tracked stablecoin.
          Six dimensions combined into a single letter grade.
        </p>
      </div>
      <Suspense>
        <ReportCardsClient />
      </Suspense>
    </div>
  );
}
