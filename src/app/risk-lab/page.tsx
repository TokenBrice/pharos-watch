import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { ReportCardsClient } from "./client";

const reportCardsDescription =
  "Transparent stablecoin safety grades, portfolio risk analysis, and contagion simulation in one place. Six dimensions combined into a single letter grade — plus simulate what happens when a major stablecoin fails.";

export const metadata: Metadata = {
  title: "Risk Lab — Stablecoin Safety Grades & Contagion Simulation",
  description: reportCardsDescription,
  alternates: {
    canonical: "/risk-lab/",
  },
  openGraph: {
    title: "Risk Lab — Stablecoin Safety Grades & Contagion Simulation",
    description: reportCardsDescription,
    url: "/risk-lab/",
  },
};

export default function ReportCardsPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Risk Lab" path="/risk-lab/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Risk Lab</span>
        </nav>
        <h1 className="text-3xl font-bold tracking-tight">Risk Lab</h1>
        <p className="text-sm text-muted-foreground">
          Safety grades, portfolio risk analysis, and contagion simulation for every tracked stablecoin.
        </p>
      </div>
      <Suspense>
        <ReportCardsClient />
      </Suspense>
    </div>
  );
}
